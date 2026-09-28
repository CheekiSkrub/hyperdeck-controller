import { EventEmitter } from 'node:events';
import net from 'node:net';
import { editFromState, type DerivedEntry } from '../devices/edit.js';
import {
  buildCommand, parseClipsGet, parseDiskList, parseSlotInfo, parseTransportInfo, ResponseParser,
  type DiskClip, type HyperDeckResponse, type SlotInfo, type TimelineClip, type TransportInfo,
} from './protocol.js';

export const HYPERDECK_PORT = 9993;

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export class HyperDeckError extends Error {
  constructor(public readonly code: number, public readonly text: string, public readonly command: string) {
    super(`HyperDeck ${code} ${text} (command: ${command.trim()})`);
  }
}

export interface DeviceInfo {
  protocolVersion?: string;
  model?: string;
  uniqueId?: string;
  slotCount: number;
  softwareVersion?: string;
  name?: string;
}

export interface HyperDeckState {
  status: ConnectionStatus;
  lastError?: string;
  info: DeviceInfo | null;
  transport: TransportInfo | null;
  slots: SlotInfo[];
  /** Files on each slot, from "disk list". Keyed by slot id. */
  disks: Record<number, DiskClip[]>;
  /** Current timeline (what the deck will play), from "clips get". */
  timeline: TimelineClip[];
  remote: { enabled: boolean; override: boolean } | null;
  /** URL of the currently selected network storage, if any. */
  nasUrl: string | null;
  /** The timeline as an edit list (file + frame in/out per entry). */
  edit: DerivedEntry[];
}

interface Pending {
  cmd: string;
  resolve: (r: HyperDeckResponse) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

/**
 * A resilient connection to one HyperDeck. Commands are serialised (the deck
 * answers in order, one at a time); asynchronous 5xx notifications update the
 * cached state and emit a "state" event.
 */
export class HyperDeckClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private parser = new ResponseParser((r) => this.onResponse(r));
  private queue: Pending[] = [];
  private inFlight: Pending | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private closed = false;
  private stateTimer: NodeJS.Timeout | null = null;
  private transportTimer: NodeJS.Timeout | null = null;
  private lastTransportEmit = 0;

  readonly state: HyperDeckState = {
    status: 'disconnected', info: null, transport: null, slots: [], disks: {}, timeline: [], remote: null, nasUrl: null, edit: [],
  };

  constructor(public host: string, public port = HYPERDECK_PORT) {
    super();
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  /** Change address (e.g. device edited) and reconnect. */
  setAddress(host: string, port = HYPERDECK_PORT): void {
    if (host === this.host && port === this.port) return;
    this.host = host;
    this.port = port;
    this.socket?.destroy();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.socket?.destroy();
    this.socket = null;
  }

  /** Send a command and resolve with its (non-async) response. Rejects on 1xx. */
  send(name: string, params?: Record<string, string | number | boolean | undefined>, timeoutMs = 5000): Promise<HyperDeckResponse> {
    return this.sendRaw(buildCommand(name, params), timeoutMs);
  }

  sendRaw(cmd: string, timeoutMs = 5000): Promise<HyperDeckResponse> {
    return new Promise((resolve, reject) => {
      if (this.state.status !== 'connected' || !this.socket) {
        reject(new Error('HyperDeck not connected'));
        return;
      }
      const p: Pending = { cmd, resolve, reject };
      p.timer = setTimeout(() => {
        if (this.inFlight === p) {
          this.inFlight = null;
          reject(new Error(`Timeout waiting for response to "${cmd.trim()}"`));
          this.pump();
        } else {
          this.queue = this.queue.filter((q) => q !== p);
          reject(new Error(`Timeout queued command "${cmd.trim()}"`));
        }
      }, timeoutMs + this.queue.length * 1000);
      this.queue.push(p);
      this.pump();
    });
  }

  // ---------------------------------------------------------------------------

  private open(): void {
    if (this.closed) return;
    this.setStatus('connecting');
    const sock = net.createConnection({ host: this.host, port: this.port });
    this.socket = sock;
    sock.setEncoding('utf8');
    sock.setKeepAlive(true, 5000);
    sock.setTimeout(8000);
    let greeted = false;

    const onGreeting = (r: HyperDeckResponse) => {
      if (r.code === 500 && !greeted) {
        greeted = true;
        sock.setTimeout(0);
        this.backoff = 1000;
        this.state.info = {
          ...(this.state.info ?? { slotCount: 0 }),
          protocolVersion: r.params['protocol version'],
          model: r.params.model,
        };
        this.setStatus('connected');
        void this.initialise();
      }
    };
    this.once('_greeting', onGreeting);

    sock.on('data', (d: string) => this.parser.push(d));
    sock.on('timeout', () => sock.destroy(new Error('Connection timed out')));
    sock.on('error', (err) => {
      this.state.lastError = err.message;
    });
    sock.on('close', () => {
      this.off('_greeting', onGreeting);
      if (this.socket !== sock) return;
      this.socket = null;
      this.parser.reset();
      this.failAll(new Error('Connection closed'));
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.setStatus('disconnected');
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this.open(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 15000);
      }
    });
  }

