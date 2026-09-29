import fs from 'node:fs';
import type { BuildInfo } from '../buildInfo.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { saveSettings, type Settings } from '../config.js';
import { EditError, validateEdit, type EditEntry } from '../devices/edit.js';
import type { LibraryStore } from '../devices/library.js';
import { CommandError, type DeviceManager } from '../devices/manager.js';
import { ValidationError, type DeviceInput } from '../devices/store.js';
import type { TestDeckManager } from '../devices/testDeck.js';
import type { CredentialStore } from '../devices/credentials.js';
import type { TimelineStore } from '../devices/timelines.js';
import { ffmpegPaths, spawnLive } from '../media/ffmpeg.js';
import type { FtpBridge } from '../media/ftpBridge.js';
import { normaliseShareUrl, type MediaLocator } from '../media/locator.js';
import type { ClipRef, MediaService } from '../media/service.js';

interface Ctx {
  devices: DeviceManager;
  testDecks: TestDeckManager;
  timelines: TimelineStore;
  library: LibraryStore;
  credentials: CredentialStore;
  media: MediaService;
  locator: MediaLocator;
  bridge: FtpBridge;
  settings: Settings;
  dataDir: string;
  version: string;
  build: BuildInfo;
  ffmpegOk: boolean;
}

type IdParams = { Params: { id: string } };

