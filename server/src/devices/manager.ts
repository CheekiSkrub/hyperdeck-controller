import { EventEmitter } from 'node:events';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { HyperDeckClient, HyperDeckError, type HyperDeckState } from '../hyperdeck/client.js';
import { HyperDeckRest } from '../hyperdeck/rest.js';
import { deviceAction, readSettings, SettingError, writeSetting } from './settings.js';
import { fpsFromVideoFormat, timecodeToFrames, type TransportInfo } from '../hyperdeck/protocol.js';
import { applyEdit, EditError, editFromState, validateEdit, type DerivedEntry } from './edit.js';
import * as nas from '../hyperdeck/nas.js';
import type { Device, DeviceInput, DeviceStore } from './store.js';

export interface ClipListing {
  slotId: number;
  slotLabel: string;
  isNetwork: boolean;
  index: number;
  file: string;
  fileFormat: string;
  videoFormat: string;
  duration: string;
  fps: number | null;
  frames: number | null;
  /** Timeline clip id when the file is on the current timeline. */
  timelineId: number | null;
}

/** Commands the panel may send through the generic command endpoint. */
const ALLOWED: Record<string, string[]> = {
  play: ['speed', 'loop', 'single clip', 'clip id'],
  stop: [],
  record: ['name'],
  preview: ['enable'],
  goto: ['clip id', 'clip', 'timeline', 'timecode', 'slot id'],
  jog: ['timecode'],
  shuttle: ['speed'],
  'playrange set': ['clip id', 'count', 'in', 'out', 'timeline in', 'timeline out'],
  'playrange clear': [],
  'slot select': ['slot id', 'video format'],
  remote: ['enable', 'override'],
  'clips add': ['name', 'clip id', 'in', 'out'],
  'clips clear': [],
  identify: ['enable'],
  'play option': ['stop mode'],
};

export class CommandError extends Error {
  /** `code` lets the panel react to specific failures (e.g. offer to replace the timeline). */
  constructor(message: string, public readonly status = 400, public readonly code?: string) { super(message); }
}

export class DeviceManager extends EventEmitter {
  private clients = new Map<string, HyperDeckClient>();
  private rests = new Map<string, HyperDeckRest>();

  constructor(private readonly store: DeviceStore) {
    super();
    for (const d of store.list()) this.attach(d);
  }

  list(): (Device & { state: HyperDeckState })[] {
    return this.store.list().map((d) => ({ ...d, state: this.client(d.id).state }));
  }

  get(id: string): Device {
    const d = this.store.get(id);
    if (!d) throw new CommandError('Device not found', 404);
    return d;
  }

  client(id: string): HyperDeckClient {
    const c = this.clients.get(id);
    if (!c) throw new CommandError('Device not found', 404);
    return c;
  }

  create(input: DeviceInput): Device {
    const d = this.store.create(input);
    this.attach(d);
    this.emit('devices');
    return d;
  }

  update(id: string, input: DeviceInput): Device {
    const d = this.store.update(id, input);
    this.client(id).setAddress(d.host, d.port);
    this.rests.get(id)?.setAddress(d.host, d.restPort);
    this.emit('devices');
    this.emit('deviceChanged', id);
    return d;
  }

  remove(id: string): void {
    this.clients.get(id)?.close();
    this.clients.delete(id);
    this.rests.delete(id);
    this.store.remove(id);
    this.emit('devices');
  }

  shutdown(): void {
    for (const c of this.clients.values()) c.close();
  }

  private attach(d: Device) {
    const c = new HyperDeckClient(d.host, d.port);
    c.on('state', (state: HyperDeckState) => this.emit('state', d.id, state));
    c.on('transport', (t: TransportInfo | null) => this.emit('transport', d.id, t));
    this.clients.set(d.id, c);
    this.rests.set(d.id, new HyperDeckRest(d.host, d.restPort));
    c.connect();
  }

  // ---------------------------------------------------------------- deck-side NAS bookmarks

  private restFor(id: string): HyperDeckRest {
    const r = this.rests.get(id);
    if (!r) throw new CommandError('Device not found', 404);
    return r;
  }

  async nasBookmarks(id: string) {
    try { return await nas.listBookmarks(this.restFor(id)); } catch (e) { throw toCommandError(e); }
  }

  async nasDiscover(id: string) {
    try { return await nas.discover(this.restFor(id)); } catch (e) { throw toCommandError(e); }
  }

