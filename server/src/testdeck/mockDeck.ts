/**
 * Simulated HyperDeck: an Ethernet-protocol server, anonymous FTP, and a
 * minimal REST API, implementing the subset the controller uses. Used by
 * `npm run dev:mock` (tools/mock-hyperdeck.ts, fixed ports, long clips) and
 * by the in-app "Add test HyperDeck" button (server/src/devices/testDeck.ts,
 * ephemeral ports, short clips, one instance per simulated device).
 *
 * Slot 3 simulates network storage: its files live under `<mediaDir>/nas`
 * and are NOT exposed over FTP — map that folder as a device share to read it,
 * the same way a real HyperDeck's SMB/AFP recordings are read.
 */
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const FPS = 25;

interface MockFile { name: string; frames: number; format: string; tcStart: number }
interface Entry { name: string; frames: number; in: number; file: MockFile }
interface Slot { dir: string; name: string; files: MockFile[] }

export interface MockDeckOptions {
  /** Interface to bind the protocol/FTP/REST servers on. Default 127.0.0.1. */
  host?: string;
  /** Ethernet protocol port. 0 (default) picks a free port. */
  port?: number;
  /** FTP control port. 0 (default) picks a free port. */
  ftpPort?: number;
  /** REST API port. 0 (default) picks a free port. */
  restPort?: number;
  /** Where generated test clips (and the simulated NAS folder) live. */
  mediaDir: string;
  /** ffmpeg/ffprobe to generate test clips with — the app's bundled/configured binaries, not necessarily on PATH. */
  ffmpeg: string;
  ffprobe: string;
  /** Clip lengths in seconds for the three generated files (shorter = faster to spin up). Default 6/4/5. */
  clipSeconds?: { camA: number; interview: number; nas: number };
  verbose?: boolean;
  /** NAS bookmarks/selection to start with (e.g. restored from a previous run). */
  nas?: MockNasState;
  /** Called whenever the simulated NAS bookmarks or selection change, so they can be persisted. */
  onNasChange?: (nas: MockNasState) => void;
}

export interface MockNasState {
  bookmarks: { url: string; username?: string; password?: string }[];
  selected: string | null;
}

export interface MockDeck {
  host: string;
  port: number;
  ftpPort: number;
  restPort: number;
  /** Local folder for slot 3's "network storage" clips — map this as a device share to see them. */
  nasDir: string;
  stop(): Promise<void>;
}

function getFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, host === '0.0.0.0' ? undefined : host, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export async function createMockDeck(opts: MockDeckOptions): Promise<MockDeck> {
  const host = opts.host ?? '127.0.0.1';
  const mediaDir = opts.mediaDir;
  const ftpRoot = path.join(mediaDir, 'ftp');
  const nasDir = path.join(mediaDir, 'nas');
  const seconds = { camA: 6, interview: 4, nas: 5, ...opts.clipSeconds };
  const verbose = Boolean(opts.verbose);

  const slots: Record<number, Slot> = {
    1: { dir: path.join(ftpRoot, 'ssd1'), name: 'ssd1', files: [] },
    2: { dir: path.join(ftpRoot, 'ssd2'), name: 'ssd2', files: [] },
    3: { dir: nasDir, name: 'nas', files: [] },
  };

  const makeClip = (dir: string, name: string, durationSeconds: number, tc: string, pattern: string, codec: 'prores' | 'h264') => {
    const out = path.join(dir, name);
    if (fs.existsSync(out)) return;
    fs.mkdirSync(dir, { recursive: true });
    const v = codec === 'prores'
      ? ['-c:v', 'prores_ks', '-profile:v', '0']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-pix_fmt', 'yuv420p'];
    const args = (vf: string) => [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `${pattern}=size=1280x720:rate=${FPS}:duration=${durationSeconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSeconds}`,
      ...(vf ? ['-vf', vf] : []),
      ...v, '-c:a', codec === 'prores' ? 'pcm_s16le' : 'aac', '-timecode', tc, out,
    ];
    // Burn in the clip name + frame number for a visual cue when scrubbing — but
    // `drawtext` needs a font/text-rendering library that a minimal/static ffmpeg
    // build (e.g. the one bundled with packaged releases) may not have compiled
    // in. Fall back to the plain pattern (still distinct per slot/clip) rather
    // than failing to generate test media at all.
    const withText = `drawtext=text='${name.replace(/[':]/g, '')} %{frame_num}':x=40:y=40:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6${codec === 'prores' ? ',format=yuv422p10le' : ''}`;
    try {
      execFileSync(opts.ffmpeg, args(withText), { stdio: 'pipe' });
    } catch {
      execFileSync(opts.ffmpeg, args(codec === 'prores' ? 'format=yuv422p10le' : ''), { stdio: 'pipe' });
    }
  };

  /** Scan a folder for media files and probe each one — same shape used at startup for the fixed
   *  slots and again whenever slot 3 is repointed at a real mapped NAS folder (see below). Probe
   *  failures are skipped per-file rather than aborting the whole scan (a stray non-media/corrupt
   *  file on a real share shouldn't take the slot listing down), and the scan is capped so a huge
   *  real folder doesn't hang the deck.
   */
  //
  // Asynchronous on purpose: this runs inside the app's own server process, and it used to probe
  // each file with two blocking ffprobe calls. On a real NAS folder (~70 files) that froze the
  // whole server for 15 s+ on every start and every NAS reselect — real decks' replies then sat
  // unread until their commands timed out. One probe per file, a few at a time, cached by
  // path/size/mtime so a rescan of an unchanged folder costs a directory listing.
  const probeCache = new Map<string, { key: string; file: MockFile | null }>();
  async function scanSlotFiles(dir: string): Promise<MockFile[]> {
    let names: string[];
    try {
      names = (await fs.promises.readdir(dir)).filter((f) => !f.startsWith('.') && /\.(mov|mp4|mxf|m4v)$/i.test(f)).sort(); // skip hidden stubs (._AppleDouble, partial recordings)
    } catch {
      return [];
    }
    names = names.slice(0, 300);
    const results: (MockFile | null)[] = new Array(names.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < names.length) {
        const i = next++;
        const f = names[i];
        const full = path.join(dir, f);
        try {
          const st = await fs.promises.stat(full);
          const key = `${st.size}|${st.mtimeMs}`;
          const hit = probeCache.get(full);
          if (hit?.key === key) { results[i] = hit.file; continue; }
          let file: MockFile | null = null;
          try {
            const { stdout } = await execFileAsync(opts.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream_tags=timecode:format_tags=timecode', '-of', 'json', full], { timeout: 15000 });
            const j = JSON.parse(stdout) as { format?: { duration?: string; tags?: { timecode?: string } }; streams?: { tags?: { timecode?: string } }[] };
            const tcTag = j.streams?.map((s) => s.tags?.timecode).find(Boolean) ?? j.format?.tags?.timecode ?? '';
            const m = /(\d+):(\d+):(\d+)[:;](\d+)/.exec(tcTag);
            const tcStart = m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * FPS + Number(m[4]) : 0;
            file = { name: f, frames: Math.round((Number(j.format?.duration) || 0) * FPS), format: /\.mp4$/i.test(f) ? 'H.264High' : 'QuickTimeProRes', tcStart };
          } catch {
            // unreadable/unprobeable file on a real share — skip it rather than failing the listing
          }
          probeCache.set(full, { key, file });
          results[i] = file;
        } catch { /* vanished between listing and stat */ }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return results.filter((x): x is MockFile => x !== null);
  }

  async function prepareMedia() {
    if (verbose) console.log('[mock] preparing test clips…');
    makeClip(slots[1].dir, 'Studio Cam A_0001.mov', seconds.camA, '10:00:00:00', 'testsrc2', 'prores');
    makeClip(slots[1].dir, 'Studio Cam A_0002.mov', Math.max(2, Math.round(seconds.camA * 0.6)), '10:05:00:00', 'smptehdbars', 'prores');
    makeClip(slots[2].dir, 'Interview_0001.mp4', seconds.interview, '11:00:00:00', 'rgbtestsrc', 'h264');
    makeClip(slots[3].dir, 'NAS Record_0001.mov', seconds.nas, '12:00:00:00', 'testsrc', 'prores');
    for (const s of Object.values(slots)) s.files = await scanSlotFiles(s.dir);
  }

  // ------------------------------------------------------- NAS slot 3 <-> selected bookmark
  // Slot 3 defaults to the canned local `nasDir` demo clip. When a NAS bookmark is selected
  // (Network storage (deck) settings) and its URL/credentials actually resolve to a reachable
  // folder on this host, slot 3 is repointed there so it lists (and can play back) what's really
  // on that share, instead of always showing the fixed demo clip regardless of which NAS is
  // "selected". Falls back to the demo clip whenever the real share can't be reached, rather than
  // showing an empty/broken slot.
  function toUncPath(url: string): string | null {
    const u = url.trim();
    if (/^\\\\/.test(u)) return u.replace(/[\\/]+$/, '');
    const m = /^(?:smb|cifs):\/\/([^/]+)\/?(.*)$/i.exec(u);
    if (!m) return null;
    const rest = m[2] ? m[2].replace(/\//g, '\\') : '';
    return `\\\\${m[1]}${rest ? '\\' + rest : ''}`.replace(/[\\/]+$/, '');
  }
  async function connectNas(shareRoot: string, username?: string, password?: string): Promise<boolean> {
    if (process.platform !== 'win32') return true; // nothing we can automate — just try reading directly
    if (!username) return true;
    try {
      await execFileAsync('net', ['use', shareRoot, '/delete', '/y']).catch(() => {});
      await execFileAsync('net', ['use', shareRoot, password ?? '', `/user:${username}`, '/persistent:no']);
      return true;
    } catch {
      return false;
    }
  }
  let refreshSeq = 0;
  async function refreshSlot3ForSelection() {
    const seq = ++refreshSeq;
    const sel = rest.nas.selected;
    const bm = sel ? rest.nas.bookmarks.find((x) => x.url === sel) : undefined;
    const target = sel ? toUncPath(sel) : null;
    let dir = nasDir;
    if (target) {
      const shareRoot = /^(\\\\[^\\]+\\[^\\]+)/.exec(target)?.[1] ?? target;
      const connected = await connectNas(shareRoot, bm?.username, bm?.password);
      if (connected) {
        try {
          await fs.promises.access(target, fs.constants.R_OK);
          dir = target;
        } catch {
          // not reachable from this host — fall back to the demo clip below
        }
      }
    }
    if (seq !== refreshSeq) return; // superseded by a newer selection change
    slots[3].dir = dir;
    const files = await scanSlotFiles(dir);
    if (seq !== refreshSeq) return; // superseded while scanning
    slots[3].files = files;
    // Deliberately does NOT touch deck.timeline/rebuildTimeline() here: changing which NAS
    // bookmark is selected should only update what's *available* to browse/load from slot 3,
    // not silently dump every clip on a (possibly large, messy) real share onto the deck's
    // playback queue. The timeline only rebuilds from an explicit "slot select" action below.
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

  // Setup menu state (Ethernet "configuration" + REST).
  const config: Record<string, string> = {
    'audio input': 'embedded', 'video input': 'SDI', 'file format': 'QuickTimeProResHQ', 'audio codec': 'PCM',
    'timecode input': 'external', 'timecode output': 'clip', 'timecode preference': 'default', 'timecode preset': '00:00:00:00',
    'audio input channels': '8', 'record trigger': 'none', 'record prefix': 'Studio Cam A', 'append timestamp': 'false',
    'genlock input resync': 'false', 'reference source': 'auto', 'record cache': 'false', 'default standard': '1080p25',
  };
  const misc: Record<string, string> = { 'stop mode': 'lastframe', startup: 'false', 'startup single': 'false', 'playback override': 'off', 'record override': 'off' };
  const rest = {
    codec: { codec: 'ProRes:HQ', container: 'QuickTime' },
    codecs: ['ProRes:HQ', 'ProRes:422', 'ProRes:LT', 'ProRes:Proxy', 'DNxHD:220x', 'H.264:High', 'H.265:High'].map((c) => ({ codec: c, container: c.startsWith('H.') ? 'MP4' : 'QuickTime' })),
    videoFormat: { name: '1080p25', frameRate: '25', height: 1080, width: 1920, interlaced: false },
    videoFormats: ['1080p25', '1080p50', '1080i50', '1080p2997', '2160p25'].map((n) => ({ name: n, frameRate: n.replace(/^\d+[pi]/, ''), height: n.startsWith('2160') ? 2160 : 1080, width: n.startsWith('2160') ? 3840 : 1920, interlaced: n.includes('i') })),
    audio: { codec: 'PCM', numChannels: 8 },
    input: 'SDI',
    monitoring: { cleanFeed: false, displayLUT: false, zebra: false, focusAssist: false, frameGuide: false, falseColor: false } as Record<string, boolean>,
    // Simulated NAS bookmarks/selection, so the "Network storage (deck)" settings UI has something
    // real to exercise against a test HyperDeck instead of only failing with 404.
    nas: {
      bookmarks: [...(opts.nas?.bookmarks ?? [])],
      selected: opts.nas?.selected ?? null,
    } as MockNasState,
  };
  const nasChanged = () => opts.onNasChange?.({ bookmarks: rest.nas.bookmarks.map((b) => ({ ...b })), selected: rest.nas.selected });
  // A restored selection should point slot 3 back at that share straight away.
  if (rest.nas.selected) void refreshSlot3ForSelection();

  // The NAS slot's reported "volume name" should track whichever bookmark is
  // currently selected (matches how a real deck names the mounted share), not a
  // name fixed when the mock deck was created — otherwise switching the active
  // NAS mapping (e.g. to Bamboo) leaves the Clips panel still reading "Studio NAS".
  function nasVolumeName(): string {
    const url = rest.nas.selected;
    if (!url) return 'NAS (unmounted)';
    const m = /^(?:smb:\/\/|\\\\)([^/\\]+)/i.exec(url);
    return m ? m[1] : 'NAS';
  }

  const clients = new Set<net.Socket>();
  const notifyOn = new WeakMap<net.Socket, Set<string>>();
  function notify(kind: string, code: number, title: string, lines: string[]) {
    for (const s of clients) if (notifyOn.get(s)?.has(kind)) s.write(`${code} ${title}:\r\n${lines.join('\r\n')}\r\n\r\n`);
  }
  const pushTransport = () => notify('transport', 508, 'transport info', transportLines());

  // Advance one frame per tick, like a real deck, sending display timecode each frame.
  let frac = 0;
  const tick = setInterval(() => {
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
    notify('display timecode', 513, 'display timecode', [`display timecode: ${tc(deck.position)}`]);
    notify('timeline position', 514, 'timeline position', [`timeline: ${deck.position}`]);
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
        return block(204, 'device info', ['protocol version: 1.13', 'model: HyperDeck Studio HD Pro (Test)', 'unique id: 00000000mock', 'slot count: 3', 'software version: 8.4', 'name: Test HyperDeck']);
      case 'remote':
        if (params.enable) { deck.remote = params.enable === 'true'; notify('remote', 510, 'remote info', [`enabled: ${deck.remote}`, 'override: false']); return ok; }
        return block(210, 'remote info', [`enabled: ${deck.remote}`, 'override: false']);
      case 'transport info': return block(208, 'transport info', transportLines());
      case 'slot info': {
        const id = Number(params['slot id'] ?? deck.slotId);
        const s = slots[id];
        if (!s) return '102 invalid value\r\n';
        return block(202, 'slot info', [`slot id: ${id}`, `slot name: ${s.name}`, `device name: ${s.name}`, 'status: mounted', `volume name: ${id === 3 ? nasVolumeName() : 'Media ' + id}`, 'recording time: 3600', 'video format: 1080p25', 'blocked: false', 'remaining size: 100000000000', 'total size: 500000000000']);
      }
      case 'nas selected': return block(224, 'nas selected', rest.nas.selected ? [`url: ${rest.nas.selected}`] : ['url: none']);
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
        // Slot 3 is network storage — a general media library (a real NAS folder can hold
        // dozens/hundreds of unrelated files), not the deck's own sequential recording, so
        // selecting it starts with an empty timeline rather than dumping every file it can see
        // onto the play queue. Slots 1/2 (local media, the deck's own small recorded clips) keep
        // the previous behaviour of loading straight onto the timeline when selected.
        if (id === 3) { deck.timeline = []; deck.position = 0; } else rebuildTimeline();
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
      case 'playrange set': case 'playrange clear': case 'identify': return ok;
      case 'configuration': {
        if (Object.keys(params).length === 0) return block(211, 'configuration', Object.entries(config).map(([k, v]) => `${k}: ${v}`));
        for (const [k, v] of Object.entries(params)) {
          if (!(k in config)) return '101 unsupported parameter\r\n';
          if (k === 'file format' && !/^(QuickTime|DNx|H\.26)/.test(v)) return '102 invalid value\r\n';
          config[k] = v;
        }
        notify('configuration', 511, 'configuration', Object.entries(params).map(([k, v]) => `${k}: ${v}`));
        return ok;
      }
      case 'play option':
        if (params['stop mode']) { misc['stop mode'] = params['stop mode']; return ok; }
        return block(219, 'play option', [`stop mode: ${misc['stop mode']}`]);
      case 'play on startup':
        if (params.enable) { misc.startup = params.enable; return ok; }
        if (params['single clip']) { misc['startup single'] = params['single clip']; return ok; }
        return block(213, 'play on startup', [`enable: ${misc.startup}`, `single clip: ${misc['startup single']}`]);
      case 'dynamic range':
        if (params['playback override']) { misc['playback override'] = params['playback override']; return ok; }
        if (params['record override']) { misc['record override'] = params['record override']; return ok; }
        return block(215, 'dynamic range', [`playback override: ${misc['playback override']}`, `record override: ${misc['record override']}`]);
      case 'format':
        if (params.prepare) return block(216, 'format ready', ['token: mock-token-123']);
        if (params.confirm === 'mock-token-123') return ok;
        return '161 invalid token\r\n';
      case 'reboot': return ok;
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

  await prepareMedia();
  rebuildTimeline();

  const port = opts.port && opts.port > 0 ? opts.port : await getFreePort(host);
  const ftpPort = opts.ftpPort && opts.ftpPort > 0 ? opts.ftpPort : await getFreePort(host);
  const restPort = opts.restPort && opts.restPort > 0 ? opts.restPort : await getFreePort(host);

  const protocolServer = net.createServer((sock) => {
    clients.add(sock);
    sock.setEncoding('utf8');
    sock.write('500 connection info:\r\nprotocol version: 1.13\r\nmodel: HyperDeck Studio HD Pro (Test)\r\n\r\n');
    let buf = '';
    sock.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        if (verbose) console.log('[mock] <', line);
        sock.write(handle(sock, line));
      }
    });
    sock.on('close', () => clients.delete(sock));
    sock.on('error', () => clients.delete(sock));
  });
  await new Promise<void>((resolve, reject) => {
    protocolServer.on('error', reject);
    protocolServer.listen(port, host, () => resolve());
  });
  if (verbose) console.log(`[mock] HyperDeck protocol on ${host}:${port}`);

  // Minimal REST API (real decks serve this on port 80 at /control/api/v1).
  const http = await import('node:http');
  const restServer = http.createServer((req, res) => {
    const url = (req.url ?? '').replace(/^\/control\/api\/v1/, '');
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = (code: number, v?: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(v === undefined ? '' : JSON.stringify(v)); };
      const put = req.method === 'PUT' ? JSON.parse(body || '{}') : null;
      const parsedBody = (req.method === 'PUT' || req.method === 'POST') ? JSON.parse(body || '{}') : null;
      const mon = /^\/monitoring\/([^/]+)\/(\w+)$/.exec(url);
      const nasBookmarkMatch = /^\/media\/nas\/bookmarks\/(.+)$/.exec(url);
      if (url === '/system/product') return json(200, { deviceName: 'Test Deck', productName: 'HyperDeck Studio HD Pro (Test)', softwareVersion: '8.4' });
      if (url === '/system/codecFormat') { if (put) { rest.codec = put; return json(204); } return json(200, rest.codec); }
      if (url === '/system/supportedCodecFormats') return json(200, { codecs: rest.codecs });
      if (url === '/system/videoFormat') { if (put) { rest.videoFormat = put; return json(204); } return json(200, rest.videoFormat); }
      if (url === '/system/supportedVideoFormats') return json(200, { formats: rest.videoFormats });
      if (url === '/audio/recordFormat') { if (put) { rest.audio = put; return json(204); } return json(200, rest.audio); }
      if (url === '/audio/supportedRecordFormats') return json(200, { supportedRecordFormats: [2, 4, 8, 16].flatMap((n) => [{ format: { codec: 'PCM', numChannels: n }, available: true }, { format: { codec: 'AAC', numChannels: 2 }, available: n === 2 }]).filter((x, i, a) => a.findIndex((y) => JSON.stringify(y.format) === JSON.stringify(x.format)) === i) });
      if (url === '/transports/0/inputVideoSource') { if (put) { rest.input = put.inputVideoSource; return json(204); } return json(200, { inputVideoSource: rest.input }); }
      if (url === '/transports/0/supportedInputVideoSources') return json(200, { supportedInputVideoSources: ['SDI', 'HDMI'] });
      if (url === '/monitoring/display') return json(200, { displays: ['LCD', 'SDI'] });
      if (mon && mon[2] in rest.monitoring) { if (put) { rest.monitoring[mon[2]] = put.enabled; return json(204); } return json(200, { enabled: rest.monitoring[mon[2]] }); }
      // Simulated NAS bookmark management — enough for the "Network storage (deck)" settings UI to exercise
      // add/remove/select/discover end to end against a test HyperDeck, not just real hardware.
      if (url === '/media/nas/bookmarks' && req.method === 'GET') return json(200, { bookmarks: rest.nas.bookmarks.map((b) => ({ url: b.url })) });
      if (url === '/media/nas/bookmarks' && req.method === 'POST') {
        const b = parsedBody as { url?: string; username?: string; password?: string };
        if (!b?.url) return json(400, { error: 'url is required' });
        if (!rest.nas.bookmarks.some((x) => x.url === b.url)) rest.nas.bookmarks.push({ url: b.url, username: b.username, password: b.password });
        nasChanged();
        return json(204);
      }
      if (nasBookmarkMatch && req.method === 'PUT') {
        const target = decodeURIComponent(nasBookmarkMatch[1]);
        const b = parsedBody as { username?: string; password?: string };
        let bm = rest.nas.bookmarks.find((x) => x.url === target);
        if (!bm) { bm = { url: target }; rest.nas.bookmarks.push(bm); }
        if (b?.username !== undefined) bm.username = b.username;
        if (b?.password !== undefined) bm.password = b.password;
        if (rest.nas.selected === target) void refreshSlot3ForSelection(); // credentials for the active bookmark changed
        nasChanged();
        return json(204);
      }
      if (nasBookmarkMatch && req.method === 'DELETE') {
        const target = decodeURIComponent(nasBookmarkMatch[1]);
        rest.nas.bookmarks = rest.nas.bookmarks.filter((x) => x.url !== target);
        if (rest.nas.selected === target) { rest.nas.selected = null; void refreshSlot3ForSelection(); }
        nasChanged();
        return json(204);
      }
      if (url === '/media/nas/selected' && req.method === 'GET') return json(200, { selected: rest.nas.selected ? { url: rest.nas.selected } : null });
      if (url === '/media/nas/selected' && req.method === 'PUT') {
        const b = parsedBody as { selected: { url: string } | null };
        rest.nas.selected = b?.selected?.url ?? null;
        void refreshSlot3ForSelection();
        nasChanged();
        return json(204);
      }
      if (url === '/media/nas/discovered' && req.method === 'GET') {
        return json(200, { hosts: [{ hostName: 'nas.local', friendlyName: 'Simulated Studio NAS', ip: '127.0.0.1' }] });
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    restServer.on('error', reject);
    restServer.listen(restPort, host, () => resolve());
  });
  if (verbose) console.log(`[mock] REST API on ${host}:${restPort}/control/api/v1`);

  const { FtpSrv } = await import('ftp-srv');
  const pasvBase = 31000 + crypto.randomInt(0, 3000);
  const ftp = new FtpSrv({
    url: `ftp://${host === '0.0.0.0' ? '0.0.0.0' : host}:${ftpPort}`,
    anonymous: true,
    pasv_url: '127.0.0.1',
    pasv_min: pasvBase,
    pasv_max: pasvBase + 20,
    log: { info() {}, debug() {}, trace() {}, warn() {}, error() {}, child() { return this; } } as any,
  });
  ftp.on('login', (_d, resolve) => resolve({ root: ftpRoot }));
  await ftp.listen();
  if (verbose) console.log(`[mock] FTP on ${host}:${ftpPort} (root ${ftpRoot})`);

  return {
    host,
    port,
    ftpPort,
    restPort,
    nasDir,
    async stop() {
      clearInterval(tick);
      for (const s of clients) s.destroy();
      await Promise.all([
        new Promise<void>((resolve) => protocolServer.close(() => resolve())),
        new Promise<void>((resolve) => restServer.close(() => resolve())),
        ftp.close().catch(() => {}),
      ]);
    },
  };
}
