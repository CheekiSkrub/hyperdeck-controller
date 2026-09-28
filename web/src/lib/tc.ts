export function tcBase(fps: number) {
  return Math.round(fps);
}

export function framesToTc(frames: number, fps: number): string {
  const base = tcBase(fps);
  const f = Math.max(0, Math.round(frames));
  const ff = f % base;
  const s = Math.floor(f / base);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

export function tcToFrames(tc: string | undefined, fps: number): number {
  const m = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(tc ?? '');
  if (!m) return 0;
  const [h, mi, s, f] = m.slice(1).map(Number);
  return ((h * 60 + mi) * 60 + s) * tcBase(fps) + f;
}

export function fpsFromFormat(fmt?: string): number | null {
  if (!fmt) return null;
  const m = /(?:p|i)(\d{2,5})$/.exec(fmt);
  if (!m) return /PAL/i.test(fmt) ? 25 : /NTSC/i.test(fmt) ? 29.97 : null;
  const map: Record<string, number> = { '23976': 23.976, '24': 24, '25': 25, '2997': 29.97, '30': 30, '50': 50, '5994': 59.94, '60': 60 };
  const fps = map[m[1]] ?? null;
  return fps && /i\d+$/.test(fmt) ? fps / 2 : fps;
}

export function formatBytes(n?: number): string {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
