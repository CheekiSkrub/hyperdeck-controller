import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client as FtpClient, type FileInfo } from 'basic-ftp';
import type { Device, ShareMapping } from '../devices/store.js';
import type { HyperDeckState } from '../hyperdeck/client.js';
import type { FtpBridge } from './ftpBridge.js';

const execFileAsync = promisify(execFile);

export interface MediaSource {
  kind: 'ftp' | 'share';
  /** What ffmpeg opens: the local HTTP->FTP bridge URL or a local/UNC path. */
  input: string;
  /** Path on the HyperDeck FTP server (ftp sources only). */
  remotePath?: string;
  /** Human readable location for the UI. */
  display: string;
  size?: number;
  modifiedAt?: string;
  shareId?: string;
}

interface IndexedFile {
  path: string; // path relative to FTP root / share root, "/" separated
  size: number;
  modifiedAt?: string;
}

const MEDIA_EXT = /\.(mov|mp4|mxf|m4v)$/i;
const INDEX_TTL = 20_000;

/**
 * Finds where a clip reported by the HyperDeck can actually be read from.
 *
 * - Internal media (SSD/SD/CFast/USB) is exposed by the HyperDeck's own FTP
 *   server; folder names vary by model (ssd1, sd1, cfast1, usb/<drive>) so we
 *   index the FTP tree and match on file name.
 * - Network storage is NOT on the HyperDeck FTP. When the deck records to an
 *   SMB/AFP share we read the share directly through a mapping configured on
 *   the device (UNC path on Windows, mount point on macOS/Linux).
 */
export class MediaLocator {
  private ftpIndex = new Map<string, { at: number; files: Map<string, IndexedFile>; promise?: Promise<void> }>();
  private shareIndex = new Map<string, { at: number; files: Map<string, IndexedFile> }>();

  constructor(private readonly bridge: FtpBridge) {}

  invalidate(deviceId: string): void {
    this.ftpIndex.delete(deviceId);
    for (const k of this.shareIndex.keys()) if (k.startsWith(deviceId + ':')) this.shareIndex.delete(k);
  }

  /** Is the given slot network storage rather than a local disk? */
  isNetworkSlot(device: Device, state: HyperDeckState, slotId: number): boolean {
    const slot = state.slots.find((s) => s.slotId === slotId);
    const label = `${slot?.slotName ?? ''} ${slot?.deviceName ?? ''}`;
    if (/\b(nas|network|smb|afp|nfs)\b/i.test(label)) return true;
    // Slots beyond the physical ones with a NAS selected are treated as network.
    return Boolean(state.nasUrl) && slotId > (state.info?.slotCount ?? 2);
  }

  async resolve(device: Device, state: HyperDeckState, slotId: number, fileName: string): Promise<MediaSource> {
    const network = this.isNetworkSlot(device, state, slotId);
    const shares = this.orderedShares(device, state);
    const tried: string[] = [];

    const tryShares = async () => {
      for (const share of shares) {
        const hit = await this.findOnShare(device, share, fileName);
        if (hit) return hit;
        tried.push(`share "${share.label}"`);
      }
      return null;
    };
    const tryFtp = async () => {
      if (!device.ftp.enabled) return null;
      const hit = await this.findOnFtp(device, state, slotId, fileName);
      if (!hit) tried.push('HyperDeck FTP');
      return hit;
    };

    const order = network ? [tryShares, tryFtp] : [tryFtp, tryShares];
    for (const fn of order) {
      try {
        const hit = await fn();
        if (hit) return hit;
      } catch (e) {
        tried.push(`(${(e as Error).message})`);
      }
    }
    const hint = network && shares.length === 0
      ? ' This clip is on network storage — add a share mapping for this device so the server can read it directly.'
      : '';
    throw new Error(`Could not find "${fileName}" (looked in ${tried.join(', ') || 'nowhere'}).${hint}`);
  }

