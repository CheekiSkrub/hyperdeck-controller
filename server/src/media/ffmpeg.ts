import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let ffmpegBin = 'ffmpeg';
let ffprobeBin = 'ffprobe';

/**
 * Locate ffmpeg/ffprobe: explicit settings > env > next to the executable
 * (how release builds ship it) > PATH.
 */
export function configureFfmpeg(opts: { ffmpegPath?: string; ffprobePath?: string }): { ffmpeg: string; ffprobe: string; ok: boolean } {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const besideExe = path.dirname(process.execPath);
  const candidates = (name: string, explicit?: string, env?: string) => [
    explicit,
    env,
    path.join(besideExe, `${name}${exe}`),
    path.join(besideExe, 'ffmpeg', `${name}${exe}`),
    name,
  ].filter(Boolean) as string[];

  const pick = (list: string[]) => list.find((c) => (c.includes(path.sep) ? fs.existsSync(c) : works(c))) ?? list[list.length - 1];
  ffmpegBin = pick(candidates('ffmpeg', opts.ffmpegPath, process.env.FFMPEG_PATH));
  ffprobeBin = pick(candidates('ffprobe', opts.ffprobePath, process.env.FFPROBE_PATH));
  return { ffmpeg: ffmpegBin, ffprobe: ffprobeBin, ok: works(ffmpegBin) && works(ffprobeBin) };
}

