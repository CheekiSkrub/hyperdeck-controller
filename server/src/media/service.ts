import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Device } from '../devices/store.js';
import type { HyperDeckState } from '../hyperdeck/client.js';
import { grabFrame, makeProxy, probe, type ProbeResult } from './ffmpeg.js';
import type { MediaLocator, MediaSource } from './locator.js';

/** Priority semaphore: exact-frame requests jump ahead of background filmstrip work. */
class PrioritySemaphore {
  private active = 0;
  private waiting: { prio: number; seq: number; go: () => void }[] = [];
  private seq = 0;
  constructor(private readonly limit: number) {}
  async run<T>(prio: number, fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((go) => {
        this.waiting.push({ prio, seq: this.seq++, go });
        this.waiting.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      });
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.go();
    }
  }
}

export const PRIO = { frame: 0, probe: 1, thumb: 2, strip: 3 } as const;

export interface ClipRef {
  slotId: number;
  file: string;
}

export interface ClipMedia {
  key: string;
  source: MediaSource;
  probe: ProbeResult;
}

export interface StripStatus {
  key: string;
  count: number;
  duration: number;
  fps: number;
  /** Seconds position of each tile. */
  times: number[];
  ready: boolean[];
  done: boolean;
}

export interface ProxyStatus {
  key: string;
  state: 'none' | 'queued' | 'running' | 'ready' | 'error';
  progress: number;
  error?: string;
}

export const STRIP_HEIGHT = 180;
export const THUMB_HEIGHT = 216;

/**
 * Thumbnails, scrub filmstrips, exact frames and optional H.264 proxies for
 * HyperDeck clips, read straight from FTP or a network share with ffmpeg and
 * cached on disk.
 */
export class MediaService extends EventEmitter {
  private sems = new Map<string, PrioritySemaphore>();
  private proxySems = new Map<string, PrioritySemaphore>();
  private resolved = new Map<string, { at: number; media: Promise<ClipMedia> }>();
  private strips = new Map<string, StripStatus>();
  private proxies = new Map<string, ProxyStatus & { abort?: AbortController }>();

  constructor(
    private readonly locator: MediaLocator,
    private readonly cacheDir: string,
    private readonly opts: { concurrency: number; proxyHeight: number; maxCacheGB: number },
  ) {
    super();
    fs.mkdirSync(cacheDir, { recursive: true });
    setInterval(() => void this.evict().catch(() => {}), 10 * 60_000).unref();
  }

  private sem(deviceId: string) {
    let s = this.sems.get(deviceId);
    if (!s) this.sems.set(deviceId, (s = new PrioritySemaphore(this.opts.concurrency)));
    return s;
  }

  private proxySem(deviceId: string) {
    let s = this.proxySems.get(deviceId);
    if (!s) this.proxySems.set(deviceId, (s = new PrioritySemaphore(1)));
    return s;
  }

  invalidate(deviceId: string) {
    for (const k of this.resolved.keys()) if (k.startsWith(deviceId + '|')) this.resolved.delete(k);
    this.locator.invalidate(deviceId);
  }

  /** Locate + probe a clip (cached ~30s in memory, probe cached on disk). */
  async media(device: Device, state: HyperDeckState, ref: ClipRef): Promise<ClipMedia> {
    const rkey = `${device.id}|${ref.slotId}|${ref.file}`;
    const hit = this.resolved.get(rkey);
    if (hit && Date.now() - hit.at < 30_000) return hit.media;
    const media = (async () => {
      const source = await this.locator.resolve(device, state, ref.slotId, ref.file);
      const key = crypto.createHash('sha1')
        .update([device.id, source.kind, source.display, source.size ?? '', source.modifiedAt ?? ''].join('|'))
        .digest('hex').slice(0, 20);
      const dir = this.dir(key);
      const probeFile = path.join(dir, 'probe.json');
      let p: ProbeResult;
      try {
        p = JSON.parse(await fs.promises.readFile(probeFile, 'utf8'));
      } catch {
        p = await this.sem(device.id).run(PRIO.probe, () => probe(source.input));
        await fs.promises.writeFile(probeFile, JSON.stringify(p));
      }
      return { key, source, probe: p };
    })();
    this.resolved.set(rkey, { at: Date.now(), media });
    media.catch(() => this.resolved.delete(rkey));
    return media;
  }

