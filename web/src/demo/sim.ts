/**
 * In-browser HyperDeck simulator used by the demo build. It mimics the
 * behaviour of the real server + deck closely enough to exercise the whole
 * panel: transport, slots, timeline, clip browser, scrubbing and cueing.
 * Frames are drawn on a canvas with a burnt-in frame counter so scrubbing
 * accuracy is visible.
 */
import type { Device, DeviceState, ShareMapping, TransportInfo } from '../lib/types';

export const FPS = 25;

interface SimClip { name: string; frames: number; look: Look; format: string; tcStart: number }
/** A timeline entry: `frames` of `src` starting at frame `in`. */
interface TL { name: string; frames: number; in: number; src: SimClip }
const full = (c: SimClip): TL => ({ name: c.name, frames: c.frames, in: 0, src: c });
type Look = 'bars' | 'studio' | 'pitch' | 'city' | 'record';
interface SimSlot { id: number; name: string; volume: string; clips: SimClip[]; network?: boolean }

interface Sim {
  device: Device;
  online: boolean;
  slots: SimSlot[];
  timeline: TL[];
  status: TransportInfo['status'];
  speed: number;
  slotId: number;
  position: number;
  loop: boolean;
  singleClip: boolean;
  remote: boolean;
  recording: SimClip | null;
}

