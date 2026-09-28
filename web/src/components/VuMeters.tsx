import { useEffect, useRef, useState } from 'react';
import { levelDb } from '../lib/audio';

const FLOOR = -60;
const HOLD_MS = 1500;
const FALL_DB_PER_S = 20;
const SCALE = [0, -6, -18, -30, -48];

const pct = (db: number) => Math.max(0, Math.min(1, (db - FLOOR) / -FLOOR)) * 100;

/**
 * Vertical per-channel meters (peak programme style): the bar is the peak level with a
 * ballistic fall, the tick above it is the peak hold, and the red cap lights on clipping
 * (a window that reached 0 dBFS). `levels` is null when nothing is playing — the bars then
 * fall away rather than freezing.
 */
export function VuMeters({ levels, channels }: {
  levels: { peak: number; rms: number }[] | null;
  channels: number;
}) {
  // Ballistics live in a ref: this re-renders every frame during playback anyway.
  const st = useRef<{ at: number; shown: number[]; hold: number[]; holdAt: number[]; clipAt: number[] }>({
    at: performance.now(), shown: [], hold: [], holdAt: [], clipAt: [],
  });
  const [, tick] = useState(0);
  const now = performance.now();
  const dt = Math.min(0.5, (now - st.current.at) / 1000);
  st.current.at = now;
  const n = Math.max(1, Math.min(16, channels));
  const bars = Array.from({ length: n }, (_, c) => {
    const s = st.current;
    const target = levels?.[c] ? levelDb(levels[c].peak) : -Infinity;
    const prev = s.shown[c] ?? -Infinity;
    const fallen = Number.isFinite(prev) ? prev - FALL_DB_PER_S * dt : -Infinity;
    const shown = Math.max(target, fallen < FLOOR ? -Infinity : fallen);
    s.shown[c] = shown;
    if (shown >= (s.hold[c] ?? -Infinity) || now - (s.holdAt[c] ?? 0) > HOLD_MS) { s.hold[c] = shown; s.holdAt[c] = now; }
    if (target >= 0) s.clipAt[c] = now;
    return { shown, hold: s.hold[c], clip: now - (s.clipAt[c] ?? -1e9) < HOLD_MS, rms: levels?.[c] ? levelDb(levels[c].rms) : -Infinity };
  });

  // Once playback stops nothing else re-renders us, so animate the fall-off ourselves.
  const falling = !levels && bars.some((b) => Number.isFinite(b.shown) || Number.isFinite(b.hold));
  useEffect(() => {
    if (!falling) return;
    const id = requestAnimationFrame(() => tick((n) => n + 1));
    return () => cancelAnimationFrame(id);
  });

  return (
    <div className="vu" role="meter" aria-label="Audio levels"
      title={bars.map((b, i) => `A${i + 1}: ${Number.isFinite(b.shown) ? `${b.shown.toFixed(1)} dBFS peak, ${Number.isFinite(b.rms) ? b.rms.toFixed(1) : '−∞'} RMS` : 'silent'}`).join('\n')}>
      <div className="vu-scale" aria-hidden>
        {SCALE.map((db) => <span key={db} style={{ bottom: `${pct(db)}%` }}>{db}</span>)}
      </div>
      {bars.map((b, i) => (
        <div key={i} className="vu-ch">
          <div className={`vu-clip ${b.clip ? 'on' : ''}`} />
          <div className="vu-bar">
            <div className="vu-fill" style={{ clipPath: `inset(${100 - pct(b.shown)}% 0 0 0)` }} />
            {Number.isFinite(b.hold) && <div className="vu-hold" style={{ bottom: `${pct(b.hold)}%` }} />}
          </div>
          <span className="vu-label">{i + 1}</span>
        </div>
      ))}
    </div>
  );
}