  async nasSelected(id: string) {
    try { return await nas.getSelected(this.restFor(id)); } catch (e) { throw toCommandError(e); }
  }

  async addNasBookmark(id: string, url: string, username?: string, password?: string) {
    if (!url.trim()) throw new CommandError('Enter the share URL, e.g. smb://nas.local/Recordings', 400);
    try { await nas.addBookmark(this.restFor(id), url.trim(), username, password); } catch (e) { throw toCommandError(e); }
  }

  async setNasBookmarkCredentials(id: string, url: string, username?: string, password?: string) {
    try { await nas.setBookmarkCredentials(this.restFor(id), url, username, password); } catch (e) { throw toCommandError(e); }
  }

  async removeNasBookmark(id: string, url: string) {
    try { await nas.removeBookmark(this.restFor(id), url); } catch (e) { throw toCommandError(e); }
  }

  /** Mount (or, with url null, unmount) a bookmarked share as the deck's active network storage. */
  async selectNas(id: string, url: string | null) {
    try {
      await nas.select(this.restFor(id), url);
      await this.client(id).refreshSlots().catch(() => {});
    } catch (e) {
      throw toCommandError(e);
    }
  }

  // ---------------------------------------------------------------------------

  async command(id: string, name: string, params: Record<string, string | number | boolean> = {}) {
    const allowed = ALLOWED[name];
    if (!allowed) throw new CommandError(`Command "${name}" is not allowed`);
    for (const k of Object.keys(params)) {
      if (!allowed.includes(k)) throw new CommandError(`Parameter "${k}" not allowed for ${name}`);
    }
    const c = this.client(id);
    try {
      const r = await c.send(name, params);
      if (name === 'slot select' || name.startsWith('clips')) await c.refreshTimeline().catch(() => {});
      return { code: r.code, text: r.text };
    } catch (e) {
      throw toCommandError(e);
    }
  }

  /**
   * The clip most likely still being recorded (or most recently recorded) on
   * a device: the last file reported on its active slot. Used for "instant
   * replay" — pulling the last N seconds of what one deck is capturing onto
   * another deck's timeline, the way an EVS-style replay operator would.
   */
  instantReplaySource(id: string): { slotId: number; file: string; frames: number; fps: number; duration: string } | null {
    const s = this.client(id).state;
    const slotId = s.transport?.slotId ?? s.slots[0]?.slotId;
    if (!slotId) return null;
    const files = s.disks[slotId] ?? [];
    const f = files.at(-1);
    if (!f) return null;
    const fps = fpsFromVideoFormat(f.videoFormat) ?? fpsFromVideoFormat(s.transport?.videoFormat ?? '') ?? 25;
    return { slotId, file: f.name, frames: timecodeToFrames(f.duration, fps), fps, duration: f.duration };
  }

  /**
   * Instant replay: take the last `seconds` of whatever `sourceId` is
   * currently capturing (or most recently captured) and put it on `targetId`'s
   * timeline. Only works when `targetId` can see that file itself — normally
   * because both decks are pointed at the same network share, the way a
   * dedicated replay channel watches the same storage the record channels
   * write to. `validateEdit`/`setEdit` will report a clear error otherwise.
   */
  async instantReplay(sourceId: string, opts: { seconds: number; targetId: string; mode: 'append' | 'replace' }) {
    const src = this.instantReplaySource(sourceId);
    if (!src) throw new CommandError('No recorded clip found on that HyperDeck', 404);
    if (!(opts.seconds > 0)) throw new CommandError('Enter how many seconds back to take', 400);
    const out = src.frames;
    const inF = Math.max(0, out - Math.round(opts.seconds * src.fps));
    if (out - inF < 1) throw new CommandError(`"${src.file}" has nothing recorded yet`, 409);
    const entry = { file: src.file, in: inF, out, frames: src.frames };
    const target = this.client(opts.targetId);
    const base = opts.mode === 'append' ? target.state.edit : [];
    const edit = await this.setEdit(opts.targetId, [...base, entry]);
    return { source: src, inFrames: inF, outFrames: out, edit };
  }

