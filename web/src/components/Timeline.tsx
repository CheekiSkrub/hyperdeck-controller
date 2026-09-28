import { useRef } from 'react';
import { fpsFromFormat, framesToTc, tcToFrames } from '../lib/tc';
import type { Device } from '../lib/types';

type Send = (command: string, params?: Record<string, string | number | boolean>) => Promise<void>;

/** The deck's current timeline: clip segments, playhead, click to jump. */
export function Timeline({ device, send }: { device: Device; send: Send }) {
  const t = device.state.transport!;
  const clips = device.state.timeline;
  const fps = fpsFromFormat(t.videoFormat) ?? 25;
  const bar = useRef<HTMLDivElement>(null);
  if (clips.length === 0) return <section className="card timeline empty-tl muted">Timeline is empty — select a slot with media, or load a clip below.</section>;

  const durations = clips.map((c) => Math.max(1, tcToFrames(c.duration, fps)));
  const total = durations.reduce((a, b) => a + b, 0);
  const pos = Math.min(total, t.timeline ?? 0);

  const seek = (e: React.MouseEvent) => {
    const r = bar.current!.getBoundingClientRect();
    const frame = Math.round(((e.clientX - r.left) / r.width) * (total - 1));
    void send('goto', { timeline: Math.max(0, frame) });
  };

  let acc = 0;
  return (
    <section className="card timeline">
      <div className="timeline-head">
        <span>Timeline · {clips.length} clip{clips.length === 1 ? '' : 's'}</span>
        <span className="mono muted">{framesToTc(pos, fps)} / {framesToTc(total, fps)}</span>
      </div>
      <div className="timeline-bar" ref={bar} onClick={seek} title="Click to jump">
        {clips.map((c, i) => {
          const left = (acc / total) * 100;
          const width = (durations[i] / total) * 100;
          acc += durations[i];
          return (
            <div key={c.id} className={`tl-clip ${c.id === t.clipId ? 'current' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${c.id}: ${c.name}`}>
              <span>{c.name}</span>
            </div>
          );
        })}
        <div className="tl-head" style={{ left: `${(pos / total) * 100}%` }} />
      </div>
    </section>
  );
}
