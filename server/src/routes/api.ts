import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { saveSettings, type Settings } from '../config.js';
import { CommandError, type DeviceManager } from '../devices/manager.js';
import { ValidationError, type DeviceInput } from '../devices/store.js';
import { ffmpegPaths, spawnLive } from '../media/ffmpeg.js';
import type { FtpBridge } from '../media/ftpBridge.js';
import type { MediaLocator } from '../media/locator.js';
import type { ClipRef, MediaService } from '../media/service.js';

interface Ctx {
  devices: DeviceManager;
  media: MediaService;
  locator: MediaLocator;
  bridge: FtpBridge;
  settings: Settings;
  dataDir: string;
  version: string;
  ffmpegOk: boolean;
}

type IdParams = { Params: { id: string } };

export async function registerApi(app: FastifyInstance, ctx: Ctx) {
  const { devices, media, locator } = ctx;

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof ValidationError ? 400 : err instanceof CommandError ? err.status : err.statusCode ?? 500;
    reply.status(status).send({ error: err.message });
  });

  const clipRef = (req: FastifyRequest): ClipRef => {
    const q = req.query as Record<string, string>;
    const slotId = Number(q.slot);
    if (!Number.isInteger(slotId) || !q.file) throw new ValidationError('slot and file are required');
    if (/[\\/]\.\.|^\.\./.test(q.file)) throw new ValidationError('Invalid file name');
    return { slotId, file: q.file };
  };
  const ctxFor = (id: string) => ({ device: devices.get(id), state: devices.client(id).state });

  // ------------------------------------------------------------------ App

  app.get('/api/info', async () => ({
    version: ctx.version,
    platform: process.platform,
    ffmpeg: { ok: ctx.ffmpegOk, ...ffmpegPaths() },
  }));

  app.get('/api/settings', async () => ctx.settings);
  app.patch('/api/settings', async (req) => {
    const body = req.body as Partial<Settings>;
    const allowed: (keyof Settings)[] = ['port', 'host', 'ffmpegPath', 'ffprobePath', 'maxCacheGB', 'mediaConcurrency', 'proxyHeight', 'openBrowser'];
    for (const k of allowed) if (k in body) (ctx.settings as any)[k] = (body as any)[k];
    saveSettings(ctx.dataDir, ctx.settings);
    return { ...ctx.settings, restartRequired: true };
  });

  // ------------------------------------------------------------------ Devices CRUD

  app.get('/api/devices', async () => devices.list());
  app.post('/api/devices', async (req, reply) => {
    const d = devices.create(req.body as DeviceInput);
    reply.status(201);
    return d;
  });
  app.get<IdParams>('/api/devices/:id', async (req) => ({ ...devices.get(req.params.id), state: devices.client(req.params.id).state }));
  app.patch<IdParams>('/api/devices/:id', async (req) => {
    const d = devices.update(req.params.id, req.body as DeviceInput);
    media.invalidate(d.id);
    return d;
  });
  app.delete<IdParams>('/api/devices/:id', async (req, reply) => {
    devices.remove(req.params.id);
    media.invalidate(req.params.id);
    reply.status(204);
  });

  // ------------------------------------------------------------------ Control

  app.post<IdParams>('/api/devices/:id/command', async (req) => {
    const { command, params } = req.body as { command: string; params?: Record<string, string | number | boolean> };
    return devices.command(req.params.id, command, params);
  });

  app.put<IdParams>('/api/devices/:id/edit', async (req) => {
    return devices.setEdit(req.params.id, (req.body as { entries: unknown }).entries);
  });

  app.post<IdParams>('/api/devices/:id/refresh', async (req) => {
    const c = devices.client(req.params.id);
    media.invalidate(req.params.id);
    await c.refreshAll();
    return c.state;
  });

  app.get<IdParams>('/api/devices/:id/clips', async (req) => {
    const { device, state } = ctxFor(req.params.id);
    return devices.clips(req.params.id, (slotId) => locator.isNetworkSlot(device, state, slotId));
  });

  app.post<IdParams>('/api/devices/:id/load', async (req) => {
    const b = req.body as { slotId: number; file: string; frame: number; play?: boolean; singleClip?: boolean };
    if (!Number.isInteger(b.slotId) || !b.file) throw new ValidationError('slotId and file are required');
    return devices.loadClip(req.params.id, { ...b, frame: Number(b.frame) || 0 });
  });

  // ------------------------------------------------------------------ Media sources

  app.get<IdParams>('/api/devices/:id/sources/test', async (req) => {
    const d = devices.get(req.params.id);
    const ftp = d.ftp.enabled ? await locator.testFtp(d) : { ok: false, message: 'FTP disabled' };
    const shares = await Promise.all(d.shares.map(async (s) => ({ id: s.id, label: s.label, ...(await locator.testShare(s)) })));
    return { ftp, shares, nasUrl: devices.client(d.id).state.nasUrl };
  });

  app.get<IdParams>('/api/devices/:id/media/info', async (req) => {
    const { device, state } = ctxFor(req.params.id);
    const m = await media.media(device, state, clipRef(req));
    return {
      key: m.key,
      source: { kind: m.source.kind, display: m.source.display, size: m.source.size },
      probe: m.probe,
      proxy: media.proxyStatusForKey(m.key),
    };
  });

  // Original file for direct <video> playback (H.264/H.265, or ProRes in Safari).
  // Shares are streamed from disk with Range support; FTP goes through the bridge.
  app.get<IdParams>('/api/devices/:id/media/original', async (req, reply) => {
    const { device, state } = ctxFor(req.params.id);
    const m = await media.media(device, state, clipRef(req));
    if (m.source.kind === 'ftp' && m.source.remotePath) {
      const u = new URL(ctx.bridge.url(device.id, m.source.remotePath));
      return reply.redirect(`${u.pathname}${u.search}`);
    }
    return sendRange(req, reply, m.source.input, 'video/mp4');
  });

  // Live transcode for codecs the browser can't decode (ProRes, DNx). Not seekable:
  // the viewer restarts the stream at a new ?t= when you play from another point.
  let liveStreams = 0;
  app.get<IdParams>('/api/devices/:id/media/live', async (req, reply) => {
    const { device, state } = ctxFor(req.params.id);
    const q = req.query as Record<string, string>;
    const m = await media.media(device, state, clipRef(req));
    if (liveStreams >= 4) return reply.status(429).send({ error: 'Too many live previews running on this server' });
    const t = Math.max(0, Math.min(Number(q.t) || 0, m.probe.duration));
    const child = spawnLive(m.source.input, t, Math.min(720, Number(q.h) || 540));
    liveStreams++;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      liveStreams--;
      child.kill('SIGKILL');
    };
    req.raw.on('close', end);
    child.on('exit', end);
    reply.header('Content-Type', 'video/mp4');
    reply.header('Cache-Control', 'no-store');
    return reply.send(child.stdout);
  });

  app.get<IdParams>('/api/devices/:id/media/download', async (req, reply) => {
    const { device, state } = ctxFor(req.params.id);
    const ref = clipRef(req);
    const m = await media.media(device, state, ref);
    if (m.source.kind === 'ftp' && m.source.remotePath) {
      const u = new URL(ctx.bridge.url(device.id, m.source.remotePath));
      return reply.redirect(`${u.pathname}${u.search}&download=1`);
    }
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(ref.file)}`);
    return sendRange(req, reply, m.source.input, 'application/octet-stream');
  });

  app.get<IdParams>('/api/devices/:id/media/thumb', async (req, reply) => {
    const { device, state } = ctxFor(req.params.id);
    const file = await media.thumbnail(device, state, clipRef(req));
    return sendJpeg(reply, file, true);
  });

  app.get<IdParams>('/api/devices/:id/media/frame', async (req, reply) => {
    const { device, state } = ctxFor(req.params.id);
    const q = req.query as Record<string, string>;
    const file = await media.frame(device, state, clipRef(req), Number(q.frame) || 0, Number(q.h) || 540);
    return sendJpeg(reply, file, true);
  });

  app.get<IdParams>('/api/devices/:id/media/strip', async (req) => {
    const { device, state } = ctxFor(req.params.id);
    return media.strip(device, state, clipRef(req));
  });

  app.get<{ Params: { key: string; index: string } }>('/api/media/strip/:key/:index', async (req, reply) => {
    if (!/^[0-9a-f]{20}$/.test(req.params.key)) throw new ValidationError('bad key');
    const file = media.stripTilePath(req.params.key, Number(req.params.index));
    if (!file) return reply.status(404).send({ error: 'not ready' });
    return sendJpeg(reply, file, true);
  });

  app.post<IdParams>('/api/devices/:id/media/proxy', async (req) => {
    const { device, state } = ctxFor(req.params.id);
    const b = req.body as { slot: number; file: string };
    return media.startProxy(device, state, { slotId: Number(b.slot), file: b.file });
  });

  app.delete<{ Params: { key: string } }>('/api/media/proxy/:key', async (req, reply) => {
    media.cancelProxy(req.params.key);
    reply.status(204);
  });

  app.get<{ Params: { key: string } }>('/api/media/proxy/:key/video.mp4', async (req, reply) => {
    if (!/^[0-9a-f]{20}$/.test(req.params.key)) throw new ValidationError('bad key');
    const file = media.proxyPath(req.params.key);
    if (!file) return reply.status(404).send({ error: 'proxy not ready' });
    return sendRange(req, reply, file, 'video/mp4');
  });
}

function sendJpeg(reply: FastifyReply, file: string, immutable: boolean) {
  reply.header('Content-Type', 'image/jpeg');
  if (immutable) reply.header('Cache-Control', 'private, max-age=86400');
  return reply.send(fs.createReadStream(file));
}

function sendRange(req: FastifyRequest, reply: FastifyReply, file: string, type: string) {
  const size = fs.statSync(file).size;
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', type);
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (!range) {
    reply.header('Content-Length', size);
    return reply.send(fs.createReadStream(file));
  }
  let start = range[1] ? Number(range[1]) : size - Number(range[2]);
  let end = range[1] && range[2] ? Number(range[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (start > end) return reply.status(416).header('Content-Range', `bytes */${size}`).send();
  reply.status(206);
  reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
  reply.header('Content-Length', end - start + 1);
  return reply.send(fs.createReadStream(file, { start, end }));
}