  private dir(key: string) {
    const d = path.join(this.cacheDir, key);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  /**
   * Thumbnail for a file found while browsing a mapped share or saved credential
   * (the Network drives tab) — these aren't a HyperDeck clip, so they skip
   * `resolve()`/slot lookup entirely and go straight from an absolute local path,
   * cached by that path plus size/mtime so an edited file re-thumbnails.
   */
  async networkThumbnail(deviceId: string, absPath: string): Promise<string> {
    const st = await fs.promises.stat(absPath);
    const key = crypto.createHash('sha1').update(['net', absPath, st.size, st.mtimeMs].join('|')).digest('hex').slice(0, 20);
    const file = path.join(this.dir(key), 'thumb.jpg');
    if (fs.existsSync(file)) return file;
    const p = await this.sem(deviceId).run(PRIO.probe, () => probe(absPath));
    const t = Math.min(1, Math.max(0, p.duration / 10));
    const buf = await this.sem(deviceId).run(PRIO.thumb, () => grabFrame(absPath, t, THUMB_HEIGHT));
    await fs.promises.writeFile(file, buf);
    return file;
  }

  async thumbnail(device: Device, state: HyperDeckState, ref: ClipRef): Promise<string> {
    const m = await this.media(device, state, ref);
    const file = path.join(this.dir(m.key), 'thumb.jpg');
    if (fs.existsSync(file)) return file;
    // A second or so in avoids black frames from fades / record start.
    const t = Math.min(1, Math.max(0, m.probe.duration / 10));
    const buf = await this.sem(device.id).run(PRIO.thumb, () => grabFrame(m.source.input, t, THUMB_HEIGHT));
    await fs.promises.writeFile(file, buf);
    return file;
  }

  /** Exact frame (0-based frame number within the file) as JPEG. */
  async frame(device: Device, state: HyperDeckState, ref: ClipRef, frame: number, height: number): Promise<string> {
    const m = await this.media(device, state, ref);
    const f = Math.max(0, Math.min(Math.round(frame), Math.max(0, m.probe.frames - 1)));
    const h = Math.max(90, Math.min(2160, Math.round(height / 2) * 2));
    const dir = path.join(this.dir(m.key), 'frames');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${f}_${h}.jpg`);
    if (fs.existsSync(file)) return file;
    // ffmpeg outputs the first frame with pts >= t; aim a quarter frame early to absorb float rounding.
    const t = Math.max(0, (f - 0.25) / m.probe.fps);
    const buf = await this.sem(device.id).run(PRIO.frame, () => grabFrame(m.source.input, t, h));
    await fs.promises.writeFile(file, buf);
    return file;
  }

  /** Start (or report) a progressive filmstrip for coarse scrubbing. */
  async strip(device: Device, state: HyperDeckState, ref: ClipRef): Promise<StripStatus> {
    const m = await this.media(device, state, ref);
    const existing = this.strips.get(m.key);
    if (existing) return existing;

    const count = Math.max(12, Math.min(120, Math.round(m.probe.duration / 2)));
    const times = Array.from({ length: count }, (_, i) => (m.probe.duration * (i + 0.5)) / count);
    const dir = path.join(this.dir(m.key), 'strip');
    fs.mkdirSync(dir, { recursive: true });
    const ready = times.map((_, i) => fs.existsSync(path.join(dir, `${i}.jpg`)));
    const status: StripStatus = { key: m.key, count, duration: m.probe.duration, fps: m.probe.fps, times, ready, done: ready.every(Boolean) };
    this.strips.set(m.key, status);
    if (!status.done) void this.fillStrip(device.id, m, status, dir);
    return status;
  }

  stripTilePath(key: string, index: number): string | null {
    const f = path.join(this.cacheDir, key, 'strip', `${index}.jpg`);
    return fs.existsSync(f) ? f : null;
  }

  private async fillStrip(deviceId: string, m: ClipMedia, status: StripStatus, dir: string) {
    // Breadth-first bisection order so coverage is even while it fills in.
    const order = bisectionOrder(status.count);
    await Promise.all(order.map((i) => status.ready[i] ? null : this.sem(deviceId).run(PRIO.strip, async () => {
      try {
        const buf = await grabFrame(m.source.input, status.times[i], STRIP_HEIGHT);
        await fs.promises.writeFile(path.join(dir, `${i}.jpg`), buf);
        status.ready[i] = true;
        this.emit('strip', { deviceId, key: m.key, index: i });
      } catch {
        /* leave the gap; UI falls back to the nearest tile */
      }
    })));
    status.done = true;
    this.emit('strip', { deviceId, key: m.key, index: -1, done: true });
  }

  // --------------------------------------------------------------------------- Proxies

  async proxyStatus(device: Device, state: HyperDeckState, ref: ClipRef): Promise<ProxyStatus> {
    const m = await this.media(device, state, ref);
    return this.proxyStatusForKey(m.key);
  }

  proxyStatusForKey(key: string): ProxyStatus {
    const p = this.proxies.get(key);
    if (p) return { key, state: p.state, progress: p.progress, error: p.error };
    const file = path.join(this.cacheDir, key, 'proxy.mp4');
    return fs.existsSync(file) ? { key, state: 'ready', progress: 1 } : { key, state: 'none', progress: 0 };
  }

  proxyPath(key: string): string | null {
    const f = path.join(this.cacheDir, key, 'proxy.mp4');
    return fs.existsSync(f) ? f : null;
  }

  async startProxy(device: Device, state: HyperDeckState, ref: ClipRef): Promise<ProxyStatus> {
    const m = await this.media(device, state, ref);
    const cur = this.proxyStatusForKey(m.key);
    if (cur.state === 'ready' || cur.state === 'running' || cur.state === 'queued') return cur;
    const abort = new AbortController();
    const entry: ProxyStatus & { abort?: AbortController } = { key: m.key, state: 'queued', progress: 0, abort };
    this.proxies.set(m.key, entry);
    const emit = () => this.emit('proxy', { deviceId: device.id, key: m.key, state: entry.state, progress: entry.progress, error: entry.error });
    emit();
    const out = path.join(this.dir(m.key), 'proxy.mp4');
    void this.proxySem(device.id).run(10, async () => {
      if (abort.signal.aborted) return;
      entry.state = 'running';
      emit();
      let last = 0;
      try {
        await makeProxy(m.source.input, out, this.opts.proxyHeight, m.probe.duration, (p) => {
          entry.progress = p;
          if (p - last > 0.01 || p === 1) { last = p; emit(); }
        }, abort.signal);
        entry.state = 'ready';
        this.proxies.delete(m.key);
      } catch (e) {
        entry.state = 'error';
        entry.error = abort.signal.aborted ? 'Cancelled' : (e as Error).message;
        fs.rmSync(out + '.part.mp4', { force: true });
      }
      emit();
    });
    return { key: m.key, state: entry.state, progress: 0 };
  }

  cancelProxy(key: string) {
    const p = this.proxies.get(key);
    p?.abort?.abort();
    this.proxies.delete(key);
  }

  // --------------------------------------------------------------------------- Cache eviction

  async evict(): Promise<void> {
    const limit = this.opts.maxCacheGB * 1024 ** 3;
    const entries: { dir: string; size: number; at: number }[] = [];
    for (const key of await fs.promises.readdir(this.cacheDir)) {
      const dir = path.join(this.cacheDir, key);
      const { size, at } = await dirStats(dir);
      entries.push({ dir, size, at });
    }
    let total = entries.reduce((n, e) => n + e.size, 0);
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries) {
      if (total <= limit) break;
      if ([...this.proxies.keys()].some((k) => e.dir.endsWith(k))) continue;
      await fs.promises.rm(e.dir, { recursive: true, force: true });
      this.strips.delete(path.basename(e.dir));
      total -= e.size;
    }
  }
}

async function dirStats(dir: string): Promise<{ size: number; at: number }> {
  let size = 0;
  let at = 0;
  const walk = async (d: string) => {
    for (const e of await fs.promises.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const st = await fs.promises.stat(p).catch(() => null);
        if (st) { size += st.size; at = Math.max(at, st.atimeMs, st.mtimeMs); }
      }
    }
  };
  await walk(dir);
  return { size, at };
}

export function bisectionOrder(n: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (let step = 2 ** Math.ceil(Math.log2(Math.max(1, n))); step >= 1; step = Math.floor(step / 2)) {
    for (let i = 0; i < n; i += step) if (!seen.has(i)) { seen.add(i); out.push(i); }
    if (step === 1) break;
  }
  return out;
}