const tc = (frames: number) => {
  const f = ((frames % FPS) + FPS) % FPS;
  const s = Math.floor(frames / FPS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f)}`;
};

const sec = (s: number) => Math.round(s * FPS);

function defaultFtp() {
  return { enabled: true, port: 21, user: 'anonymous', password: '' };
}

let idSeq = 0;
const newId = () => `demo-${++idSeq}-${Math.random().toString(36).slice(2, 7)}`;

function makeSim(name: string, host: string, online: boolean, slots: SimSlot[], shares: ShareMapping[] = []): Sim {
  const device: Device = {
    id: newId(), name, host, port: 9993, restPort: 80, ftp: defaultFtp(), shares, createdAt: new Date().toISOString(),
    state: undefined as unknown as DeviceState,
  };
  const sim: Sim = {
    device, online, slots, timeline: [], status: 'stopped', speed: 0, slotId: slots[0]?.id ?? 1, position: 0,
    loop: false, singleClip: false, remote: true, recording: null,
  };
  sim.timeline = (slots[0]?.clips ?? []).map(full);
  return sim;
}

const sims: Sim[] = [
  makeSim('Studio A · Deck 1', '192.168.10.51', true, [
    { id: 1, name: 'ssd1', volume: 'Show Day 2', clips: [
      { name: 'Opening Titles_0001.mov', frames: sec(24), look: 'bars', format: 'QuickTimeProResHQ', tcStart: sec(36000) },
      { name: 'Presenter Link A_0002.mov', frames: sec(48), look: 'studio', format: 'QuickTimeProResHQ', tcStart: sec(36060) },
      { name: 'Presenter Link B_0003.mov', frames: sec(37), look: 'studio', format: 'QuickTimeProResHQ', tcStart: sec(36200) },
    ] },
    { id: 2, name: 'ssd2', volume: 'Replays', clips: [
      { name: 'Match Highlights_0001.mov', frames: sec(62), look: 'pitch', format: 'QuickTimeProRes', tcStart: sec(39600) },
      { name: 'Goal ISO Cam 3_0002.mov', frames: sec(18), look: 'pitch', format: 'QuickTimeProRes', tcStart: sec(39900) },
    ] },
    { id: 3, name: 'nas', volume: 'Studio NAS', network: true, clips: [
      { name: 'City GVs_0001.mov', frames: sec(45), look: 'city', format: 'QuickTimeProRes', tcStart: sec(43200) },
    ] },
  ], [{ id: newId(), label: 'Studio NAS', url: 'smb://nas.local/Recordings', localPath: '\\\\nas.local\\Recordings' }]),
  makeSim('Studio B · Deck 2', '192.168.10.52', false, []),
];

// ------------------------------------------------------------------ state snapshots

const listeners = new Set<() => void>();
export function onChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function changed() {
  for (const l of listeners) l();
}

function clipAt(s: Sim, pos: number) {
  let start = 0;
  for (let i = 0; i < s.timeline.length; i++) {
    const c = s.timeline[i];
    if (pos < start + c.frames) return { id: i + 1, start, clip: c };
    start += c.frames;
  }
  if (!s.timeline.length) return null;
  const last = s.timeline[s.timeline.length - 1];
  return { id: s.timeline.length, start: start - last.frames, clip: last };
}
const total = (s: Sim) => s.timeline.reduce((n, c) => n + c.frames, 0);
const clipStart = (s: Sim, id: number) => s.timeline.slice(0, id - 1).reduce((n, c) => n + c.frames, 0);

function snapshot(s: Sim): Device {
  if (!s.online) {
    return {
      ...s.device,
      state: { status: 'connecting', lastError: 'connect ETIMEDOUT', info: null, transport: null, slots: [], disks: {}, timeline: [], remote: null, nasUrl: null, edit: [] },
    };
  }
  const at = clipAt(s, s.position);
  const slot = s.slots.find((x) => x.id === s.slotId);
  let acc = 0;
  return {
    ...s.device,
    state: {
      status: 'connected',
      info: { protocolVersion: '1.13', model: 'HyperDeck Studio 4K Pro', uniqueId: s.device.id, slotCount: 2, softwareVersion: '8.4', name: s.device.name },
      transport: {
        status: s.status, speed: s.speed, slotId: s.slotId, slotName: slot?.name, deviceName: slot?.name,
        clipId: at?.id ?? null, singleClip: s.singleClip,
        displayTimecode: s.recording ? tc(s.recording.tcStart + s.recording.frames) : at ? tc(at.clip.src.tcStart + at.clip.in + s.position - at.start) : '00:00:00:00',
        timecode: tc(s.position), videoFormat: '1080p25', loop: s.loop, timeline: s.position, inputVideoFormat: '1080p25', referenceLocked: true,
      },
      slots: s.slots.map((x) => ({
        slotId: x.id, slotName: x.name, deviceName: x.name, status: 'mounted', volumeName: x.volume,
        recordingTime: x.network ? 86400 : 14400 - x.clips.length * 300, videoFormat: '1080p25', blocked: false,
        remainingSize: (x.network ? 3.2e12 : 1.4e12) - x.clips.reduce((n, c) => n + c.frames * 9e6, 0), totalSize: x.network ? 4e12 : 2e12,
      })),
      disks: Object.fromEntries(s.slots.map((x) => [x.id, x.clips.map((c, i) => ({ index: i + 1, name: c.name, fileFormat: c.format, videoFormat: '1080p25', duration: tc(c.frames) }))])),
      timeline: s.timeline.map((c, i) => {
        const r = { id: i + 1, name: c.name, startTimecode: tc(c.src.tcStart), duration: tc(c.src.frames), inTimecode: tc(c.src.tcStart + c.in), outTimecode: tc(c.src.tcStart + c.in + c.frames) };
        acc += c.frames;
        return r;
      }),
      edit: s.timeline.map((e) => ({ file: e.name, in: e.in, out: e.in + e.frames, frames: e.src.frames })),
      remote: { enabled: s.remote, override: false },
      nasUrl: 'smb://nas.local/Recordings',
    },
  };
}

let cache: Device[] = [];
function rebuild() {
  cache = sims.map(snapshot);
  changed();
}
rebuild();
export const devices = () => cache;

// ------------------------------------------------------------------ playback clock

let frac = 0;
setInterval(() => {
  let dirty = false;
  for (const s of sims) {
    if (!s.online) continue;
    if (s.status === 'record' && s.recording) {
      s.recording.frames += 1;
      dirty = true;
      continue;
    }
    if (s.status !== 'play' && s.status !== 'shuttle' && s.status !== 'forward' && s.status !== 'rewind') continue;
    frac += s.speed / 100;
    const step = Math.trunc(frac);
    frac -= step;
    if (!step) continue;
    s.position += step;
    const at = clipAt(s, s.position);
    const end = s.singleClip && at ? at.start + at.clip.frames : total(s);
    const start = s.singleClip && at ? at.start : 0;
    if (s.position >= end || s.position < start) {
      if (s.loop) s.position = s.speed >= 0 ? start : end - 1;
      else { s.position = Math.max(start, Math.min(s.position, end - 1)); s.status = 'stopped'; s.speed = 0; }
    }
    dirty = true;
  }
  if (dirty) rebuild();
}, 1000 / FPS);

// ------------------------------------------------------------------ CRUD

function find(id: string) {
  const s = sims.find((x) => x.device.id === id);
  if (!s) throw new Error('Device not found');
  return s;
}

export function createDevice(input: Partial<Device>): Device {
  if (!input.name?.trim()) throw new Error('Name is required');
  if (!input.host?.trim()) throw new Error('IP address is required');
  // New demo decks get a small sample disk so there is something to browse.
  const s = makeSim(input.name.trim(), input.host.trim(), true, [
    { id: 1, name: 'sd1', volume: 'Card 1', clips: [
      { name: 'Camera Test_0001.mov', frames: sec(30), look: 'bars', format: 'QuickTimeProRes', tcStart: sec(32400) },
      { name: 'Camera Test_0002.mov', frames: sec(20), look: 'city', format: 'QuickTimeProRes', tcStart: sec(32460) },
    ] },
  ], input.shares ?? []);
  if (input.ftp) s.device.ftp = input.ftp;
  sims.push(s);
  rebuild();
  return snapshot(s);
}

export function updateDevice(id: string, input: Partial<Device>): Device {
  const s = find(id);
  if (input.name !== undefined) s.device.name = input.name.trim();
  if (input.host !== undefined) s.device.host = input.host.trim();
  if (input.port !== undefined) s.device.port = input.port;
  if (input.restPort !== undefined) s.device.restPort = input.restPort;
  if (input.ftp) s.device.ftp = input.ftp;
  if (input.shares) s.device.shares = input.shares.map((x) => ({ ...x, id: x.id ?? newId() }));
  rebuild();
  return snapshot(s);
}

export function deleteDevice(id: string) {
  const i = sims.findIndex((x) => x.device.id === id);
  if (i >= 0) sims.splice(i, 1);
  rebuild();
}

// ------------------------------------------------------------------ protocol commands

export class DeckError extends Error {}

export function command(id: string, name: string, p: Record<string, string | number | boolean> = {}) {
  const s = find(id);
  if (!s.online) throw new DeckError('HyperDeck not connected');
  const needsRemote = ['play', 'stop', 'record', 'goto', 'jog', 'shuttle', 'slot select', 'preview', 'clips add'];
  if (needsRemote.includes(name) && !s.remote) throw new DeckError('Remote control is disabled on the HyperDeck — enable Remote in its settings');
  if (s.status === 'record' && name !== 'stop' && name !== 'remote') throw new DeckError('The HyperDeck is in the wrong state for that command');

  switch (name) {
    case 'play':
      s.status = 'play';
      s.speed = p.speed !== undefined ? Number(p.speed) : 100;
      if (p.loop !== undefined) s.loop = p.loop === true || p.loop === 'true';
      if (p['single clip'] !== undefined) s.singleClip = p['single clip'] === true || p['single clip'] === 'true';
      if (!s.timeline.length) { s.status = 'stopped'; throw new DeckError('Timeline is empty'); }
      break;
    case 'stop':
      if (s.status === 'record' && s.recording) {
        s.recording = null;
        s.timeline = s.slots.find((x) => x.id === s.slotId)!.clips.map(full);
      }
      s.status = 'stopped'; s.speed = 0;
      break;
    case 'record': {
      const slot = s.slots.find((x) => x.id === s.slotId)!;
      const n = String(slot.clips.length + 1).padStart(4, '0');
      const base = typeof p.name === 'string' && p.name ? p.name : 'Deck Record';
      const clip: SimClip = { name: `${base}_${n}.mov`, frames: 0, look: 'record', format: 'QuickTimeProResHQ', tcStart: sec(50400) };
      slot.clips.push(clip);
      s.recording = clip;
      s.status = 'record'; s.speed = 0;
      break;
    }
    case 'preview':
      s.status = p.enable === true || p.enable === 'true' ? 'preview' : 'stopped';
      break;
    case 'shuttle':
      s.status = Number(p.speed) === 0 ? 'stopped' : 'shuttle';
      s.speed = Number(p.speed);
      break;
    case 'remote':
      if (p.enable !== undefined) s.remote = p.enable === true || p.enable === 'true';
      break;
    case 'slot select': {
      const slot = s.slots.find((x) => x.id === Number(p['slot id']));
      if (!slot) throw new DeckError('102 invalid value');
      s.slotId = slot.id; s.timeline = slot.clips.map(full); s.position = 0; s.status = 'stopped'; s.speed = 0;
      break;
    }
    case 'clips add': {
      const f = s.slots.find((x) => x.id === s.slotId)!.clips.find((c) => c.name === p.name);
      if (!f) throw new DeckError('Clip not found on the HyperDeck');
      const fi = p['frame in'] !== undefined ? Number(p['frame in']) : 0;
      const fo = p['frame out'] !== undefined ? Number(p['frame out']) : f.frames;
      s.timeline.push({ name: f.name, frames: fo - fi, in: fi, src: f });
      break;
    }
    case 'playrange set': case 'playrange clear': case 'identify': case 'play option':
      break;
    case 'goto': {
      if (!s.timeline.length) throw new DeckError('Timeline is empty');
      const cur = clipAt(s, s.position)!;
      if (p['clip id'] !== undefined) {
        const v = String(p['clip id']);
        const id = v === 'start' ? 1 : v === 'end' ? s.timeline.length : /^[+-]/.test(v) ? cur.id + Number(v) : Number(v);
        if (id < 1 || id > s.timeline.length) throw new DeckError('109 out of range');
        s.position = clipStart(s, id);
      } else if (p.clip !== undefined) {
        const v = String(p.clip);
        s.position = v === 'start' ? cur.start : v === 'end' ? cur.start + cur.clip.frames - 1 : /^[+-]/.test(v) ? s.position + Number(v) : cur.start + Number(v);
      } else if (p.timeline !== undefined) {
        const v = String(p.timeline);
        s.position = v === 'start' ? 0 : v === 'end' ? total(s) - 1 : /^[+-]/.test(v) ? s.position + Number(v) : Number(v);
      }
      s.position = Math.max(0, Math.min(s.position, total(s) - 1));
      if (s.status === 'preview') s.status = 'stopped';
      break;
    }
    default:
      throw new DeckError(`Command "${name}" is not allowed`);
  }
  rebuild();
  return { code: 200, text: 'ok' };
}

/** The same cue sequence the server runs: slot select, add to timeline, goto clip + frames. */
export function load(id: string, b: { slotId: number; file: string; frame: number; play?: boolean; singleClip?: boolean }) {
  const s = find(id);
  if (s.status === 'record') throw new DeckError('The HyperDeck is recording — stop recording before loading a clip');
  if (s.status === 'preview') command(id, 'preview', { enable: false });
  if (s.slotId !== b.slotId) command(id, 'slot select', { 'slot id': b.slotId });
  const frame = Math.round(b.frame);
  let idx = s.timeline.findIndex((c) => c.name === b.file && frame >= c.in && frame < c.in + c.frames);
  if (idx < 0) { command(id, 'clips add', { name: b.file }); idx = s.timeline.length - 1; }
  if (!b.play) command(id, 'stop');
  command(id, 'goto', { 'clip id': idx + 1 });
  const offset = frame - s.timeline[idx].in;
  if (offset > 0) command(id, 'goto', { clip: `+${offset}` });
  if (b.play) command(id, 'play', b.singleClip ? { 'single clip': true } : {});
  return snapshot(s).state.transport!;
}

/** Replace the timeline with an edit list, like the server's PUT /edit. */
export function setEdit(id: string, entries: { file: string; in: number; out: number }[]) {
  const s = find(id);
  if (s.status === 'record') throw new DeckError("Can't change the timeline while recording");
  const slot = s.slots.find((x) => x.id === s.slotId)!;
  const next = entries.map((e) => {
    const src = slot.clips.find((c) => c.name === e.file);
    if (!src) throw new DeckError(`"${e.file}" isn't on the active media. The deck's timeline can only use clips from the selected slot.`);
    const fi = Math.max(0, Math.floor(e.in));
    const fo = Math.min(src.frames, Math.floor(e.out));
    if (fo - fi < 1) throw new DeckError(`${e.file} entry is empty`);
    return { name: src.name, frames: fo - fi, in: fi, src };
  });
  if (['play', 'shuttle', 'forward', 'rewind'].includes(s.status)) { s.status = 'stopped'; s.speed = 0; }
  s.timeline = next;
  s.position = Math.min(s.position, Math.max(0, total(s) - 1));
  rebuild();
  return snapshot(s).state.edit;
}

export function clips(id: string) {
  const s = find(id);
  if (!s.online) return [];
  return s.slots.flatMap((slot) => slot.clips.map((c, i) => ({
    slotId: slot.id, slotLabel: slot.volume, isNetwork: Boolean(slot.network), index: i + 1, file: c.name,
    fileFormat: c.format, videoFormat: '1080p25', duration: tc(c.frames), fps: FPS, frames: c.frames,
    timelineId: s.slotId === slot.id ? (s.timeline.findIndex((t) => t.src === c) + 1 || null) : null,
  })));
}

export function clipFor(id: string, slotId: number, file: string) {
  const s = find(id);
  const slot = s.slots.find((x) => x.id === slotId);
  const c = slot?.clips.find((x) => x.name === file);
  if (!slot || !c) throw new Error(`Could not find "${file}"`);
  return { sim: s, slot, clip: c };
}

// ------------------------------------------------------------------ synthetic frames

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d')!;
const frameCache = new Map<string, string>();

export function renderFrame(clip: SimClip, frame: number, height: number): string {
  const key = `${clip.name}|${frame}|${height}`;
  const hit = frameCache.get(key);
  if (hit) return hit;
  const h = height;
  const w = Math.round((h * 16) / 9);
  canvas.width = w;
  canvas.height = h;
  const t = frame / FPS;
  const u = h / 540;
  draw(clip.look, w, h, t, u);

  // Burnt-in window: clip name, source timecode, frame number.
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(16 * u, 16 * u, 360 * u, 64 * u);
  ctx.fillStyle = '#fff';
  ctx.font = `${20 * u}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.fillText(clip.name.replace(/\.mov$/, ''), 28 * u, 42 * u);
  ctx.fillStyle = '#ffd166';
  ctx.fillText(`${tc(clip.tcStart + frame)}   f${frame}`, 28 * u, 68 * u);

  const url = canvas.toDataURL('image/jpeg', 0.8);
  if (frameCache.size > 600) frameCache.clear();
  frameCache.set(key, url);
  return url;
}