  clips(id: string, isNetwork: (slotId: number) => boolean): ClipListing[] {
    const s = this.client(id).state;
    const out: ClipListing[] = [];
    for (const slot of s.slots) {
      const files = s.disks[slot.slotId] ?? [];
      for (const f of files) {
        const fps = fpsFromVideoFormat(f.videoFormat);
        const tl = s.transport?.slotId === slot.slotId ? findTimelineClip(s, f.name) : null;
        out.push({
          slotId: slot.slotId,
          slotLabel: slot.volumeName || slot.slotName || slot.deviceName || `Slot ${slot.slotId}`,
          isNetwork: isNetwork(slot.slotId),
          index: f.index,
          file: f.name,
          fileFormat: f.fileFormat,
          videoFormat: f.videoFormat,
          duration: f.duration,
          fps,
          frames: fps ? timecodeToFrames(f.duration, fps) : null,
          timelineId: tl?.id ?? null,
        });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- deck setup menu

  async settings(id: string) {
    const c = this.client(id);
    if (c.state.status !== 'connected') throw new CommandError('HyperDeck not connected', 409);
    return readSettings(c, this.rests.get(id)!);
  }

  async setSetting(id: string, settingId: string, value: unknown) {
    try {
      await writeSetting(this.client(id), this.rests.get(id)!, settingId, value);
    } catch (e) {
      if (e instanceof SettingError) throw new CommandError(e.message, 400);
      throw toCommandError(e);
    }
    return this.settings(id);
  }

  async action(id: string, action: string, body: Record<string, unknown>) {
    try {
      return await deviceAction(this.client(id), this.rests.get(id)!, action, body);
    } catch (e) {
      if (e instanceof SettingError) throw new CommandError(e.message, 400);
      throw toCommandError(e);
    }
  }

  /**
   * Before changing a device's IP in the panel: can this server reach a
   * HyperDeck there, and is the address on one of this server's networks?
   */
  async probe(host: string, port = 9993): Promise<{ reachable: boolean; model?: string; error?: string; sameSubnet: boolean; serverAddresses: string[] }> {
    const serverAddresses: string[] = [];
    let sameSubnet = false;
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list ?? []) {
        if (i.internal || i.family !== 'IPv4') continue;
        serverAddresses.push(i.cidr ?? i.address);
        if (net.isIPv4(host) && inSubnet(host, i.address, i.netmask)) sameSubnet = true;
      }
    }
    if (!net.isIPv4(host) || host.startsWith('127.')) sameSubnet = true; // hostnames/loopback: don't warn on that basis
    const result = await new Promise<{ reachable: boolean; model?: string; error?: string }>((resolve) => {
      const sock = net.createConnection({ host, port });
      let buf = '';
      const done = (r: { reachable: boolean; model?: string; error?: string }) => { sock.destroy(); resolve(r); };
      sock.setTimeout(2500, () => done({ reachable: false, error: 'No answer within 2.5 s' }));
      sock.on('error', (e) => done({ reachable: false, error: e.message }));
      sock.on('data', (d) => {
        buf += d.toString();
        const m = /model:\s*(.+)/.exec(buf);
        if (/^500 connection info:/m.test(buf) && (m || buf.includes('\r\n\r\n'))) done({ reachable: true, model: m?.[1].trim() });
      });
      sock.on('connect', () => sock.setTimeout(2500));
    });
    return { ...result, sameSubnet, serverAddresses };
  }

  /** Replace the deck's timeline with an edit list (drag/drop, remove, split, reorder). */
  async setEdit(id: string, entries: unknown): Promise<DerivedEntry[]> {
    const c = this.client(id);
    if (c.state.status !== 'connected') throw new CommandError('HyperDeck not connected', 409);
    try {
      await applyEdit(c, validateEdit(entries, c.state));
      return editFromState(c.state, c); // not c.state.edit: that's only recomputed ~100 ms after a change
    } catch (e) {
      if (e instanceof EditError) throw new CommandError(e.message, 409);
      throw toCommandError(e);
    }
  }

  /**
   * Cue a file on the HyperDeck at an exact frame:
   *  1. select the slot the file is on (rebuilds the timeline from that media)
   *  2. find the file on the timeline — add it if it isn't there
   *  3. goto the clip, then step forward N frames from its first frame
   *  4. optionally play (whole timeline or just this clip)
   */
  async loadClip(id: string, opts: { slotId: number; file: string; frame: number; play?: boolean; singleClip?: boolean; replace?: boolean }): Promise<TransportInfo | null> {
    const c = this.client(id);
    try {
      let t = c.state.transport;
      if (!t) await c.refreshTransport();
      t = c.state.transport;
      if (t?.status === 'record') throw new CommandError('The HyperDeck is recording — stop recording before loading a clip', 409);

      if (t?.status === 'preview') await c.send('preview', { enable: false });
      if (t?.slotId !== opts.slotId) {
        await c.send('slot select', { 'slot id': opts.slotId });
        await sleep(300); // deck rebuilds the timeline after a slot change
      }
      await c.refreshTimeline();
      const frame = Math.max(0, Math.round(opts.frame));
      // Find a timeline entry of this file that contains the frame (entries may be slices).
      const find = () => {
        const want = stripExt(opts.file);
        // Derive afresh: c.state.edit is only recomputed ~100 ms after the timeline changes.
        const edit = editFromState(c.state, c);
        const i = edit.findIndex((e) => stripExt(e.file) === want && frame >= e.in && frame < e.out);
        return i >= 0 ? { id: i + 1, entry: edit[i] } : null;
      };
      let hit = find();
      if (!hit) {
        // A timeline holds one video format: the deck refuses a clip of another format with
        // "103 unsupported" (or "109 out of range"). Say so plainly, and replace the timeline
        // with just this clip when the user has confirmed that's what they want.
        if (opts.replace) await c.send('clips clear');
        try {
          await c.send('clips add', { name: opts.file });
        } catch (e) {
          if (!(e instanceof HyperDeckError) || (e.code !== 103 && e.code !== 109)) throw e;
          const disk = c.state.disks[opts.slotId] ?? [];
          const mine = disk.find((d) => d.name === opts.file)?.videoFormat;
          const theirs = disk.find((d) => c.state.timeline.some((t) => (t.name.split('/').pop() ?? t.name) === d.name))?.videoFormat
            ?? c.state.transport?.videoFormat;
          const why = mine && theirs && mine !== theirs ? `"${opts.file}" is ${mine} but the clips on the deck's timeline are ${theirs}` : `The deck refused "${opts.file}" (${e.code} ${e.text})`;
          throw new CommandError(`${why}. A HyperDeck timeline can only hold one video format.`, 409, 'format-mismatch');
        }
        // The deck applies the add a moment after acknowledging it.
        const base = (n: string) => stripExt(path.posix.basename(n.replace(/\\/g, '/')));
        await c.waitForTimeline((tl) => tl.some((x) => base(x.name) === stripExt(opts.file)) && (!opts.replace || tl.length === 1));
        hit = find();
      }
      if (!hit) throw new CommandError(`"${opts.file}" is not on the HyperDeck timeline and could not be added`, 404);
      const clip = { id: hit.id };

      if (c.state.transport?.status !== 'stopped' && !opts.play) await c.send('stop');
      await c.send('goto', { 'clip id': clip.id });
      const offset = frame - hit.entry.in;
      if (offset > 0) await c.send('goto', { clip: `+${offset}` });

      if (opts.singleClip) await c.send('playrange set', { 'clip id': clip.id }).catch(() => {});
      if (opts.play) await c.send('play', opts.singleClip ? { 'single clip': true } : undefined);
      await c.refreshTransport();
      return c.state.transport;
    } catch (e) {
      throw toCommandError(e);
    }
  }
}

function inSubnet(ip: string, addr: string, mask: string) {
  const n = (x: string) => x.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  return (n(ip) & n(mask)) >>> 0 === (n(addr) & n(mask)) >>> 0;
}

function stripExt(n: string) {
  return n.replace(/\.[a-z0-9]{2,4}$/i, '').toLowerCase();
}

export function findTimelineClip(s: HyperDeckState, file: string) {
  const want = stripExt(path.posix.basename(file.replace(/\\/g, '/')));
  return s.timeline.find((c) => stripExt(path.posix.basename(c.name.replace(/\\/g, '/'))) === want) ?? null;
}

function toCommandError(e: unknown): Error {
  if (e instanceof CommandError) return e;
  if (e instanceof HyperDeckError) {
    const friendly: Record<number, string> = {
      111: 'Remote control is disabled on the HyperDeck — enable Remote in its settings',
      105: 'No disk in the selected slot',
      107: 'Timeline is empty',
      112: 'Clip not found on the HyperDeck',
      104: 'Disk full',
      110: 'No video input',
      150: 'The HyperDeck is in the wrong state for that command',
    };
    return new CommandError(friendly[e.code] ?? `${e.code} ${e.text}`, 409);
  }
  return new CommandError((e as Error).message, 502);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
