import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'HyperDeck Controller';

/** Per-OS data directory for settings and device list. */
export function defaultDataDir(): string {
  if (process.env.HDC_DATA_DIR) return process.env.HDC_DATA_DIR;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'HyperDeckController');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'HyperDeckController');
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'hyperdeck-controller');
  }
}

/** Per-OS cache directory for thumbnails, filmstrips and proxies. */
export function defaultCacheDir(): string {
  if (process.env.HDC_CACHE_DIR) return process.env.HDC_CACHE_DIR;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'HyperDeckController', 'Cache');
    case 'darwin':
      return path.join(home, 'Library', 'Caches', 'HyperDeckController');
    default:
      return path.join(process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'hyperdeck-controller');
  }
}

export interface Settings {
  /** HTTP port for the control panel. */
  port: number;
  /** Interface to bind; 0.0.0.0 makes the panel reachable on the LAN. */
  host: string;
  /** Optional explicit ffmpeg / ffprobe paths (otherwise bundled or PATH). */
  ffmpegPath?: string;
  ffprobePath?: string;
  cacheDir: string;
  /** Soft cache limit; oldest proxies/frames are evicted beyond this. */
  maxCacheGB: number;
  /** Max concurrent ffmpeg jobs per device (HyperDeck FTP is not fast). */
  mediaConcurrency: number;
  /** Proxy transcode height in pixels. */
  proxyHeight: number;
  /** Open the panel in the default browser on start. */
  openBrowser: boolean;
}

export function loadSettings(dataDir: string): Settings {
  const defaults: Settings = {
    port: Number(process.env.HDC_PORT ?? 8080),
    host: process.env.HDC_HOST ?? '0.0.0.0',
    cacheDir: defaultCacheDir(),
    maxCacheGB: 20,
    mediaConcurrency: 2,
    proxyHeight: 540,
    openBrowser: process.env.HDC_NO_BROWSER ? false : true,
  };
  const file = path.join(dataDir, 'settings.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>;
    return { ...defaults, ...saved, ...(process.env.HDC_PORT ? { port: defaults.port } : {}) };
  } catch {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

export function saveSettings(dataDir: string, s: Settings): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'settings.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(s, null, 2));
  fs.renameSync(file + '.tmp', file);
}