function works(bin: string): boolean {
  try {
    return spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** Options that make network inputs fail fast instead of hanging forever. */
function inputOptions(input: string): string[] {
  if (/^(ftp|http|https):\/\//i.test(input)) return ['-rw_timeout', '20000000'];
  return [];
}

export interface RunOptions {
  signal?: AbortSignal;
  onStderrLine?: (line: string) => void;
  onStdoutLine?: (line: string) => void;
  /** Raw stdout chunks (e.g. streamed PCM) — nothing is buffered for the result when set. */
  onStdoutData?: (chunk: Buffer) => void;
  timeoutMs?: number;
}

function run(bin: string, args: string[], opts: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    let lineBuf = '';
    let outLineBuf = '';
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
    const abort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (d: Buffer) => {
      if (opts.onStdoutData) opts.onStdoutData(d);
      else if (opts.onStdoutLine) {
        outLineBuf += d.toString();
        let i;
        while ((i = outLineBuf.indexOf('\n')) >= 0) {
          opts.onStdoutLine(outLineBuf.slice(0, i).trim());
          outLineBuf = outLineBuf.slice(i + 1);
        }
      } else out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      err = (err + s).slice(-4000);
      if (opts.onStderrLine) {
        lineBuf += s;
        let i;
        while ((i = lineBuf.search(/[\r\n]/)) >= 0) {
          const line = lineBuf.slice(0, i).trim();
          lineBuf = lineBuf.slice(i + 1);
          if (line) opts.onStderrLine(line);
        }
      }
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      if (opts.signal?.aborted) reject(new Error('aborted'));
      else if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

export interface ProbeResult {
  duration: number; // seconds
  startTime: number; // seconds (container start_time)
  fps: number;
  frames: number;
  width: number;
  height: number;
  codec: string;
  profile?: string;
  timecode?: string;
  audioChannels: number;
  /** Number of audio streams (channels may be split across several mono streams). Absent in older cached probes. */
  audioStreams?: number;
  size?: number;
}

function parseRate(r?: string): number {
  if (!r) return 0;
  const [n, d] = r.split('/').map(Number);
  return d ? n / d : n;
}

export async function probe(input: string, signal?: AbortSignal, timeoutMs = 60000): Promise<ProbeResult> {
  const buf = await run(ffprobeBin, [
    '-v', 'error', ...inputOptions(input),
    '-show_entries', 'format=duration,start_time,size:format_tags=timecode:stream=codec_type,codec_name,profile,width,height,r_frame_rate,avg_frame_rate,nb_frames,channels:stream_tags=timecode',
    '-of', 'json', input,
  ], { signal, timeoutMs });
  const j = JSON.parse(buf.toString());
  const v = (j.streams ?? []).find((s: any) => s.codec_type === 'video') ?? {};
  const audio = (j.streams ?? []).filter((s: any) => s.codec_type === 'audio');
  const fps = parseRate(v.r_frame_rate) || parseRate(v.avg_frame_rate) || 25;
  const duration = Number(j.format?.duration ?? 0);
  const tc = (j.streams ?? []).map((s: any) => s.tags?.timecode).find(Boolean) ?? j.format?.tags?.timecode;
  return {
    duration,
    startTime: Number(j.format?.start_time ?? 0) || 0,
    fps,
    frames: Number(v.nb_frames) || Math.round(duration * fps),
    width: v.width ?? 0,
    height: v.height ?? 0,
    codec: v.codec_name ?? 'unknown',
    profile: v.profile,
    timecode: tc,
    audioChannels: audio.reduce((n: number, s: any) => n + (s.channels ?? 0), 0),
    audioStreams: audio.length,
    size: j.format?.size ? Number(j.format.size) : undefined,
  };
}

/** Level windows per second produced by audioLevels(). */
export const LEVEL_RATE = 20;
const LEVEL_SR = 8000;

/** dBFS -> one byte: 0.25 dB steps from -60 dBFS (0) up to +3.75 dBFS (255). */
function quantizeDb(amplitude: number): number {
  if (amplitude <= 0) return 0;
  const db = 20 * Math.log10(amplitude);
  return Math.max(0, Math.min(255, Math.round((db + 60) * 4)));
}

/**
 * Decode a clip's audio once and reduce it to per-channel levels: LEVEL_RATE windows a second,
 * each channel stored as two bytes [peak, rms] (see quantizeDb). Enough for a waveform at any
 * zoom a timeline needs, and for VU meters driven from the playhead position — the deck's own
 * audio output never reaches the browser, so this is how the panel knows what's playing.
 *
 * Reads the whole file (the demuxer has to walk past the video too), so it's a background job.
 * Audio is downsampled to 8 kHz first, which is plenty for metering.
 */
export async function audioLevels(
  input: string, streams: number, channels: number, durationSec: number,
  onProgress: (p: number) => void, signal?: AbortSignal,
): Promise<{ channels: number; count: number; data: Buffer }> {
  // HyperDeck files may carry one multichannel stream or several mono ones — merge the latter
  // (amerge's output has the sum of its inputs' channels, i.e. the probe's audioChannels).
  const map = streams > 1
    ? ['-filter_complex', `${Array.from({ length: streams }, (_, i) => `[0:a:${i}]`).join('')}amerge=inputs=${streams}[a]`, '-map', '[a]']
    : ['-map', '0:a:0'];

  const out: Buffer[] = [];
  const chans = channels;
  let pending: Buffer = Buffer.alloc(0);
  const peaks = new Array<number>(chans).fill(0);
  const sums = new Array<number>(chans).fill(0);
  let n = 0;
  let windows = 0;
  const win = LEVEL_SR / LEVEL_RATE;
  const flush = () => {
    const b = Buffer.alloc(chans * 2);
    for (let c = 0; c < chans; c++) {
      b[c * 2] = quantizeDb(peaks[c]);
      b[c * 2 + 1] = quantizeDb(Math.sqrt(sums[c] / Math.max(1, n)));
      peaks[c] = 0;
      sums[c] = 0;
    }
    out.push(b);
    n = 0;
    windows++;
    if (durationSec > 0 && windows % (LEVEL_RATE * 10) === 0) onProgress(Math.min(0.99, windows / LEVEL_RATE / durationSec));
  };

  await run(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', ...inputOptions(input),
    '-i', input, '-vn', '-sn', '-dn', ...map,
    '-ar', String(LEVEL_SR), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
  ], {
    signal,
    onStdoutData: (chunk) => {
      const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const frame = chans * 2;
      const usable = buf.length - (buf.length % frame);
      for (let off = 0; off < usable; off += frame) {
        for (let c = 0; c < chans; c++) {
          const s = buf.readInt16LE(off + c * 2) / 32768;
          const a = s < 0 ? -s : s;
          if (a > peaks[c]) peaks[c] = a;
          sums[c] += s * s;
        }
        if (++n >= win) flush();
      }
      pending = buf.subarray(usable);
    },
  });
  if (n > 0) flush();
  onProgress(1);
  return { channels: chans, count: windows, data: Buffer.concat(out) };
}

/**
 * Grab one frame as JPEG. Input seeking (-ss before -i) is frame accurate when
 * decoding and only reads the bytes it needs, so this works directly against
 * huge files on FTP or a share.
 */
export async function grabFrame(input: string, seconds: number, height: number, signal?: AbortSignal, timeoutMs = 60000): Promise<Buffer> {
  const args = [
    '-hide_banner', '-loglevel', 'error', ...inputOptions(input),
    ...(seconds > 0 ? ['-ss', seconds.toFixed(3)] : []),
    '-i', input,
    '-frames:v', '1', '-an', '-sn',
    '-vf', `scale=-2:${height}:flags=bilinear,format=yuvj420p`,
    '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
  ];
  const buf = await run(ffmpegBin, args, { signal, timeoutMs });
  if (!buf.length) throw new Error('No frame decoded (past end of clip?)');
  return buf;
}

/**
 * Transcode a browser-friendly H.264 proxy with a short GOP so <video> seeking
 * is snappy while scrubbing. Reports progress 0..1.
 */
export async function makeProxy(
  input: string, output: string, height: number, durationSec: number,
  onProgress: (p: number) => void, signal?: AbortSignal,
): Promise<void> {
  const tmp = output + '.part.mp4';
  await run(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y', ...inputOptions(input), '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=-2:${height},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-g', '12', '-keyint_min', '12', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    tmp,
  ], {
    signal,
    onStdoutLine: (line) => {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m && durationSec > 0) onProgress(Math.min(0.999, Number(m[1]) / 1e6 / durationSec));
    },
  });
  fs.renameSync(tmp, output);
  onProgress(1);
}

/**
 * Real-time browser playback of any codec: transcode from `seconds` onward to
 * fragmented MP4 (H.264 + AAC) on stdout. Fragmented output can be played by a
 * <video> element while it's still being written. The caller pipes stdout to
 * the HTTP response and kills the process when the viewer disconnects.
 */
export function spawnLive(input: string, seconds: number, height: number) {
  const args = [
    '-hide_banner', '-loglevel', 'error', ...inputOptions(input),
    ...(seconds > 0 ? ['-ss', seconds.toFixed(3)] : []),
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=-2:${height},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '25', '-bf', '0',
    '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '400000',
    'pipe:1',
  ];
  return spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
}

export function ffmpegPaths() {
  return { ffmpeg: ffmpegBin, ffprobe: ffprobeBin };
}
