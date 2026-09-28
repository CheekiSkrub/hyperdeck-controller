/**
 * Mock HyperDeck for development and tests.
 *
 *  - Ethernet protocol server on :9993 (MOCK_PORT) implementing the subset the
 *    controller uses, with 5xx notifications and a simulated playhead.
 *  - Anonymous FTP on :2121 (MOCK_FTP_PORT) exposing ssd1/ and ssd2/.
 *  - Slot 3 simulates network storage: its files live in .mock-media/nas which
 *    is NOT on FTP — map it as a share on the device to read it.
 *
 * Usage: npx tsx tools/mock-hyperdeck.ts   (generates test clips with ffmpeg on first run)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '.mock-media');
const FTP_ROOT = path.join(ROOT, 'ftp');
const PORT = Number(process.env.MOCK_PORT ?? 9993);
const FTP_PORT = Number(process.env.MOCK_FTP_PORT ?? 2121);
const HOST = process.env.MOCK_HOST ?? '0.0.0.0';
const FPS = 25;

interface MockFile { name: string; frames: number; format: string; tcStart: number }
interface Entry { name: string; frames: number; in: number; file: MockFile }
const slots: Record<number, { dir: string; name: string; files: MockFile[] }> = {
  1: { dir: path.join(FTP_ROOT, 'ssd1'), name: 'ssd1', files: [] },
  2: { dir: path.join(FTP_ROOT, 'ssd2'), name: 'ssd2', files: [] },
  3: { dir: path.join(ROOT, 'nas'), name: 'nas', files: [] },
};

function makeClip(dir: string, name: string, seconds: number, tc: string, pattern: string, codec: 'prores' | 'h264') {
  const out = path.join(dir, name);
  if (fs.existsSync(out)) return;
  fs.mkdirSync(dir, { recursive: true });
  const v = codec === 'prores'
    ? ['-c:v', 'prores_ks', '-profile:v', '0']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-pix_fmt', 'yuv420p'];
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `${pattern}=size=1280x720:rate=${FPS}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-vf', `drawtext=text='${name.replace(/[':]/g, '')} %{frame_num}':x=40:y=40:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6${codec === 'prores' ? ',format=yuv422p10le' : ''}`,
    ...v, '-c:a', codec === 'prores' ? 'pcm_s16le' : 'aac', '-timecode', tc, out,
  ]);
}

function prepareMedia() {
  console.log('[mock] preparing test clips…');
  makeClip(slots[1].dir, 'Studio Cam A_0001.mov', 20, '10:00:00:00', 'testsrc2', 'prores');
  makeClip(slots[1].dir, 'Studio Cam A_0002.mov', 12, '10:05:00:00', 'smptehdbars', 'prores');
  makeClip(slots[2].dir, 'Interview_0001.mp4', 15, '11:00:00:00', 'rgbtestsrc', 'h264');
  makeClip(slots[3].dir, 'NAS Record_0001.mov', 18, '12:00:00:00', 'testsrc', 'prores');
  for (const s of Object.values(slots)) {
    s.files = fs.readdirSync(s.dir).filter((f) => /\.(mov|mp4)$/.test(f)).sort().map((f) => {
      const full = path.join(s.dir, f);
      const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', full]).toString().trim());
      const tcTag = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream_tags=timecode:format_tags=timecode', '-of', 'default=nw=1:nk=1', full]).toString().trim().split('\n')[0] ?? '';
      const m = /(\d+):(\d+):(\d+)[:;](\d+)/.exec(tcTag);
      const tcStart = m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * FPS + Number(m[4]) : 0;
      return { name: f, frames: Math.round(d * FPS), format: f.endsWith('.mp4') ? 'H.264High' : 'QuickTimeProRes', tcStart };
    });
  }
}

const tc = (frames: number) => {
  const f = frames % FPS, s = Math.floor(frames / FPS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f)}`;
};

// ---------------------------------------------------------------- deck state
const deck = {
  status: 'stopped' as string,
  speed: 0,
  slotId: 1,
  position: 0, // timeline frame
  loop: false,
  singleClip: false,
  timeline: [] as Entry[],
  remote: true,
};
const fullEntry = (f: MockFile): Entry => ({ name: f.name, frames: f.frames, in: 0, file: f });
const rebuildTimeline = () => { deck.timeline = slots[deck.slotId].files.map(fullEntry); deck.position = 0; };

function clipAt(pos: number) {
  let start = 0;
  for (let i = 0; i < deck.timeline.length; i++) {
    const c = deck.timeline[i];
    if (pos < start + c.frames) return { id: i + 1, start, clip: c };
    start += c.frames;
  }
  return deck.timeline.length ? { id: deck.timeline.length, start: start - deck.timeline.at(-1)!.frames, clip: deck.timeline.at(-1)! } : null;
}
const clipStart = (id: number) => deck.timeline.slice(0, id - 1).reduce((n, c) => n + c.frames, 0);
const totalFrames = () => deck.timeline.reduce((n, c) => n + c.frames, 0);

function transportLines(): string[] {
  const at = clipAt(deck.position);
  return [
    `status: ${deck.status}`, `speed: ${deck.speed}`, `slot id: ${deck.slotId}`, `slot name: ${slots[deck.slotId].name}`,
    `device name: ${slots[deck.slotId].name}`, `clip id: ${at ? at.id : 'none'}`, `single clip: ${deck.singleClip}`,
    `display timecode: ${tc(deck.position)}`, `timecode: ${tc(deck.position)}`, 'video format: 1080p25', `loop: ${deck.loop}`,
    `timeline: ${deck.position}`, 'input video format: 1080p25', 'dynamic range: Rec709', 'reference locked: true',
  ];
}

const clients = new Set<net.Socket>();
const notifyOn = new WeakMap<net.Socket, Set<string>>();
function notify(kind: string, code: number, title: string, lines: string[]) {
  for (const s of clients) if (notifyOn.get(s)?.has(kind)) s.write(`${code} ${title}:\r\n${lines.join('\r\n')}\r\n\r\n`);
}
const pushTransport = () => notify('transport', 508, 'transport info', transportLines());

// Advance one frame per tick, like a real deck, sending display timecode each frame.
let frac = 0;
setInterval(() => {
  if (deck.status !== 'play' && deck.status !== 'shuttle') return;
  frac += deck.speed / 100;
  const step = Math.trunc(frac);
  frac -= step;
  if (!step) return;
  deck.position += step;
  if (deck.position >= totalFrames() || deck.position < 0) {
    if (deck.loop) deck.position = 0;
    else { deck.position = Math.max(0, Math.min(deck.position, totalFrames() - 1)); deck.status = 'stopped'; deck.speed = 0; pushTransport(); }
  }
  notify('display timecode', 515, 'display timecode info', [`display timecode: ${tc(deck.position)}`]);
  notify('timeline position', 516, 'timeline position info', [`timeline: ${deck.position}`]);
}, 1000 / FPS);

// ---------------------------------------------------------------- command handling
function parse(line: string): { name: string; params: Record<string, string> } {
  const i = line.indexOf(':');
  if (i < 0) return { name: line.trim(), params: {} };
  const name = line.slice(0, i).trim();
  const rest = line.slice(i + 1).trim();
  const params: Record<string, string> = {};
  const re = /([a-z ]+?):\s*(.*?)(?=\s+[a-z ]+?:|$)/g;
  let m;
  while ((m = re.exec(rest))) params[m[1].trim()] = m[2].trim();
  return { name, params };
}

function handle(sock: net.Socket, line: string): string {
  const { name, params } = parse(line);
  const ok = '200 ok\r\n';
  const block = (code: number, title: string, lines: string[]) => `${code} ${title}:\r\n${lines.join('\r\n')}\r\n\r\n`;
  const needRemote = ['play', 'stop', 'record', 'goto', 'jog', 'shuttle', 'slot select', 'preview', 'clips add', 'clips remove', 'clips clear'];
  if (needRemote.includes(name) && !deck.remote) return '111 remote control disabled\r\n';

  switch (name) {
    case 'ping': return ok;
    case 'notify': {
      const set = notifyOn.get(sock) ?? new Set();
      for (const [k, v] of Object.entries(params)) v === 'true' ? set.add(k) : set.delete(k);
      notifyOn.set(sock, set);
      return ok;
    }
    case 'device info':
      return block(204, 'device info', ['protocol version: 1.13', 'model: HyperDeck Studio HD Pro (Mock)', 'unique id: 00000000mock', 'slot count: 3', 'software version: 8.4', 'name: Mock Deck']);
    case 'remote':
      if (params.enable) { deck.remote = params.enable === 'true'; notify('remote', 510, 'remote info', [`enabled: ${deck.remote}`, 'override: false']); return ok; }
      return block(210, 'remote info', [`enabled: ${deck.remote}`, 'override: false']);
    case 'transport info': return block(208, 'transport info', transportLines());
    case 'slot info': {
      const id = Number(params['slot id'] ?? deck.slotId);
      const s = slots[id];
      if (!s) return '102 invalid value\r\n';
      return block(202, 'slot info', [`slot id: ${id}`, `slot name: ${s.name}`, `device name: ${s.name}`, 'status: mounted', `volume name: ${id === 3 ? 'Studio NAS' : 'Media ' + id}`, 'recording time: 3600', 'video format: 1080p25', 'blocked: false', 'remaining size: 100000000000', 'total size: 500000000000']);
    }
    case 'nas selected': return block(224, 'nas selected', ['url: smb://nas.local/Recordings']);
    case 'disk list': {
      const id = Number(params['slot id'] ?? deck.slotId);
      const s = slots[id];
      if (!s) return '102 invalid value\r\n';
      return block(206, 'disk list', [`slot id: ${id}`, ...s.files.map((f, i) => `${i + 1}: ${f.name} ${f.format} 1080p25 ${tc(f.frames)}`)]);
    }
    case 'clips get': {
      let start = 0;
      const v = params.version ?? '1';
      const lines = deck.timeline.map((c, i) => {
        const l = v === '1'
          ? `${i + 1}: ${c.name} ${tc(start)} ${tc(c.frames)}`
          : `${i + 1}: ${tc(c.file.tcStart)} ${tc(c.file.frames)} ${tc(c.file.tcStart + c.in)} ${tc(c.file.tcStart + c.in + c.frames)} ${c.name}`;
        start += c.frames;
        return l;
      });
      return block(205, 'clips info', [`clip count: ${deck.timeline.length}`, ...lines]);
    }
    case 'clips add': {
      const f = slots[deck.slotId].files.find((x) => x.name === params.name);
      if (!f) return '112 clip not found\r\n';
      let entry = fullEntry(f);
      if (params['frame in'] !== undefined && params['frame out'] !== undefined) {
        const fi = Number(params['frame in']);
        const fo = Number(params['frame out']);
        if (!(fi >= 0 && fo > fi && fo <= f.frames)) return '109 out of range\r\n';
        entry = { name: f.name, frames: fo - fi, in: fi, file: f };
      }
      if (params['clip id'] !== undefined) deck.timeline.splice(Number(params['clip id']) - 1, 0, entry);
      else deck.timeline.push(entry);
      notify('clips', 512, 'clips info', ['clip count: ' + deck.timeline.length]);
      return ok;
    }
    case 'clips remove': {
      const id = Number(params['clip id']);
      if (!(id >= 1 && id <= deck.timeline.length)) return '109 out of range\r\n';
      deck.timeline.splice(id - 1, 1);
      deck.position = Math.min(deck.position, Math.max(0, totalFrames() - 1));
      notify('clips', 512, 'clips info', ['clip count: ' + deck.timeline.length]);
      return ok;
    }
    case 'clips clear': deck.timeline = []; deck.position = 0; notify('clips', 512, 'clips info', ['clip count: 0']); return ok;
    case 'slot select': {
      const id = Number(params['slot id']);
      if (!slots[id]) return '102 invalid value\r\n';
      deck.slotId = id; deck.status = 'stopped'; deck.speed = 0;
      rebuildTimeline();
      pushTransport();
      return ok;
    }
    case 'play':
      deck.status = 'play';
      deck.speed = params.speed ? Number(params.speed) : 100;
      if (params.loop) deck.loop = params.loop === 'true';
      if (params['single clip']) deck.singleClip = params['single clip'] === 'true';
      pushTransport();
      return ok;
    case 'stop': deck.status = 'stopped'; deck.speed = 0; pushTransport(); return ok;
    case 'record': deck.status = 'record'; deck.speed = 0; pushTransport(); return ok;
    case 'preview': deck.status = params.enable === 'true' ? 'preview' : 'stopped'; pushTransport(); return ok;
    case 'shuttle': deck.status = 'shuttle'; deck.speed = Number(params.speed ?? 0); pushTransport(); return ok;
    case 'playrange set': case 'playrange clear': case 'identify': case 'play option': return ok;
    case 'jog': {
      const m = /^([+-])?(\d{2}):(\d{2}):(\d{2}):(\d{2})$/.exec(params.timecode ?? '');
      if (!m) return '102 invalid value\r\n';
      const n = ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4])) * FPS + Number(m[5]);
      deck.position = m[1] === '-' ? deck.position - n : m[1] === '+' ? deck.position + n : n;
      deck.position = Math.max(0, Math.min(deck.position, totalFrames() - 1));
      deck.status = 'jog'; pushTransport();
      return ok;
    }
    case 'goto': {
      if (!deck.timeline.length) return '107 timeline empty\r\n';
      if (params['clip id']) {
        const v = params['clip id'];
        const cur = clipAt(deck.position)?.id ?? 1;
        const id = v === 'start' ? 1 : v === 'end' ? deck.timeline.length : /^[+-]/.test(v) ? cur + Number(v) : Number(v);
        if (id < 1 || id > deck.timeline.length) return '109 out of range\r\n';
        deck.position = clipStart(id);
      } else if (params.clip !== undefined) {
        const at = clipAt(deck.position)!;
        const v = params.clip;
        if (v === 'start') deck.position = at.start;
        else if (v === 'end') deck.position = at.start + at.clip.frames - 1;
        else if (/^[+-]/.test(v)) deck.position = deck.position + Number(v);
        else deck.position = at.start + Number(v);
      } else if (params.timeline !== undefined) {
        const v = params.timeline;
        deck.position = v === 'start' ? 0 : v === 'end' ? totalFrames() - 1 : /^[+-]/.test(v) ? deck.position + Number(v) : Number(v);
      } else return '101 unsupported parameter\r\n';
      deck.position = Math.max(0, Math.min(deck.position, totalFrames() - 1));
      pushTransport();
      return ok;
    }
    default:
      return '100 syntax error\r\n';
  }
}

async function main() {
  prepareMedia();
  rebuildTimeline();

  net.createServer((sock) => {
    clients.add(sock);
    sock.setEncoding('utf8');
    sock.write('500 connection info:\r\nprotocol version: 1.13\r\nmodel: HyperDeck Studio HD Pro (Mock)\r\n\r\n');
    let buf = '';
    sock.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        if (process.env.MOCK_VERBOSE) console.log('[mock] <', line);
        sock.write(handle(sock, line));
      }
    });
    sock.on('close', () => clients.delete(sock));
    sock.on('error', () => clients.delete(sock));
  }).listen(PORT, HOST, () => console.log(`[mock] HyperDeck protocol on ${HOST}:${PORT}`));

  const { FtpSrv } = await import('ftp-srv');
  const ftp = new FtpSrv({ url: `ftp://${HOST}:${FTP_PORT}`, anonymous: true, pasv_url: '127.0.0.1', pasv_min: 30000, pasv_max: 30100, log: { info() {}, debug() {}, trace() {}, warn() {}, error() {}, child() { return this; } } as any });
  ftp.on('login', (_d, resolve) => resolve({ root: FTP_ROOT }));
  await ftp.listen();
  console.log(`[mock] FTP on ${HOST}:${FTP_PORT} (root ${FTP_ROOT})`);
  console.log(`[mock] NAS share folder (map this as the device share): ${path.join(ROOT, 'nas')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