  /** Shares whose URL matches the deck's selected NAS come first. */
  private orderedShares(device: Device, state: HyperDeckState): ShareMapping[] {
    const nas = normaliseShareUrl(state.nasUrl);
    return [...device.shares].sort((a, b) => {
      const am = nas && normaliseShareUrl(a.url) === nas ? 0 : 1;
      const bm = nas && normaliseShareUrl(b.url) === nas ? 0 : 1;
      return am - bm;
    });
  }

  // --------------------------------------------------------------------------- FTP

  ftpUrl(device: Device, remotePath: string): string {
    return this.bridge.url(device.id, remotePath);
  }

  private async findOnFtp(device: Device, state: HyperDeckState, slotId: number, fileName: string): Promise<MediaSource | null> {
    const files = await this.getFtpIndex(device);
    const matches = [...files.values()].filter((f) => path.posix.basename(f.path).toLowerCase() === fileName.toLowerCase());
    if (matches.length === 0) return null;
    // If the same name exists on several media, prefer the folder that looks like this slot.
    const slot = state.slots.find((s) => s.slotId === slotId);
    const hints = [slot?.slotName, slot?.deviceName, slot?.volumeName, `ssd${slotId}`, `sd${slotId}`, `cfast${slotId}`]
      .filter(Boolean).map((h) => h!.toLowerCase());
    const best = matches.find((m) => hints.some((h) => m.path.toLowerCase().split('/').includes(h))) ?? matches[0];
    return {
      kind: 'ftp',
      input: this.ftpUrl(device, best.path),
      remotePath: best.path,
      display: `ftp://${device.host}${best.path}`,
      size: best.size,
      modifiedAt: best.modifiedAt,
    };
  }

  async getFtpIndex(device: Device, force = false): Promise<Map<string, IndexedFile>> {
    let entry = this.ftpIndex.get(device.id);
    if (entry && !force && Date.now() - entry.at < INDEX_TTL) return entry.files;
    if (entry?.promise) {
      await entry.promise;
      return this.ftpIndex.get(device.id)!.files;
    }
    const files = new Map<string, IndexedFile>();
    const promise = (async () => {
      const client = new FtpClient(15000);
      try {
        await client.access({ host: device.host, port: device.ftp.port, user: device.ftp.user || 'anonymous', password: device.ftp.password || '', secure: false });
        await walkFtp(client, '/', 0, files);
      } finally {
        client.close();
      }
    })();
    this.ftpIndex.set(device.id, { at: entry?.at ?? 0, files: entry?.files ?? new Map(), promise });
    try {
      await promise;
      this.ftpIndex.set(device.id, { at: Date.now(), files });
    } catch (e) {
      this.ftpIndex.set(device.id, { at: 0, files: entry?.files ?? new Map() });
      throw new Error(`FTP ${device.host}: ${(e as Error).message}`);
    }
    return files;
  }

  // --------------------------------------------------------------------------- Shares

  private async findOnShare(device: Device, share: ShareMapping, fileName: string): Promise<MediaSource | null> {
    // Fast path: file sits at the share root (HyperDeck default).
    const direct = path.join(share.localPath, fileName);
    const st = await fs.promises.stat(direct).catch(() => null);
    if (st?.isFile()) return shareSource(share, direct, st);

    const key = `${device.id}:${share.id}`;
    let idx = this.shareIndex.get(key);
    if (!idx || Date.now() - idx.at > INDEX_TTL) {
      const files = new Map<string, IndexedFile>();
      await walkLocal(share.localPath, '', 0, files);
      idx = { at: Date.now(), files };
      this.shareIndex.set(key, idx);
    }
    const hit = [...idx.files.values()].find((f) => path.basename(f.path).toLowerCase() === fileName.toLowerCase());
    if (!hit) return null;
    const full = path.join(share.localPath, hit.path);
    const st2 = await fs.promises.stat(full).catch(() => null);
    return st2 ? shareSource(share, full, st2) : null;
  }

