/**
 * Blackmagic HyperDeck Ethernet Protocol — framing and response parsing.
 *
 * The protocol is line based (CRLF) on TCP 9993. A response is either a single
 * line ("200 ok") or, when the first line ends in ":", a header followed by
 * "key: value" lines and terminated by a blank line. Codes 1xx are failures,
 * 2xx are command responses, 5xx are asynchronous notifications.
 */

export interface HyperDeckResponse {
  code: number;
  text: string;
  /** Raw body lines (excluding header + terminating blank line). */
  lines: string[];
  /** "key: value" pairs parsed from the body; keys lower-cased as sent. */
  params: Record<string, string>;
}

export class ResponseParser {
  private buffer = '';
  private pending: { code: number; text: string; lines: string[] } | null = null;

  constructor(private readonly onResponse: (res: HyperDeckResponse) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      this.handleLine(line);
    }
  }

  reset(): void {
    this.buffer = '';
    this.pending = null;
  }

  private handleLine(line: string): void {
    if (this.pending) {
      if (line === '') {
        const p = this.pending;
        this.pending = null;
        this.emit(p.code, p.text, p.lines);
      } else {
        this.pending.lines.push(line);
      }
      return;
    }
    if (line === '') return;
    const m = /^(\d{3})\s+(.*)$/.exec(line);
    if (!m) return; // stray line; ignore
    const code = Number(m[1]);
    let text = m[2].trim();
    if (text.endsWith(':')) {
      this.pending = { code, text: text.slice(0, -1), lines: [] };
    } else {
      this.emit(code, text, []);
    }
  }

  private emit(code: number, text: string, lines: string[]): void {
    this.onResponse({ code, text, lines, params: parseParams(lines) });
  }
}

export function parseParams(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf(': ');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 2).trim();
    else if (line.endsWith(':')) out[line.slice(0, -1).trim()] = '';
  }
  return out;
}

/** Quote-free protocol values: the HyperDeck doesn't support escaping, so strip CR/LF. */
export function sanitize(value: string | number | boolean): string {
  return String(value).replace(/[\r\n]/g, ' ');
}

export function buildCommand(name: string, params?: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string | number | boolean][];
  if (entries.length === 0) return `${name}\r\n`;
  return `${name}: ${entries.map(([k, v]) => `${k}: ${sanitize(v)}`).join(' ')}\r\n`;
}

// ---------------------------------------------------------------------------
// Typed parsers for the responses we care about
// ---------------------------------------------------------------------------

export type TransportStatus = 'preview' | 'stopped' | 'play' | 'forward' | 'rewind' | 'jog' | 'shuttle' | 'record';

export interface TransportInfo {
  status: TransportStatus;
  speed: number;
  slotId: number | null;
  slotName?: string;
  deviceName?: string;
  clipId: number | null;
  singleClip: boolean;
  displayTimecode: string;
  timecode: string;
  videoFormat: string;
  loop: boolean;
  timeline?: number;
  inputVideoFormat?: string;
  referenceLocked?: boolean;
}

const bool = (v: string | undefined) => v === 'true';
const intOrNull = (v: string | undefined) => (v === undefined || v === 'none' || v === '' ? null : Number(v));

export function parseTransportInfo(p: Record<string, string>, prev?: TransportInfo): TransportInfo {
  const base: TransportInfo = prev ?? {
    status: 'stopped', speed: 0, slotId: null, clipId: null, singleClip: false,
    displayTimecode: '00:00:00:00', timecode: '00:00:00:00', videoFormat: '', loop: false,
  };
  // Async 508 notifications only include changed fields, so merge onto previous.
  const t: TransportInfo = { ...base };
  if ('status' in p) t.status = p.status as TransportStatus;
  if ('speed' in p) t.speed = Number(p.speed);
  if ('slot id' in p) t.slotId = intOrNull(p['slot id']);
  if ('slot name' in p) t.slotName = p['slot name'];
  if ('device name' in p) t.deviceName = p['device name'];
  if ('clip id' in p) t.clipId = intOrNull(p['clip id']);
  if ('single clip' in p) t.singleClip = bool(p['single clip']);
  if ('display timecode' in p) t.displayTimecode = p['display timecode'];
  if ('timecode' in p) t.timecode = p.timecode;
  if ('video format' in p) t.videoFormat = p['video format'];
  if ('loop' in p) t.loop = bool(p.loop);
  if ('timeline' in p) t.timeline = Number(p.timeline);
  if ('input video format' in p) t.inputVideoFormat = p['input video format'];
  if ('reference locked' in p) t.referenceLocked = bool(p['reference locked']);
  return t;
}

export interface SlotInfo {
  slotId: number;
  slotName?: string;
  deviceName?: string;
  status: string; // empty | mounting | error | mounted
  volumeName?: string;
  recordingTime?: number;
  videoFormat?: string;
  blocked?: boolean;
  remainingSize?: number;
  totalSize?: number;
}