function draw(look: Look, w: number, h: number, t: number, u: number) {
  switch (look) {
    case 'bars': {
      const cols = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
      cols.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect((i * w) / 7, 0, w / 7 + 1, h * 0.72); });
      ctx.fillStyle = '#131313'; ctx.fillRect(0, h * 0.72, w, h * 0.28);
      const x = ((t * 180 * u) % (w + 200 * u)) - 100 * u;
      ctx.fillStyle = '#fff'; ctx.fillRect(x, h * 0.78, 100 * u, h * 0.14);
      break;
    }
    case 'studio': {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#0d2a4a'); g.addColorStop(1, '#27103f');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = `rgba(80,160,255,${0.08 + 0.04 * Math.sin(t + i)})`;
        ctx.fillRect(((i + 0.5) * w) / 6 - 30 * u, 0, 60 * u, h * 0.6);
      }
      ctx.fillStyle = '#1b1b24'; ctx.fillRect(0, h * 0.7, w, h * 0.3);
      const sway = Math.sin(t * 1.3) * 8 * u;
      ctx.fillStyle = '#e3b58f'; ctx.beginPath(); ctx.arc(w * 0.5 + sway, h * 0.38, 46 * u, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2d3e63'; ctx.fillRect(w * 0.5 - 90 * u + sway, h * 0.47, 180 * u, h * 0.26);
      ctx.fillStyle = 'rgba(12,20,40,0.85)'; ctx.fillRect(w * 0.08, h * 0.8, w * 0.55, 46 * u);
      ctx.fillStyle = '#fff'; ctx.font = `${22 * u}px system-ui, sans-serif`; ctx.fillText('Sam Porter · Presenter', w * 0.1, h * 0.8 + 30 * u);
      break;
    }
    case 'pitch': {
      for (let i = 0; i < 10; i++) { ctx.fillStyle = i % 2 ? '#2f8a3a' : '#35963f'; ctx.fillRect((i * w) / 10, 0, w / 10 + 1, h); }
      ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 3 * u;
      ctx.strokeRect(30 * u, 30 * u, w - 60 * u, h - 60 * u);
      ctx.beginPath(); ctx.moveTo(w / 2, 30 * u); ctx.lineTo(w / 2, h - 30 * u); ctx.stroke();
      ctx.beginPath(); ctx.arc(w / 2, h / 2, 70 * u, 0, Math.PI * 2); ctx.stroke();
      const bx = w / 2 + Math.sin(t * 0.9) * w * 0.35;
      const by = h / 2 + Math.sin(t * 1.7) * h * 0.3;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(bx, by, 10 * u, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'city': {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#f08a4b'); g.addColorStop(0.6, '#6a3d7a'); g.addColorStop(1, '#1c1630');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 18; i++) {
        const bw = (w / 18) * (0.8 + ((i * 37) % 5) / 10);
        const bh = h * (0.25 + ((i * 53) % 7) / 14);
        ctx.fillStyle = '#15121f'; ctx.fillRect((i * w) / 18, h - bh, bw, bh);
      }
      const cx = ((t * 120 * u) % (w + 80 * u)) - 40 * u;
      ctx.fillStyle = '#ffe28a'; ctx.fillRect(cx, h - 26 * u, 34 * u, 10 * u);
      break;
    }
    case 'record': {
      ctx.fillStyle = '#141a22'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#e5484d'; ctx.beginPath(); ctx.arc(w / 2, h / 2, (40 + 10 * Math.sin(t * 3)) * u, 0, Math.PI * 2); ctx.fill();
      break;
    }
  }
}

