import { EventEmitter } from 'node:events';
import net from 'node:net';
import { editFromState, type DerivedEntry } from '../devices/edit.js';
import {
  buildCommand, parseClipsGet, parseDiskList, parseSlotInfo, parseTransportInfo, ResponseParser,
  type DiskClip, type HyperDeckResponse, type SlotInfo, type TimelineClip, type TransportInfo,
} from './protocol.js';


const MOVING_STATES = new Set(['play', 'forward', 'rewind', 'shuttle', 'jog']);
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

/** Title of the reply each read command gets (the "NNN title:" header), for matching replies to commands. */
const REPLY_TITLES: Record<string, string> = {
  'slot info': 'slot info',
  'disk list': 'disk list',
  'clips get': 'clips info',
  'clips count': 'clips count',
  'transport info': 'transport info',
  'device info': 'device info',
  remote: 'remote info',
  'nas selected': 'nas info',
  configuration: 'configuration',
};
/** After a command times out, how long to hold the next one back in case its reply turns up late. */
const LATE_REPLY_GRACE_MS = 2000;

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
  /** Fallback position polling while the deck moves (see pollPosition). */
  private positionTimer: NodeJS.Timeout | null = null;
  /** When the deck last pushed a position notification itself (polls don't count). */
  private lastPositionAt = 0;
  private polling = false;
  /**
   * Replies are paired with commands purely in order (one in flight at a time), so a reply that
   * arrives after its command gave up would be taken as the answer to the NEXT command and shift
   * every pairing after it by one — seen on a Shuttle HD while its NAS remounted: "slot info: slot
   * id: 2" got some other reply and became a phantom "Slot null". So after a timeout nothing is
   * sent for a short grace period: any reply arriving then can only be the late one and is dropped.
   */
  /** Recent protocol traffic for diagnosing real decks (GET /api/devices/:id/debug/protocol). */
  readonly trace: string[] = [];
  private diskTimer: NodeJS.Timeout | null = null;
  private quietUntil = 0;
  private quietTimer: NodeJS.Timeout | null = null;

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
    if (this.positionTimer) clearInterval(this.positionTimer);
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
          this.log(`! timeout: ${cmd.trim()}`);
          reject(new Error(`Timeout waiting for response to "${cmd.trim()}"`));
          this.holdForLateReply();
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
      this.endQuiet();
      this.failAll(new Error('Connection closed'));
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.positionTimer) clearInterval(this.positionTimer);
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

  private holdForLateReply(): void {
    this.quietUntil = Date.now() + LATE_REPLY_GRACE_MS;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => { this.endQuiet(); this.pump(); }, LATE_REPLY_GRACE_MS);
  }

  private endQuiet(): void {
    this.quietUntil = 0;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }

  private log(line: string): void {
    this.trace.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    if (this.trace.length > 400) this.trace.splice(0, this.trace.length - 400);
  }

  private pump(): void {
    if (this.inFlight || !this.socket || Date.now() < this.quietUntil) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = next;
    this.log(`> ${next.cmd.trim().replace(/\n/g, ' | ')}`);
    this.socket.write(next.cmd);
  }

  private onResponse(r: HyperDeckResponse): void {
    const perFrame = ['transport', 'display timecode', 'timeline position'].includes(asyncKind(r) ?? '');
    if (!(r.code >= 500 && r.code < 600 && perFrame)) this.log(`< ${r.code} ${r.text}${r.lines.length ? ` (${r.lines.length} lines)` : ''}${this.inFlight ? '' : ' [nothing in flight]'}`);
    if (r.code >= 500 && r.code < 600) {
      if (r.code === 500) this.emit('_greeting', r);
      this.onAsync(r);
      return;
    }
    const p = this.inFlight;
    if (!p) {
      // Nothing in flight: the late reply to a command that timed out (or a stray). Drop it, and
      // if we were holding the queue back for it, carry on now.
      if (this.quietUntil) { this.endQuiet(); this.pump(); }
      return;
    }
    // Belt and braces for queries, whose replies are recognisable: a successful reply under some
    // other title isn't ours, so keep waiting for the real one.
    if (r.code >= 200 && r.code < 300 && !replyMatches(p.cmd, r)) { this.log('  (not the reply to that — still waiting)'); return; }
    this.inFlight = null;
    if (p) {
      if (p.timer) clearTimeout(p.timer);
      if (r.code >= 100 && r.code < 200) p.reject(new HyperDeckError(r.code, r.text, p.cmd));
      else p.resolve(r);
    }
    this.pump();
  }

  private onAsync(r: HyperDeckResponse): void {
    const kind = asyncKind(r);
    // Transport/timecode notifications arrive up to once per frame; they go out
    // on a lightweight fast path instead of the full (debounced) state.
    const fast = kind === 'transport' || kind === 'display timecode' || kind === 'timeline position';
    switch (kind) {
      case 'slot': {
        const id = Number(r.params['slot id']);
        // Seen on a Shuttle HD (8.4.1) after reselecting its NAS: a slot notification with no
        // slot id. Don't file it under a bogus "slot null" — re-read every slot instead.
        if (!Number.isInteger(id) || id < 1) {
          void this.refreshSlots().then(() => { this.emitState(); this.scheduleDiskRefresh(); }).catch(() => {});
          void this.refreshNas().catch(() => {});
          break;
        }
        const prev = this.state.slots.find((s) => s.slotId === id);
        const next = parseSlotInfo(r.params, prev);
        this.state.slots = [...this.state.slots.filter((s) => s.slotId !== id), next].sort((a, b) => a.slotId - b.slotId);
        this.scheduleDiskRefresh();
        void this.refreshNas().catch(() => {});
        break;
      }
      case 'transport':
        this.state.transport = parseTransportInfo(r.params, this.state.transport ?? undefined);
        break;
      case 'remote':
        this.state.remote = { enabled: r.params.enabled === 'true', override: r.params.override === 'true' };
        break;
      case 'clips': // timeline changed
        void this.refreshTimeline().catch(() => {});
        break;
      case 'disk': // files added/removed
        this.scheduleDiskRefresh();
        break;
      case 'display timecode':
        if (this.state.transport && r.params['display timecode']) this.state.transport.displayTimecode = r.params['display timecode'];
        break;
      case 'timeline position':
        if (this.state.transport && r.params.timeline) this.state.transport.timeline = Number(r.params.timeline);
        this.lastPositionAt = Date.now();
        break;
      default:
        break;
    }
    if (fast) this.emitTransport();
    else this.emitState();
  }

  /** Re-list every mounted slot, coalescing bursts of disk/slot notifications into one pass. */
  private scheduleDiskRefresh(): void {
    if (this.diskTimer) return;
    this.diskTimer = setTimeout(() => {
      this.diskTimer = null;
      for (const s of this.state.slots) if (s.status === 'mounted') void this.refreshDisk(s.slotId).catch(() => {});
      // Re-read transport too: while a NAS remounts the deck reports "slot id: none" and doesn't
      // always send a new transport notification once the slot is back (seen on a Shuttle HD),
      // leaving us with no active slot — no clips, thumbnails or cueing — until something else
      // happened to refresh it.
      void this.refreshTransport().catch(() => {});
    }, 500);
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
    // Timers first: if the initial refresh below fails (a slow deck mid NAS remount timed out),
    // the connection is still live and still needs its keep-alive and position polling.
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.send('ping').catch(() => this.socket?.destroy());
    }, 10000);
    if (this.positionTimer) clearInterval(this.positionTimer);
    this.positionTimer = setInterval(() => void this.pollPosition(), 250);
    try {
      // Enable as many notifications as the firmware accepts.
      const wanted = ['transport', 'slot', 'remote', 'clips', 'disk', 'display timecode', 'timeline position'];
      try {
        await this.send('notify', Object.fromEntries(wanted.map((k) => [k, true])));
      } catch {
        for (const k of wanted) await this.send('notify', { [k]: true }).catch(() => {});
      }
      await this.refreshAll();
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

  /**
   * Some firmware (seen on a Shuttle HD, 8.4.1) accepts `notify: timeline position` but doesn't
   * send position updates while playing, so the panel's playhead ran out of extrapolation and
   * stopped. While the deck is moving and no position has arrived for half a second, ask for it.
   */
  private async pollPosition(): Promise<void> {
    const t = this.state.transport;
    if (!t || this.polling || !MOVING_STATES.has(t.status) || Date.now() - this.lastPositionAt < 500) return;
    this.polling = true;
    try {
      const r = await this.send('transport info', undefined, 1000);
      this.state.transport = parseTransportInfo(r.params, this.state.transport ?? undefined);
      this.emitTransport();
    } catch { /* next tick retries */ } finally {
      this.polling = false;
    }
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
    // An empty timeline isn't an error to us, but the deck answers `clips get` with "107 timeline
    // empty" — which used to abort the refresh and leave the last removed clip showing.
    const empty = (e: unknown) => e instanceof HyperDeckError && e.code === 107;
    let r: HyperDeckResponse | null;
    try {
      r = await this.send('clips get', { version: 3 }, 10000);
    } catch (e) {
      if (empty(e)) r = null;
      else {
        try {
          r = await this.send('clips get', undefined, 10000);
        } catch (e2) {
          if (!empty(e2)) throw e2;
          r = null;
        }
      }
    }
    this.state.timeline = r ? parseClipsGet(r.lines) : [];
    this.state.edit = editFromState(this.state, this);
    this.emitState();
  }

  /**
   * Re-read the timeline until `done` says it reflects our changes (or `timeoutMs` passes).
   * A Shuttle HD (8.4.1) answers `clips clear` / `clips add` with "200 ok" straight away but
   * applies them later: `clips get` kept returning the old timeline for 0.5–1.5 s. Reading it
   * once afterwards showed the previous state, so every edit looked one step behind.
   */
  async waitForTimeline(done: (t: TimelineClip[]) => boolean, timeoutMs = 6000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      await this.refreshTimeline();
      if (done(this.state.timeline)) return true;
      if (Date.now() > until) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async refreshNas(): Promise<void> {
    try {
      const r = await this.send('nas selected');
      // Response shape varies by firmware; pick the first thing that looks like a URL.
      const url = Object.values(r.params).concat(r.lines).find((v) => /^(smb|afp|nfs|cifs):\/\//i.test(v)) ?? r.params.url ?? null;
      this.state.nasUrl = url || this.slotNasUrl();
    } catch {
      // A busy/reconnecting deck can fail this transiently; the mounted network slot says the same thing.
      this.state.nasUrl = this.slotNasUrl();
    }
  }

  private slotNasUrl(): string | null {
    return this.state.slots.find((s) => s.status === 'mounted' && s.url)?.url ?? null;
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

type AsyncKind = 'slot' | 'transport' | 'remote' | 'clips' | 'disk' | 'display timecode' | 'timeline position';

/**
 * What an asynchronous (5xx) notification is about. Decided by its title, because the numbers
 * vary by firmware: a Shuttle HD (protocol 1.18) sends "513 display timecode" and "514 timeline
 * position", where we'd assumed 515/516 — and 513 was being read as "disk changed", so every
 * frame of playback re-listed the whole disk. The code is only a fallback for unknown titles.
 */
export function asyncKind(r: HyperDeckResponse): AsyncKind | null {
  const title = r.text.trim().toLowerCase().replace(/ info$/, '');
  const byTitle: Record<string, AsyncKind> = {
    slot: 'slot', transport: 'transport', remote: 'remote', clips: 'clips',
    disk: 'disk', 'disk list': 'disk', 'display timecode': 'display timecode', 'timeline position': 'timeline position',
  };
  if (byTitle[title]) return byTitle[title];
  const byCode: Record<number, AsyncKind> = { 502: 'slot', 508: 'transport', 510: 'remote', 512: 'clips' };
  return byCode[r.code] ?? null;
}

/**
 * Could `r` be the reply to `cmd`? Queries come back under their own title (and, for per-slot
 * queries, the same slot id); anything else (actions just get "200 ok") can't be checked.
 */
function replyMatches(cmd: string, r: HyperDeckResponse): boolean {
  const name = cmd.split(/[:\n]/)[0].trim().toLowerCase();
  const title = REPLY_TITLES[name];
  if (!title) return true;
  if (r.text.trim().toLowerCase() !== title) return false;
  const wantSlot = /slot id:\s*(\d+)/i.exec(cmd)?.[1];
  return !wantSlot || !r.params['slot id'] || r.params['slot id'] === wantSlot;
}