export function parseSlotInfo(p: Record<string, string>, prev?: SlotInfo): SlotInfo {
  const s: SlotInfo = { ...(prev ?? { slotId: Number(p['slot id']), status: 'empty' }) };
  if ('slot id' in p) s.slotId = Number(p['slot id']);
  if ('slot name' in p) s.slotName = p['slot name'];
  if ('device name' in p) s.deviceName = p['device name'];
  if ('status' in p) s.status = p.status;
  if ('volume name' in p) s.volumeName = p['volume name'];
  if ('recording time' in p) s.recordingTime = Number(p['recording time']);
  if ('video format' in p) s.videoFormat = p['video format'];
  if ('blocked' in p) s.blocked = bool(p.blocked);
  if ('remaining size' in p) s.remainingSize = Number(p['remaining size']);
  if ('total size' in p) s.totalSize = Number(p['total size']);
  return s;
}

export interface DiskClip {
  index: number;
  name: string;
  fileFormat: string;
  videoFormat: string;
  duration: string;
}

/** "{index}: {name} {file format} {video format} {duration}" — name may contain spaces. */
export function parseDiskList(lines: string[]): { slotId: number | null; clips: DiskClip[] } {
  let slotId: number | null = null;
  const clips: DiskClip[] = [];
  for (const line of lines) {
    const sm = /^slot id:\s*(\d+)/.exec(line);
    if (sm) { slotId = Number(sm[1]); continue; }
    const m = /^(\d+):\s+(.+)$/.exec(line);
    if (!m) continue;
    const parts = m[2].trim().split(/\s+/);
    if (parts.length < 4) continue;
    const duration = parts.pop()!;
    const videoFormat = parts.pop()!;
    const fileFormat = parts.pop()!;
    const name = parts.join(' ');
    clips.push({ index: Number(m[1]), name, fileFormat, videoFormat, duration });
  }
  return { slotId, clips };
}

export interface TimelineClip {
  id: number;
  name: string;
  /** Source timecode of the first frame of the clip. */
  startTimecode: string;
  duration: string;
  inTimecode?: string;
  outTimecode?: string;
}

const TC = /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/;

/**
 * Parses "clips get" in any of the three response versions:
 *  v1: "{id}: {name} {startT} {duration}"
 *  v2/v3: "{id}: {clipInT} {clipDuration} {inT} {outT} {name or folder/name}"
 */
export function parseClipsGet(lines: string[]): TimelineClip[] {
  const clips: TimelineClip[] = [];
  for (const line of lines) {
    const m = /^(\d+):\s+(.+)$/.exec(line);
    if (!m) continue;
    const id = Number(m[1]);
    const parts = m[2].trim().split(/\s+/);
    if (parts.length >= 5 && TC.test(parts[0]) && TC.test(parts[1]) && TC.test(parts[2]) && TC.test(parts[3])) {
      const name = m[2].trim().split(/\s+/).slice(4).join(' ');
      clips.push({ id, startTimecode: parts[0], duration: parts[1], inTimecode: parts[2], outTimecode: parts[3], name });
    } else if (parts.length >= 3) {
      const duration = parts.pop()!;
      const start = parts.pop()!;
      clips.push({ id, name: parts.join(' '), startTimecode: start, duration });
    }
  }
  return clips;
}

// ---------------------------------------------------------------------------
// Timecode helpers
// ---------------------------------------------------------------------------

/** Frame rate implied by a HyperDeck video format string e.g. "1080p5994" -> 59.94. */
export function fpsFromVideoFormat(fmt: string | undefined): number | null {
  if (!fmt) return null;
  if (/^(NTSC|NTSCp)$/i.test(fmt)) return 29.97;
  if (/^(PAL|PALp)$/i.test(fmt)) return 25;
  const m = /(?:p|i)(\d{2,5})$/.exec(fmt);
  if (!m) return null;
  const n = m[1];
  const map: Record<string, number> = {
    '23976': 23.976, '24': 24, '25': 25, '2997': 29.97, '30': 30,
    '50': 50, '5994': 59.94, '60': 60, '4795': 47.95, '48': 48,
  };
  const fps = map[n] ?? null;
  // Interlaced formats are named by field rate.
  if (fps && /i\d+$/.test(fmt)) return fps / 2;
  return fps;
}

/** Integer timebase used for HyperDeck timecode counting (e.g. 29.97 -> 30). */
export function tcBase(fps: number): number {
  return Math.round(fps);
}

export function timecodeToFrames(tc: string, fps: number): number {
  const m = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(tc);
  if (!m) return 0;
  const [h, mi, s, f] = m.slice(1).map(Number);
  const base = tcBase(fps);
  const dropFrame = tc.includes(';');
  let frames = ((h * 60 + mi) * 60 + s) * base + f;
  if (dropFrame) {
    const drop = base === 60 ? 4 : 2;
    const totalMinutes = h * 60 + mi;
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

export function framesToTimecode(frames: number, fps: number, dropFrame = false): string {
  const base = tcBase(fps);
  let f = Math.max(0, Math.round(frames));
  if (dropFrame) {
    const drop = base === 60 ? 4 : 2;
    const framesPer10Min = base * 600 - drop * 9;
    const framesPerMin = base * 60 - drop;
    const d = Math.floor(f / framesPer10Min);
    const mod = f % framesPer10Min;
    f += drop * 9 * d + (mod > drop ? drop * Math.floor((mod - drop) / framesPerMin) : 0);
  }
  const ff = f % base;
  const totalSeconds = Math.floor(f / base);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600) % 24;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${dropFrame ? ';' : ':'}${pad(ff)}`;
}