export async function registerApi(app: FastifyInstance, ctx: Ctx) {
  const { devices, media, locator } = ctx;

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof ValidationError ? 400 : err instanceof CommandError ? err.status : err.statusCode ?? 500;
    reply.status(status).send({ error: err.message, code: err instanceof CommandError ? err.code : undefined });
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
    commit: ctx.build.commit,
    builtAt: ctx.build.builtAt,
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

  // ------------------------------------------------------------------ Saved NAS credentials
  // A reusable "fill in the username/password" list, shared across every device's share
  // mappings and NAS bookmarks — not a live link, just saves retyping the same login.

  app.get('/api/credentials', async () => ctx.credentials.list());
  app.post('/api/credentials', async (req, reply) => {
    const c = ctx.credentials.create(req.body as { label?: string; username?: string; password?: string });
    reply.status(201);
    return c;
  });
  app.patch<{ Params: { id: string } }>('/api/credentials/:id', async (req) =>
    ctx.credentials.update(req.params.id, req.body as { label?: string; username?: string; password?: string; path?: string }));
  app.delete<{ Params: { id: string } }>('/api/credentials/:id', async (req, reply) => {
    ctx.credentials.remove(req.params.id);
    reply.status(204);
  });
  // Actually connect with a saved credential and list what's at its path, rather than just checking it's filled in.
  app.post<{ Params: { id: string } }>('/api/credentials/:id/test', async (req) => {
    const c = ctx.credentials.get(req.params.id);
    if (!c) throw new ValidationError('Saved credential not found');
    return locator.testPath(c.path ?? '', c.username, c.password);
  });

  // ------------------------------------------------------------------ Devices CRUD

  app.get('/api/devices', async () => devices.list());
  app.post('/api/devices', async (req, reply) => {
    const d = devices.create(req.body as DeviceInput);
    reply.status(201);
    return d;
  });
  // A simulated HyperDeck for trying the app out or testing without real hardware.
  app.post('/api/devices/test', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string };
    const d = await ctx.testDecks.create(b.name);
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
    await ctx.testDecks.stop(req.params.id);
    devices.remove(req.params.id);
    media.invalidate(req.params.id);
    ctx.timelines.removeForDevice(req.params.id);
    ctx.library.removeForDevice(req.params.id);
    reply.status(204);
  });

  // ------------------------------------------------------------------ Control

  app.post<IdParams>('/api/devices/:id/command', async (req) => {
    const { command, params } = req.body as { command: string; params?: Record<string, string | number | boolean> };
    return devices.command(req.params.id, command, params);
  });

  app.get<IdParams>('/api/devices/:id/settings', async (req) => devices.settings(req.params.id));
  app.post<IdParams>('/api/devices/:id/settings', async (req) => {
    const b = req.body as { id: string; value: unknown };
    if (typeof b?.id !== 'string') throw new ValidationError('id is required');
    return devices.setSetting(req.params.id, b.id, b.value);
  });
  app.post<{ Params: { id: string; action: string } }>('/api/devices/:id/actions/:action', async (req) =>
    devices.action(req.params.id, req.params.action, (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/probe', async (req) => {
    const b = req.body as { host: string; port?: number };
    if (!b?.host) throw new ValidationError('host is required');
    return devices.probe(String(b.host).trim(), Number(b.port) || 9993);
  });

  app.get<IdParams>('/api/devices/:id/debug/protocol', async (req, reply) =>
    reply.type('text/plain').send(devices.client(req.params.id).trace.join('\n')));

  app.put<IdParams>('/api/devices/:id/edit', async (req) => {
    const result = await devices.setEdit(req.params.id, (req.body as { entries: unknown }).entries);
    // Keep the saved copy of the live timeline in step with the deck.
    const live = ctx.timelines.live(req.params.id);
    if (live) ctx.timelines.update(live.id, { entries: result });
    return result;
  });

  // ------------------------------------------------------------------ Saved timelines

  app.get<IdParams>('/api/devices/:id/timelines', async (req) => {
    // Other paths change the deck's timeline too (cueing a clip, instant replay, the deck's own
    // controls), so bring the live timeline's saved copy up to date whenever the list is read.
    const state = devices.client(req.params.id).state;
    const live = ctx.timelines.live(req.params.id);
    if (live && state.status === 'connected' && JSON.stringify(live.entries) !== JSON.stringify(state.edit)) {
      ctx.timelines.update(live.id, { entries: state.edit });
    }
    // The deck always has a timeline tab: adopt what's on it — "Timeline 1" on a first visit, or
    // "On deck" alongside timelines saved before one could be live. Done here, not in the panel,
    // so two browsers (or React's double-mount) can't both create one.
    if (!live) {
      const n = ctx.timelines.list(req.params.id).length;
      ctx.timelines.create(req.params.id, n ? 'On deck' : 'Timeline 1', state.edit, true);
    }
    return ctx.timelines.list(req.params.id);
  });

  app.post<IdParams>('/api/devices/:id/timelines', async (req, reply) => {
    const b = req.body as { name: string; entries?: EditEntry[]; live?: boolean };
    if (!b?.name) throw new ValidationError('Name is required');
    const entries = b.entries ? checkedEntries(req.params.id, b.entries) : devices.client(req.params.id).state.edit;
    const t = ctx.timelines.create(req.params.id, b.name, entries, Boolean(b.live));
    reply.status(201);
    return t;
  });

  app.patch<{ Params: { tid: string } }>('/api/timelines/:tid', async (req) => {
    const b = req.body as { name?: string; entries?: EditEntry[] };
    const t = ctx.timelines.get(req.params.tid);
    if (!t) throw new ValidationError('Saved timeline not found');
    return ctx.timelines.update(req.params.tid, { ...b, entries: b.entries ? checkedEntries(t.deviceId, b.entries) : undefined });
  });

  app.delete<{ Params: { tid: string } }>('/api/timelines/:tid', async (req, reply) => {
    ctx.timelines.remove(req.params.tid);
    reply.status(204);
  });

  app.post<{ Params: { tid: string } }>('/api/timelines/:tid/load', async (req) => {
    const t = ctx.timelines.get(req.params.tid);
    if (!t) throw new ValidationError('Saved timeline not found');
    const result = await devices.setEdit(t.deviceId, t.entries);
    ctx.timelines.setLive(t.id);
    ctx.timelines.update(t.id, { entries: result });
    return result;
  });

  /**
   * Staged timelines get the same checks as the deck's (clips on the active media, one video
   * format), so a problem shows up while cueing it up rather than when it's sent to the deck.
   * Skipped while the deck is offline — there's nothing to check against.
   */
  function checkedEntries(deviceId: string, entries: EditEntry[]): EditEntry[] {
    const state = devices.client(deviceId).state;
    if (state.status !== 'connected' || !state.transport?.slotId) return entries;
    try {
      return validateEdit(entries, state);
    } catch (e) {
      if (e instanceof EditError) throw new CommandError(e.message, 409);
      throw e;
    }
  }

  // ------------------------------------------------------------------ Clip library (tags, groups)

  app.get<IdParams>('/api/devices/:id/library', async (req) => ctx.library.get(req.params.id));
  app.put<IdParams>('/api/devices/:id/library/tags', async (req) => {
    const b = req.body as { file: string; tags: string[] };
    return ctx.library.setTags(req.params.id, String(b?.file ?? ''), Array.isArray(b?.tags) ? b.tags.map(String) : []);
  });
  app.post<IdParams>('/api/devices/:id/library/groups', async (req) => {
    const b = req.body as { name: string; files?: string[] };
    return ctx.library.createGroup(req.params.id, String(b?.name ?? ''), Array.isArray(b?.files) ? b.files.map(String) : []);
  });
  app.patch<{ Params: { id: string; gid: string } }>('/api/devices/:id/library/groups/:gid', async (req) => {
    const b = req.body as { name?: string; add?: string[]; remove?: string[] };
    return ctx.library.updateGroup(req.params.id, req.params.gid, b ?? {});
  });
  app.delete<{ Params: { id: string; gid: string } }>('/api/devices/:id/library/groups/:gid', async (req) =>
    ctx.library.removeGroup(req.params.id, req.params.gid));

  // Instant replay: take the last N seconds of :id's current/most recent clip
  // and put it on another device's timeline (works when that device can also
  // see the file, e.g. both watching the same network share).
  app.post<IdParams>('/api/devices/:id/instant-replay', async (req) => {
    const b = req.body as { seconds: number; targetId: string; mode?: 'append' | 'replace' };
    if (!b?.targetId) throw new ValidationError('targetId is required');
    return devices.instantReplay(req.params.id, { seconds: Number(b.seconds) || 0, targetId: b.targetId, mode: b.mode === 'replace' ? 'replace' : 'append' });
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
    const b = req.body as { slotId: number; file: string; frame: number; play?: boolean; singleClip?: boolean; replace?: boolean };
    if (!Number.isInteger(b.slotId) || !b.file) throw new ValidationError('slotId and file are required');
    return devices.loadClip(req.params.id, { ...b, frame: Number(b.frame) || 0 });
  });

  // ------------------------------------------------------------------ Deck-side NAS bookmarks

  app.get<IdParams>('/api/devices/:id/nas/bookmarks', async (req) => devices.nasBookmarks(req.params.id));
  app.post<IdParams>('/api/devices/:id/nas/bookmarks', async (req, reply) => {
    const b = req.body as { url: string; username?: string; password?: string };
    await devices.addNasBookmark(req.params.id, b?.url ?? '', b?.username, b?.password);
    reply.status(201);
    return devices.nasBookmarks(req.params.id);
  });
  app.put<IdParams>('/api/devices/:id/nas/bookmarks', async (req) => {
    const b = req.body as { url: string; username?: string; password?: string };
    if (!b?.url) throw new ValidationError('url is required');
    await devices.setNasBookmarkCredentials(req.params.id, b.url, b.username, b.password);
    return devices.nasBookmarks(req.params.id);
  });
  app.post<IdParams>('/api/devices/:id/nas/bookmarks/remove', async (req) => {
    const b = req.body as { url: string };
    if (!b?.url) throw new ValidationError('url is required');
    await devices.removeNasBookmark(req.params.id, b.url);
    return devices.nasBookmarks(req.params.id);
  });
  app.get<IdParams>('/api/devices/:id/nas/selected', async (req) => ({ url: await devices.nasSelected(req.params.id) }));
  app.post<IdParams>('/api/devices/:id/nas/select', async (req) => {
    const b = (req.body ?? {}) as { url: string | null };
    await devices.selectNas(req.params.id, b.url ?? null);
    if (b.url) ensureShareForNasUrl(req.params.id, b.url);
    return { url: await devices.nasSelected(req.params.id) };
  });
  // Space on the mapped share behind the deck's network slot (null if none is mapped/reachable).
  app.get<IdParams>('/api/devices/:id/nas/space', async (req) => {
    const d = devices.get(req.params.id);
    const state = devices.client(d.id).state;
    const slot = state.slots.find((s) => locator.isNetworkSlot(d, state, s.slotId));
    if (!slot) return { slotId: null, space: null };
    const space = await locator.networkSpace(d, state);
    return { slotId: slot.slotId, space, error: space ? undefined : locator.lastSpaceError.get(d.id) };
  });
  app.get<IdParams>('/api/devices/:id/nas/discovered', async (req) => devices.nasDiscover(req.params.id));

  // ------------------------------------------------------------------ Media sources

  app.get<IdParams>('/api/devices/:id/sources/test', async (req) => {
    const d = devices.get(req.params.id);
    const ftp = d.ftp.enabled ? await locator.testFtp(d) : { ok: false, message: 'FTP disabled' };
    const shares = await Promise.all(d.shares.map(async (s) => ({ id: s.id, label: s.label, ...(await locator.testShare(s)) })));
    return { ftp, shares, nasUrl: devices.client(d.id).state.nasUrl };
  });

  // Authenticate this server's own connection to a share (separate from the deck's own NAS bookmark credentials).
  app.post<{ Params: { id: string; shareId: string } }>('/api/devices/:id/sources/:shareId/connect', async (req) => {
    const d = devices.get(req.params.id);
    const share = d.shares.find((s) => s.id === req.params.shareId);
    if (!share) throw new ValidationError('Share not found');
    return locator.connectShare(share);
  });

  // ------------------------------------------------------------------ Network drives
  // Browse a share/saved-credential's folder structure directly, independent of what the
  // HyperDeck itself reports as a slot — for exploring/verifying what's on a mapped NAS.

  app.get<IdParams>('/api/devices/:id/network-drives/sources', async (req) => {
    const d = devices.get(req.params.id);
    // A source that IS the deck's selected NAS gets the deck's network slot: files at its root can
    // be cued even when the deck's own disk list doesn't show them (`clips add` by name still works
    // — seen on a Shuttle HD whose disk list went empty while the share stayed readable).
    const state = devices.client(d.id).state;
    const nas = normaliseShareUrl(state.nasUrl);
    const netSlot = state.slots.find((s) => s.status === 'mounted' && locator.isNetworkSlot(d, state, s.slotId));
    const deckSlotId = (...paths: (string | undefined)[]) =>
      nas && netSlot && paths.some((p) => normaliseShareUrl(p) === nas) ? netSlot.slotId : undefined;
    const shareSources = d.shares.filter((s) => s.localPath.trim())
      .map((s) => ({ key: `share:${s.id}`, label: s.label, deckSlotId: deckSlotId(s.url, s.localPath) }));
    const credSources = ctx.credentials.list().filter((c) => c.path?.trim())
      .map((c) => ({ key: `credential:${c.id}`, label: c.label, deckSlotId: deckSlotId(c.path) }));
    return [...shareSources, ...credSources];
  });

  function resolveNetworkDriveSource(d: ReturnType<typeof devices.get>, key: string): { root: string; username?: string; password?: string } {
    const [kind, id] = (key ?? '').split(':');
    if (kind === 'share') {
      const share = d.shares.find((s) => s.id === id);
      if (!share) throw new ValidationError('Share not found');
      return { root: share.localPath, username: share.username, password: share.password };
    }
    if (kind === 'credential') {
      const c = ctx.credentials.get(id);
      if (!c) throw new ValidationError('Saved credential not found');
      return { root: c.path ?? '', username: c.username, password: c.password };
    }
    throw new ValidationError('Unknown network drive source');
  }

  /**
   * Selecting a NAS bookmark on the deck (above) is a DIFFERENT thing from this server having a
   * share mapping that can actually read that location's bytes — the deck's own credentials for
   * its NAS bookmark aren't necessarily anything this server can use, and clip playback/thumbnails
   * go through this server's share mappings, not the deck's bookmark. Without a matching share,
   * opening a clip that's genuinely on the newly-selected NAS fails with "Could not find ...".
   * If a saved NAS credential's path is the same location as the bookmark just selected, wire up
   * a share mapping from it automatically — the same login the user already verified with Test
   * on that credential — rather than making them re-enter it a third time as a device share.
   * Does nothing if a matching share already exists, or if no saved credential's path matches.
   */
  function ensureShareForNasUrl(deviceId: string, url: string) {
    const d = devices.get(deviceId);
    const norm = normaliseShareUrl(url);
    if (d.shares.some((s) => normaliseShareUrl(s.url) === norm || normaliseShareUrl(s.localPath) === norm)) return;
    const cred = ctx.credentials.list().find((c) => c.path?.trim() && normaliseShareUrl(c.path) === norm);
    if (!cred) return;
    devices.update(deviceId, {
      shares: [...d.shares, { label: `${cred.label} (auto)`, url, localPath: cred.path!, username: cred.username, password: cred.password }],
    } as Parameters<DeviceManager['update']>[1]);
  }

  app.post<IdParams>('/api/devices/:id/network-drives/browse', async (req) => {
    const d = devices.get(req.params.id);
    const b = req.body as { key: string; subPath?: string };
    const { root, username, password } = resolveNetworkDriveSource(d, b.key);
    return locator.browse(root, b.subPath, username, password);
  });

  app.get<IdParams>('/api/devices/:id/network-drives/thumb', async (req, reply) => {
    const d = devices.get(req.params.id);
    const q = req.query as Record<string, string>;
    const { root, username, password } = resolveNetworkDriveSource(d, q.key ?? '');
    if (!root.trim()) throw new ValidationError('No path configured for this source');
    if (username) await locator.ensureConnected(root, username, password);
    const abs = locator.resolveEntryPath(root, q.path ?? '');
    if (!abs) throw new ValidationError('That path is outside the mapped folder.');
    const file = await media.networkThumbnail(d.id, abs);
    return sendJpeg(reply, file, true);
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

  // Audio levels (waveform + VU meters): status starts the pass if needed; the levels are binary.
  app.get<IdParams>('/api/devices/:id/media/audio', async (req) => {
    const { device, state } = ctxFor(req.params.id);
    return media.audio(device, state, clipRef(req));
  });

  app.get<{ Params: { key: string } }>('/api/media/audio/:key', async (req, reply) => {
    if (!/^[0-9a-f]{20}$/.test(req.params.key)) throw new ValidationError('bad key');
    const file = media.audioPath(req.params.key);
    if (!file) return reply.status(404).send({ error: 'not ready' });
    // The key changes whenever the source file does, so the levels for a key never change.
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.type('application/octet-stream').send(await fs.promises.readFile(file));
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
