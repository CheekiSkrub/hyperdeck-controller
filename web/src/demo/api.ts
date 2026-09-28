/** Demo replacement for lib/api.ts: same surface, backed by the in-browser simulator. */
import type { DeviceInput } from '../lib/api';
import type { ClipListing, Device, EditEntry, MediaInfo, ProxyStatus, SourcesTest, StripStatus, TransportInfo } from '../lib/types';
import * as sim from './sim';
import { emitMedia } from './store';

export type { DeviceInput };

const later = <T>(fn: () => T, ms = 60): Promise<T> =>
  new Promise((resolve, reject) => setTimeout(() => { try { resolve(fn()); } catch (e) { reject(e); } }, ms));

const keyFor = (id: string, slot: number, file: string) => `${id}|${slot}|${file}`;
const strips = new Map<string, StripStatus>();

export const api = {
  info: () => later(() => ({ version: 'demo', platform: 'browser', ffmpeg: { ok: true, ffmpeg: 'simulated' } })),
  createDevice: (d: DeviceInput) => later(() => sim.createDevice(d as Partial<Device>)),
  updateDevice: (id: string, d: DeviceInput) => later(() => sim.updateDevice(id, d as Partial<Device>)),
  deleteDevice: (id: string) => later(() => sim.deleteDevice(id)),
  refresh: (_id: string) => later(() => ({})),
  testSources: (id: string) => later((): SourcesTest => {
    const d = sim.devices().find((x) => x.id === id)!;
    return {
      ftp: d.ftp.enabled ? { ok: true, message: 'Connected — 5 media file(s)', folders: ['/ssd1', '/ssd2'] } : { ok: false, message: 'FTP disabled' },
      shares: d.shares.map((s) => ({ id: s.id!, label: s.label, ok: true, message: 'Readable — 1 media file(s) found (simulated)' })),
      nasUrl: d.state.nasUrl,
    };
  }, 400),

  command: (id: string, command: string, params?: Record<string, string | number | boolean>) => later(() => sim.command(id, command, params), 30),
  settings: (id: string) => later(() => ({ rest: true, settings: sim.settingsFor(id).map((x) => ({ ...x })), errors: [] }), 300),
  setSetting: (id: string, settingId: string, value: unknown) =>
    later(() => ({ rest: true, settings: sim.setSetting(id, settingId, value).map((x) => ({ ...x })), errors: [] }), 150),
  action: (_id: string, action: string, _body?: Record<string, unknown>) =>
    later(() => {
      if (action === 'format') throw new Error('Formatting is disabled in the demo');
      return { ok: true };
    }, 300),
  probe: (host: string, _port?: number) => later(() => {
    const known = sim.devices().some((d) => d.host === host && d.state.status === 'connected');
    const sameSubnet = /^192\.168\.10\./.test(host);
    return { reachable: known, error: known ? undefined : 'No answer within 2.5 s (simulated)', sameSubnet, serverAddresses: ['192.168.10.5/24'] };
  }, 500),
  setEdit: (id: string, entries: EditEntry[]) => later(() => sim.setEdit(id, entries), 120),
  originalUrl: (_id: string, _slot: number, _file: string): string | null => null,
  liveUrl: (_id: string, _slot: number, _file: string, _seconds: number): string | null => null,
  clips: (id: string) => later((): ClipListing[] => sim.clips(id)),
  load: (id: string, body: { slotId: number; file: string; frame: number; play?: boolean; singleClip?: boolean }) =>
    later((): TransportInfo => sim.load(id, body), 250),

  mediaInfo: (id: string, slot: number, file: string) => later((): MediaInfo => {
    const { clip, slot: s } = sim.clipFor(id, slot, file);
    const key = keyFor(id, slot, file);
    const h = Math.floor(clip.tcStart / sim.FPS);
    const p = (n: number) => String(n).padStart(2, '0');
    return {
      key,
      source: s.network ? { kind: 'share', display: `\\\\nas.local\\Recordings\\${file}` } : { kind: 'ftp', display: `ftp://deck/${s.name}/${file}` },
      probe: {
        duration: clip.frames / sim.FPS, startTime: 0, fps: sim.FPS, frames: clip.frames, width: 1920, height: 1080,
        codec: 'prores', profile: 'HQ', timecode: `${p(Math.floor(h / 3600))}:${p(Math.floor(h / 60) % 60)}:${p(h % 60)}:00`, audioChannels: 2,
      },
      proxy: { key, state: 'none', progress: 0 },
    };
  }, 200),

  strip: (id: string, slot: number, file: string) => later((): StripStatus => {
    const key = keyFor(id, slot, file);
    const existing = strips.get(key);
    if (existing) return existing;
    const { clip } = sim.clipFor(id, slot, file);
    const duration = clip.frames / sim.FPS;
    const count = Math.max(12, Math.min(60, Math.round(duration / 2)));
    const st: StripStatus = {
      key, count, duration, fps: sim.FPS,
      times: Array.from({ length: count }, (_, i) => (duration * (i + 0.5)) / count),
      ready: Array(count).fill(false), done: false,
    };
    strips.set(key, st);
    // Fill progressively (coarse first) the way the server does.
    const order: number[] = [];
    for (let step = 2 ** Math.ceil(Math.log2(count)); step >= 1; step = Math.floor(step / 2)) {
      for (let i = 0; i < count; i += step) if (!order.includes(i)) order.push(i);
      if (step === 1) break;
    }
    order.forEach((i, n) => setTimeout(() => {
      st.ready[i] = true;
      const done = n === order.length - 1;
      if (done) st.done = true;
      emitMedia({ type: 'strip', deviceId: id, key, index: i, done: done || undefined });
    }, 120 + n * 45));
    return st;
  }, 150),

  startProxy: (_id: string, _slot: number, _file: string): Promise<ProxyStatus> =>
    Promise.reject(new Error('Proxies are transcoded by the server app with ffmpeg — not available in this browser demo')),
  cancelProxy: (_key: string) => Promise.resolve(),

  thumbUrl: (id: string, slot: number, file: string) => {
    const { clip } = sim.clipFor(id, slot, file);
    return sim.renderFrame(clip, Math.min(clip.frames - 1, sim.FPS), 216);
  },
  frameUrl: (id: string, slot: number, file: string, frame: number, h: number) => {
    const { clip } = sim.clipFor(id, slot, file);
    return sim.renderFrame(clip, frame, Math.min(h, 720));
  },
  stripTileUrl: (key: string, i: number) => {
    const [id, slot, file] = key.split('|');
    const st = strips.get(key)!;
    const { clip } = sim.clipFor(id, Number(slot), file);
    return sim.renderFrame(clip, Math.floor(st.times[i] * sim.FPS), 180);
  },
  proxyUrl: (_key: string) => '',
  downloadUrl: (_id: string, _slot: number, _file: string): string | null => null,
};