  /**
   * Authenticate this server's own connection to a share, using the
   * credentials stored on the mapping (separate from whatever credentials the
   * HyperDeck itself uses for its NAS bookmark — this server reads the share
   * over its own network path, typically a UNC path or a mount point).
   *
   * Only automated on Windows so far (`net use`, since `localPath` there is
   * normally a UNC path already and no mount point needs creating). On
   * macOS/Linux the share still needs to be mounted outside the app first
   * (Finder / an fstab entry) — see docs/RUNNING.txt.
   */
  async connectShare(share: ShareMapping): Promise<{ ok: boolean; message: string }> {
    if (!share.username) return { ok: false, message: 'No username set on this share — nothing to connect with.' };
    if (process.platform !== 'win32') {
      return { ok: false, message: `Automatic connection isn't supported on ${process.platform} yet — mount the share first (Finder, or an fstab/cifs entry), then Test.` };
    }
    if (!/^\\\\/.test(share.localPath)) {
      return { ok: false, message: `"${share.localPath}" isn't a UNC path (\\\\server\\share) — net use needs one to attach credentials to.` };
    }
    // \\server\share\sub\folder -> \\server\share (net use authenticates the share, not a subfolder).
    const m = /^(\\\\[^\\]+\\[^\\]+)/.exec(share.localPath);
    const target = m ? m[1] : share.localPath;
    try {
      await execFileAsync('net', ['use', target, '/delete', '/y']).catch(() => {}); // drop any stale/mismatched session first
      await execFileAsync('net', ['use', target, share.password ?? '', `/user:${share.username}`, '/persistent:no']);
      return { ok: true, message: `Connected to ${target} as ${share.username}` };
    } catch (e) {
      const msg = ((e as { stderr?: string; message: string }).stderr || (e as Error).message).trim();
      return { ok: false, message: `net use failed: ${msg}` };
    }
  }

  /** Diagnostics for the settings UI. */
  async testShare(share: ShareMapping): Promise<{ ok: boolean; message: string; mediaFiles?: number }> {
    try {
      const st = await fs.promises.stat(share.localPath);
      if (!st.isDirectory()) return { ok: false, message: 'Path exists but is not a folder' };
      const files = new Map<string, IndexedFile>();
      await walkLocal(share.localPath, '', 0, files);
      return { ok: true, message: `Readable — ${files.size} media file(s) found`, mediaFiles: files.size };
    } catch (e) {
      return { ok: false, message: `Cannot read ${share.localPath}: ${(e as Error).message}. Is the share mounted on this server?` };
    }
  }

  async testFtp(device: Device): Promise<{ ok: boolean; message: string; mediaFiles?: number; folders?: string[] }> {
    try {
      const files = await this.getFtpIndex(device, true);
      const folders = [...new Set([...files.values()].map((f) => path.posix.dirname(f.path)))];
      return { ok: true, message: `Connected — ${files.size} media file(s)`, mediaFiles: files.size, folders };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}

function shareSource(share: ShareMapping, full: string, st: fs.Stats): MediaSource {
  return {
    kind: 'share', input: full, display: full, size: st.size, modifiedAt: st.mtime.toISOString(), shareId: share.id,
  };
}

async function walkFtp(client: FtpClient, dir: string, depth: number, out: Map<string, IndexedFile>): Promise<void> {
  if (depth > 3) return;
  let list: FileInfo[];
  try {
    list = await client.list(dir);
  } catch {
    return;
  }
  for (const f of list) {
    if (f.name === '.' || f.name === '..' || f.name.startsWith('.')) continue;
    const p = path.posix.join(dir, f.name);
    if (f.isDirectory) await walkFtp(client, p, depth + 1, out);
    else if (MEDIA_EXT.test(f.name)) out.set(p, { path: p, size: f.size, modifiedAt: f.modifiedAt?.toISOString() ?? f.rawModifiedAt });
  }
}

async function walkLocal(root: string, rel: string, depth: number, out: Map<string, IndexedFile>): Promise<void> {
  if (depth > 3) return;
  const entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) await walkLocal(root, r, depth + 1, out).catch(() => {});
    else if (MEDIA_EXT.test(e.name)) out.set(r, { path: r, size: 0 });
  }
}

export function normaliseShareUrl(url?: string | null): string | null {
  if (!url) return null;
  return url.trim().replace(/^(smb|afp|cifs|nfs):\/\//i, '//').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