// ------------------------------------------------------------------ setup menu (demo)

import type { DeckSetting } from '../lib/types';

const o = (...v: string[]) => v.map((x) => ({ value: x, label: x }));
const menus = new Map<string, DeckSetting[]>();
export function settingsFor(id: string): DeckSetting[] {
  const s = find(id);
  if (!s.online) throw new DeckError('HyperDeck not connected');
  let m = menus.get(id);
  if (!m) {
    m = [
      { id: 'rest:codecFormat', group: 'Record', label: 'Codec', type: 'select', value: 'ProRes HQ', options: o('ProRes HQ', 'ProRes 422', 'ProRes LT', 'ProRes Proxy', 'DNxHD 220x', 'DNxHR HQX', 'H.264 High', 'H.265 High') },
      { id: 'cfg:record trigger', group: 'Record', label: 'Record trigger', type: 'select', value: 'none', options: o('none', 'recordbit', 'timecoderun') },
      { id: 'cfg:record prefix', group: 'Record', label: 'File name prefix', type: 'text', value: 'Studio A' },
      { id: 'cfg:append timestamp', group: 'Record', label: 'Append timestamp to file name', type: 'bool', value: false },
      { id: 'cfg:record cache', group: 'Record', label: 'Record cache', type: 'bool', value: false },
      { id: 'rest:videoFormat', group: 'Video', label: 'Video format', type: 'select', value: '1080p25', options: o('1080p25', '1080p50', '1080i50', '2160p25', '2160p50'), help: 'Recording follows the input when one is connected.' },
      { id: 'rest:inputVideoSource', group: 'Video', label: 'Video input', type: 'select', value: 'SDI', options: o('SDI', 'HDMI') },
      { id: 'cfg:reference source', group: 'Video', label: 'Reference source', type: 'select', value: 'auto', options: o('auto', 'input', 'external') },
      { id: 'dr:record override', group: 'Video', label: 'HDR record override', type: 'select', value: 'off', options: o('off', 'Rec709', 'Rec2020_SDR', 'HLG', 'ST2084_1000') },
      { id: 'cfg:audio input', group: 'Audio', label: 'Audio input', type: 'select', value: 'embedded', options: o('embedded', 'XLR', 'RCA') },
      { id: 'rest:audioFormat', group: 'Audio', label: 'Audio record format', type: 'select', value: 'PCM · 8 ch', options: o('PCM · 2 ch', 'PCM · 4 ch', 'PCM · 8 ch', 'PCM · 16 ch', 'AAC · 2 ch') },
      { id: 'cfg:timecode input', group: 'Timecode', label: 'Timecode input', type: 'select', value: 'external', options: o('external', 'embedded', 'internal', 'preset', 'clip') },
      { id: 'cfg:timecode output', group: 'Timecode', label: 'Timecode output', type: 'select', value: 'clip', options: o('clip', 'timeline') },
      { id: 'cfg:timecode preset', group: 'Timecode', label: 'Timecode preset', type: 'timecode', value: '10:00:00:00' },
      { id: 'play:stop mode', group: 'Playback', label: 'Stop mode', type: 'select', value: 'lastframe', options: o('lastframe', 'nextframe', 'black') },
      { id: 'startup:enable', group: 'Playback', label: 'Play on startup', type: 'bool', value: false },
      { id: 'remote:enable', group: 'System', label: 'Remote control enabled', type: 'bool', value: true },
      { id: 'info:product', group: 'System', label: 'Model', type: 'info', value: 'HyperDeck Studio 4K Pro', readOnly: true },
      { id: 'info:software', group: 'System', label: 'Software version', type: 'info', value: '8.4', readOnly: true },
      { id: 'mon:SDI:cleanFeed', group: 'Monitoring · SDI', label: 'Clean feed', type: 'bool', value: false },
      { id: 'mon:SDI:zebra', group: 'Monitoring · SDI', label: 'Zebra', type: 'bool', value: false },
      { id: 'mon:SDI:frameGuide', group: 'Monitoring · SDI', label: 'Frame guides', type: 'bool', value: false },
    ];
    menus.set(id, m);
  }
  const remote = m.find((x) => x.id === 'remote:enable');
  if (remote) remote.value = s.remote;
  return m;
}

export function setSetting(id: string, settingId: string, value: unknown) {
  const m = settingsFor(id);
  const item = m.find((x) => x.id === settingId);
  if (!item || item.readOnly) throw new DeckError('This setting is read-only');
  item.value = value as DeckSetting['value'];
  if (settingId === 'remote:enable') { find(id).remote = value === true; rebuild(); }
  return m;
}
