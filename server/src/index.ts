import { exec } from 'node:child_process';
import os from 'node:os';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { APP_NAME, defaultDataDir, loadSettings } from './config.js';
import { DeviceManager } from './devices/manager.js';
import { DeviceStore } from './devices/store.js';
import { configureFfmpeg } from './media/ffmpeg.js';
import { FtpBridge } from './media/ftpBridge.js';
import { MediaLocator } from './media/locator.js';
import { MediaService } from './media/service.js';
import { registerApi } from './routes/api.js';
import { registerStatic } from './static.js';

declare const __APP_VERSION__: string | undefined;
const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';

async function main() {
  const dataDir = defaultDataDir();
  const settings = loadSettings(dataDir);
  const ff = configureFfmpeg(settings);
  if (!ff.ok) console.warn(`[media] ffmpeg/ffprobe not found (${ff.ffmpeg}). Thumbnails and scrubbing will be unavailable.`);

  const store = new DeviceStore(dataDir);
  const devices = new DeviceManager(store);
  const bridge = new FtpBridge();
  bridge.setPort(settings.port);
  const locator = new MediaLocator(bridge);
  const media = new MediaService(locator, settings.cacheDir, {
    concurrency: settings.mediaConcurrency, proxyHeight: settings.proxyHeight, maxCacheGB: settings.maxCacheGB,
  });

  const app = Fastify({ logger: { level: process.env.HDC_LOG ?? 'warn' }, bodyLimit: 1024 * 1024 });
  await app.register(websocket);

  // ---------------------------------------------------------------- WebSocket push
  const sockets = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) if (ws.readyState === 1) ws.send(s);
  };
  devices.on('state', (id: string, state) => broadcast({ type: 'state', id, state }));
  devices.on('transport', (id: string, transport) => broadcast({ type: 'transport', id, transport }));
  devices.on('devices', () => broadcast({ type: 'devices', devices: devices.list() }));
  media.on('strip', (e) => broadcast({ type: 'strip', ...e }));
  media.on('proxy', (e) => broadcast({ type: 'proxy', ...e }));

  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket) => {
      sockets.add(socket);
      socket.send(JSON.stringify({ type: 'devices', devices: devices.list() }));
      socket.on('close', () => sockets.delete(socket));
    });
  });

  bridge.register(app, (id) => store.get(id));
  await registerApi(app, { devices, media, locator, bridge, settings, dataDir, version: VERSION, ffmpegOk: ff.ok });
  registerStatic(app);

  await app.listen({ port: settings.port, host: settings.host });
  const urls = lanUrls(settings.port);
  console.log(`\n  ${APP_NAME} ${VERSION}\n  Control panel:\n${urls.map((u) => `    ${u}`).join('\n')}\n  Data: ${dataDir}\n`);

  if (settings.openBrowser && !process.env.HDC_NO_BROWSER) openBrowser(`http://localhost:${settings.port}`);

  const shutdown = async () => {
    devices.shutdown();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function lanUrls(port: number): string[] {
  const out = [`http://localhost:${port}`];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${port}`);
  }
  return out;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
