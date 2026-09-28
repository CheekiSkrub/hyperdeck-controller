import { useEffect, useRef, useState } from 'react';
import { fpsFromFormat, framesToTc, tcToFrames } from '../lib/tc';
import type { TransportInfo } from '../lib/types';

const MOVING = new Set(['play', 'forward', 'rewind', 'shuttle']);
/** How far ahead of the last deck report we're willing to run (seconds). */
const MAX_LEAD = 0.5;

/**
 * Timecode display that ticks every video frame. The deck reports its
 * position over the network (typically every frame, but with jitter); while
 * it's moving we extrapolate from the last report at the current speed and
 * resync on every update, so the clock runs smoothly at the true frame rate.
 */
export function LiveTimecode({ transport, className }: { transport: TransportInfo; className?: string }) {
  const fps = fpsFromFormat(transport.videoFormat) ?? 25;
  const dropFrame = transport.displayTimecode.includes(';');
  const anchor = useRef({ frames: tcToFrames(transport.displayTimecode, fps), at: performance.now() });
  const shown = useRef(anchor.current.frames);
  const [text, setText] = useState(transport.displayTimecode);

  useEffect(() => {
    const frames = tcToFrames(transport.displayTimecode, fps);
    anchor.current = { frames, at: performance.now() };
    const forward = transport.speed >= 0;
    // Ignore a report that is just behind what we've already shown (network jitter)
    // so the clock never visibly steps backwards during normal play.
    const behind = forward ? shown.current - frames : frames - shown.current;
    if (!MOVING.has(transport.status) || behind > 2 || behind <= 0) {
      shown.current = frames;
      setText(transport.displayTimecode);
    }
  }, [transport.displayTimecode, transport.status, transport.speed, fps]);

  useEffect(() => {
    if (!MOVING.has(transport.status) || transport.speed === 0) return;
    let raf = 0;
    const rate = (fps * transport.speed) / 100;
    const tick = () => {
      const elapsed = Math.min((performance.now() - anchor.current.at) / 1000, MAX_LEAD);
      const f = Math.floor(anchor.current.frames + elapsed * rate);
      const ahead = rate >= 0 ? f > shown.current : f < shown.current;
      if (ahead) {
        shown.current = f;
        setText(framesToTc(f, fps).replace(/:(\d{2})$/, dropFrame ? ';$1' : ':$1'));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [transport.status, transport.speed, fps, dropFrame]);

  return <div className={className} aria-label="Timecode">{text}</div>;
}