  private failAll(err: Error) {
    const all = [...(this.inFlight ? [this.inFlight] : []), ...this.queue];
    this.inFlight = null;
    this.queue = [];
    for (const p of all) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private pump(): void {
    if (this.inFlight || !this.socket) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = next;
    this.socket.write(next.cmd);
  }

  private onResponse(r: HyperDeckResponse): void {
    if (r.code >= 500 && r.code < 600) {
      if (r.code === 500) this.emit('_greeting', r);
      this.onAsync(r);
      return;
    }
    const p = this.inFlight;
    this.inFlight = null;
    if (p) {
      if (p.timer) clearTimeout(p.timer);
      if (r.code >= 100 && r.code < 200) p.reject(new HyperDeckError(r.code, r.text, p.cmd));
      else p.resolve(r);
    }
    this.pump();
  }

  private onAsync(r: HyperDeckResponse): void {
    // Transport/timecode notifications arrive up to once per frame; they go out
    // on a lightweight fast path instead of the full (debounced) state.
    const fast = r.code === 508 || r.code === 515 || r.code === 516;
    switch (r.code) {
      case 502: {
        const id = Number(r.params['slot id']);
        const prev = this.state.slots.find((s) => s.slotId === id);
        const next = parseSlotInfo(r.params, prev);
        this.state.slots = [...this.state.slots.filter((s) => s.slotId !== id), next].sort((a, b) => a.slotId - b.slotId);
        void this.refreshDisk(id).catch(() => {});
        void this.refreshNas().catch(() => {});
        break;
      }
      case 508:
        this.state.transport = parseTransportInfo(r.params, this.state.transport ?? undefined);
        break;
      case 510:
        this.state.remote = { enabled: r.params.enabled === 'true', override: r.params.override === 'true' };
        break;
      case 512: // clips info (timeline changed)
        void this.refreshTimeline().catch(() => {});
        break;
      case 513: // disk info (files added/removed)
        for (const s of this.state.slots) if (s.status === 'mounted') void this.refreshDisk(s.slotId).catch(() => {});
        break;
      case 515:
        if (this.state.transport && r.params['display timecode']) this.state.transport.displayTimecode = r.params['display timecode'];
        break;
      case 516:
        if (this.state.transport && r.params.timeline) this.state.transport.timeline = Number(r.params.timeline);
        break;
      default:
        break;
    }
    if (fast) this.emitTransport();
    else this.emitState();
  }

  /** Emit transport immediately, at most once per ~frame (15 ms), always sending the latest. */
  private emitTransport(): void {
    const now = Date.now();
    const send = () => {
      this.transportTimer = null;
      this.lastTransportEmit = Date.now();
      this.emit('transport', this.state.transport);
    };
    if (now - this.lastTransportEmit >= 15) send();
    else if (!this.transportTimer) this.transportTimer = setTimeout(send, 15 - (now - this.lastTransportEmit));
  }

  private async initialise(): Promise<void> {
    try {
      // Enable as many notifications as the firmware accepts.
      const wanted = ['transport', 'slot', 'remote', 'clips', 'disk', 'display timecode', 'timeline position'];
      try {
        await this.send('notify', Object.fromEntries(wanted.map((k) => [k, true])));
      } catch {
        for (const k of wanted) await this.send('notify', { [k]: true }).catch(() => {});
      }
      await this.refreshAll();
      this.pingTimer = setInterval(() => {
        this.send('ping').catch(() => this.socket?.destroy());
      }, 10000);
    } catch (err) {
      this.state.lastError = (err as Error).message;
      this.emitState();
    }
  }

  async refreshAll(): Promise<void> {
    const info = await this.send('device info');
    this.state.info = {
      ...this.state.info,
      protocolVersion: info.params['protocol version'] ?? this.state.info?.protocolVersion,
      model: info.params.model ?? this.state.info?.model,
      uniqueId: info.params['unique id'],
      slotCount: Number(info.params['slot count'] ?? 2),
      softwareVersion: info.params['software version'],
      name: info.params.name,
    };
    await this.refreshTransport();
    await this.refreshRemote().catch(() => {});
    await this.refreshSlots();
    await this.refreshNas().catch(() => {});
    await this.refreshTimeline().catch(() => {});
    this.emitState();
  }

  async refreshTransport(): Promise<void> {
    const t = await this.send('transport info');
    this.state.transport = parseTransportInfo(t.params);
    this.emitState();
  }

  async refreshRemote(): Promise<void> {
    const r = await this.send('remote');
    this.state.remote = { enabled: r.params.enabled === 'true', override: r.params.override === 'true' };
  }

  async refreshSlots(): Promise<void> {
    const count = this.state.info?.slotCount ?? 2;
    const slots: SlotInfo[] = [];
    for (let id = 1; id <= count; id++) {
      try {
        const r = await this.send('slot info', { 'slot id': id });
        slots.push(parseSlotInfo(r.params));
      } catch { /* slot not present on this model */ }
    }
    this.state.slots = slots;
    for (const s of slots) {
      if (s.status === 'mounted') await this.refreshDisk(s.slotId).catch(() => {});
      else delete this.state.disks[s.slotId];
    }
    this.emitState();
  }

  async refreshDisk(slotId: number): Promise<void> {
    const r = await this.send('disk list', { 'slot id': slotId }, 10000);
    const { clips } = parseDiskList(r.lines);
    this.state.disks[slotId] = clips;
    this.emitState();
  }

  async refreshTimeline(): Promise<void> {
    let r: HyperDeckResponse;
    try {
      r = await this.send('clips get', { version: 3 }, 10000);
    } catch {
      r = await this.send('clips get', undefined, 10000);
    }
    this.state.timeline = parseClipsGet(r.lines);
    this.state.edit = editFromState(this.state, this);
    this.emitState();
  }

  async refreshNas(): Promise<void> {
    try {
      const r = await this.send('nas selected');
      // Response shape varies by firmware; pick the first thing that looks like a URL.
      const url = Object.values(r.params).concat(r.lines).find((v) => /^(smb|afp|nfs|cifs):\/\//i.test(v)) ?? r.params.url ?? null;
      this.state.nasUrl = url || null;
    } catch {
      this.state.nasUrl = null;
    }
  }

  private emitState(): void {
    if (this.stateTimer) return;
    // Coalesce bursts of slot/clip/disk notifications.
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.state.edit = editFromState(this.state, this);
      this.emit('state', this.state);
    }, 100);
  }

  private setStatus(s: ConnectionStatus) {
    this.state.status = s;
    if (s !== 'connected') {
      this.state.transport = null;
    }
    this.emit('state', this.state);
  }
}
