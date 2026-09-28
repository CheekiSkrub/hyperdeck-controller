import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * A network share the HyperDeck records to (SMB/AFP/NFS). HyperDeck FTP does not
 * expose network storage, so for clips living there the server reads the share
 * directly. On Windows a UNC path (\\server\share) works without mounting; on
 * macOS/Linux the share must be mounted and `localPath` points at the mount.
 */
export interface ShareMapping {
  id: string;
  /** Friendly label, e.g. "Studio NAS". */
  label: string;
  /** URL the HyperDeck uses, e.g. smb://nas.local/Recordings (used for auto-matching). */
  url?: string;
  /** Where this server can read the same files: UNC path, /Volumes/..., /mnt/... */
  localPath: string;
  /** Credentials for this server's own connection to the share (separate from the deck's own NAS bookmark credentials). */
  username?: string;
  password?: string;
}

export interface FtpSettings {
  enabled: boolean;
  port: number;
  user: string;
  password: string;
}

export interface Device {
  id: string;
  name: string;
  host: string;
  /** Ethernet protocol port (9993). */
  port: number;
  /** REST API port (80) — used for codec lists, audio format, monitoring. */
  restPort: number;
  ftp: FtpSettings;
  shares: ShareMapping[];
  createdAt: string;
  /** True for a simulated HyperDeck created from "+ Add test HyperDeck" (server/src/devices/testDeck.ts). */
  test?: boolean;
}

export type DeviceInput = Partial<Omit<Device, 'id' | 'createdAt'>> & { name?: string; host?: string; id?: string };

export class ValidationError extends Error {}

const HOSTNAME = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/;

export function validateHost(host: string): string {
  const h = host.trim();
  if (!h) throw new ValidationError('IP address is required');
  if (net.isIP(h) || HOSTNAME.test(h)) return h;
  throw new ValidationError(`"${host}" is not a valid IP address or hostname`);
}

function validPort(p: unknown, fallback: number): number {
  const n = Number(p ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ValidationError(`Invalid port ${p}`);
  return n;
}

export class DeviceStore {
  private devices: Device[] = [];
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'devices.json');
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      this.devices = (JSON.parse(fs.readFileSync(this.file, 'utf8')) as Device[]).map((d) => ({ ...d, restPort: d.restPort ?? 80 }));
    } catch {
      this.devices = [];
    }
  }

  list(): Device[] {
    return this.devices;
  }

  get(id: string): Device | undefined {
    return this.devices.find((d) => d.id === id);
  }

  create(input: DeviceInput): Device {
    const name = (input.name ?? '').trim();
    if (!name) throw new ValidationError('Name is required');
    const host = validateHost(input.host ?? '');
    const d: Device = {
      id: input.id ?? crypto.randomUUID(),
      name,
      host,
      port: validPort(input.port, 9993),
      restPort: validPort(input.restPort, 80),
      ftp: this.normaliseFtp(input.ftp),
      shares: this.normaliseShares(input.shares),
      createdAt: new Date().toISOString(),
      test: Boolean(input.test),
    };
    this.devices.push(d);
    this.save();
    return d;
  }

  update(id: string, input: DeviceInput): Device {
    const d = this.get(id);
    if (!d) throw new ValidationError('Device not found');
    if (input.name !== undefined) {
      if (!input.name.trim()) throw new ValidationError('Name is required');
      d.name = input.name.trim();
    }
    if (input.host !== undefined) d.host = validateHost(input.host);
    if (input.port !== undefined) d.port = validPort(input.port, 9993);
    if (input.restPort !== undefined) d.restPort = validPort(input.restPort, 80);
    if (input.ftp !== undefined) d.ftp = this.normaliseFtp({ ...d.ftp, ...input.ftp });
    if (input.shares !== undefined) d.shares = this.normaliseShares(input.shares);
    this.save();
    return d;
  }

  remove(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length !== before) this.save();
    return this.devices.length !== before;
  }

  private normaliseFtp(f?: Partial<FtpSettings>): FtpSettings {
    return {
      enabled: f?.enabled ?? true,
      port: validPort(f?.port, 21),
      user: f?.user ?? 'anonymous',
      password: f?.password ?? '',
    };
  }

  private normaliseShares(shares?: Partial<ShareMapping>[]): ShareMapping[] {
    return (shares ?? []).map((s) => {
      if (!s.localPath?.trim()) throw new ValidationError('Share needs a local path this server can read');
      return {
        id: s.id ?? crypto.randomUUID(),
        label: s.label?.trim() || s.url || s.localPath!,
        url: s.url?.trim() || undefined,
        localPath: s.localPath!.trim(),
        username: s.username?.trim() || undefined,
        password: s.password || undefined,
      };
    });
  }

  private save(): void {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.devices, null, 2));
    fs.renameSync(this.file + '.tmp', this.file);
  }
}
