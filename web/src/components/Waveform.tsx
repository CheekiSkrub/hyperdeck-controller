import { useEffect, useRef, type CSSProperties } from 'react';
import { levelDb, type AudioLevels } from '../lib/audio';

/** Heights are in dB, not linear amplitude, as in NLEs — a typical -18 dBFS programme would
 *  otherwise be an eighth of the lane and read as a flat line. Below the floor is drawn as nothing. */
const FLOOR_DB = -54;
const heightOf = (q: number) => (q ? Math.max(0, Math.min(1, (levelDb(q) - FLOOR_DB) / -FLOOR_DB)) : 0);

/**
 * Audio waveform for [from, to) seconds of a clip, drawn to a canvas that fills its box.
 * Mirrored about the centre: the loudest channel's peak as the outer envelope, its RMS as
 * the brighter core — the same peak/RMS pair the VU meters show, on a dB scale.
 */
export function Waveform({ levels, from, to, className, style }: {
  levels: AudioLevels;
  from: number;
  to: number;
  className?: string;
  style?: CSSProperties;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(el.clientWidth * dpr));
      const h = Math.max(1, Math.round(el.clientHeight * dpr));
      if (el.width !== w) el.width = w;
      if (el.height !== h) el.height = h;
      const ctx = el.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      const mid = h / 2;
      const span = Math.max(1e-6, to - from);
      const { channels, rate, count, data } = levels;
      const peakPath = new Path2D();
      const rmsPath = new Path2D();
      for (let x = 0; x < w; x++) {
        // Every level window under this pixel column (at least one), loudest wins.
        const w0 = Math.floor((from + (x / w) * span) * rate);
        const w1 = Math.max(w0 + 1, Math.floor((from + ((x + 1) / w) * span) * rate));
        let peak = 0;
        let rms = 0;
        for (let i = Math.max(0, w0); i < Math.min(count, w1); i++) {
          for (let c = 0; c < channels; c++) {
            const o = (i * channels + c) * 2;
            if (data[o] > peak) peak = data[o];
            if (data[o + 1] > rms) rms = data[o + 1];
          }
        }
        const ph = heightOf(peak) * mid;
        const rh = heightOf(rms) * mid;
        if (ph) peakPath.rect(x, mid - ph, 1, ph * 2);
        if (rh) rmsPath.rect(x, mid - rh, 1, rh * 2);
      }
      ctx.fillStyle = 'rgba(126, 226, 173, 0.45)';
      ctx.fill(peakPath);
      ctx.fillStyle = 'rgba(160, 240, 200, 0.9)';
      ctx.fill(rmsPath);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [levels, from, to]);

  return <canvas ref={canvas} className={`waveform ${className ?? ''}`} style={style} aria-hidden />;
}
