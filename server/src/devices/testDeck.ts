import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createMockDeck, type MockDeck } from '../testdeck/mockDeck.js';
import type { DeviceManager } from './manager.js';
import type { Device, DeviceStore } from './store.js';

/**
 * Simulated HyperDecks created from the panel ("+ Add test HyperDeck"), for
 * trying out the app or testing workflows without real hardware. Each one is
 * a real Ethernet-protocol + FTP + REST server (server/src/testdeck/mockDeck.ts)
 * running in this process on loopback-only ephemeral ports, wired up as an
 * ordinary Device (`test: true`) so the rest of the app treats it exactly
 * like a real deck.
 *
 * Test devices are still listed in devices.json (so they survive a restart
 * along with their id and any UI state), but their mock server is not — it's
 * restarted on the same address/ports when the app starts back up.
 */
export class TestDeckManager {
  private mocks = new Map<string, MockDeck>();

  constructor(
    private readonly store: DeviceStore,
    private readonly devices: DeviceManager,
    private readonly cacheDir: string,
    private readonly ffmpeg: () => { ffmpeg: string; ffprobe: string; ok: boolean },
  ) {}

  /** Restart the mock server for every persisted test device. Call once at startup. */
  async restoreAll(): Promise<void> {
    for (const d of this.store.list()) {
      if (!d.test) continue;
      const ff = this.ffmpeg();
      if (!ff.ok) {
        console.warn(`[testdeck] ffmpeg/ffprobe not available — "${d.name}" will stay disconnected until it's removed and re-added`);
        continue;
      }
      try {
        const mock = await createMockDeck({
          host: '127.0.0.1',
          port: d.port,
          ftpPort: d.ftp.port,
          restPort: d.restPort,
          mediaDir: this.mediaDir(d.id),
          ffmpeg: ff.ffmpeg,
          ffprobe: ff.ffprobe,
        });
        this.mocks.set(d.id, mock);
      } catch (e) {
        console.warn(`[testdeck] couldn't restart simulated deck "${d.name}": ${(e as Error).message}`);
      }
    }
  }

  /** Create a new simulated HyperDeck and register it as a device. */
  async create(name?: string): Promise<Device> {
    const ff = this.ffmpeg();
    if (!ff.ok) throw new Error('ffmpeg/ffprobe are required to create a test HyperDeck');
    const id = crypto.randomUUID();
    const mock = await createMockDeck({
      host: '127.0.0.1',
      mediaDir: this.mediaDir(id),
      ffmpeg: ff.ffmpeg,
      ffprobe: ff.ffprobe,
    });
    try {
      const device = this.devices.create({
        name: (name?.trim() || this.nextName()),
        host: '127.0.0.1',
        port: mock.port,
        restPort: mock.restPort,
        ftp: { enabled: true, port: mock.ftpPort, user: 'anonymous', password: '' },
        shares: [{ label: 'Simulated NAS', localPath: mock.nasDir }],
        test: true,
      } as Parameters<DeviceManager['create']>[0]);
      // The device's real id (assigned by the store) differs from the id we generated
      // the media folder under — move the folder so a restart finds it again.
      const finalDir = this.mediaDir(device.id);
      if (finalDir !== this.mediaDir(id) && fs.existsSync(this.mediaDir(id))) {
        fs.mkdirSync(path.dirname(finalDir), { recursive: true });
        fs.renameSync(this.mediaDir(id), finalDir);
      }
      this.mocks.set(device.id, mock);
      return device;
    } catch (e) {
      await mock.stop().catch(() => {});
      throw e;
    }
  }

  /** Stop and discard the mock server backing a test device, if any. Safe to call for non-test devices. */
  async stop(deviceId: string): Promise<void> {
    const mock = this.mocks.get(deviceId);
    if (!mock) return;
    this.mocks.delete(deviceId);
    await mock.stop().catch(() => {});
    fs.rmSync(this.mediaDir(deviceId), { recursive: true, force: true });
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.mocks.values()].map((m) => m.stop().catch(() => {})));
  }

  private mediaDir(id: string): string {
    return path.join(this.cacheDir, 'test-decks', id);
  }

  private nextName(): string {
    const used = new Set(this.store.list().filter((d) => d.test).map((d) => d.name));
    let n = 1;
    while (used.has(`Test HyperDeck ${n}`)) n++;
    return `Test HyperDeck ${n}`;
  }
}
