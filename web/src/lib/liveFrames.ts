import { useEffect, useRef, useState } from 'react';

const MOVING = new Set(['play', 'forward', 'rewind', 'shuttle']);
/** How far ahead of the last deck report we're willing to run (seconds). Decks that only report
 *  position when polled (server/src/hyperdeck/client.ts pollPosition) answer every ~250 ms. */
const MAX_LEAD = 1;

/**
 * A frame counter that advances every video frame between deck reports.
 * While the deck is moving we extrapolate from its last reported position at
 * the current speed and resync on every report; small backwards corrections
 * (network jitter) are ignored so the display never visibly steps back.
 */
export function useLiveFrames(reported: number, status: string, speed: number, fps: number): number {
  const anchor = useRef({ frames: reported, at: performance.now() });
  const shownRef = useRef(reported);
  const [shown, setShown] = useState(reported);

  useEffect(() => {
    anchor.current = { frames: reported, at: performance.now() };
    const behind = speed >= 0 ? shownRef.current - reported : reported - shownRef.current;
    if (!MOVING.has(status) || behind > 2 || behind <= 0) {
      shownRef.current = reported;
      setShown(reported);
    }
  }, [reported, status, speed]);

  useEffect(() => {
    if (!MOVING.has(status) || speed === 0) return;
    let raf = 0;
    const rate = (fps * speed) / 100;
    const tick = () => {
      const elapsed = Math.min((performance.now() - anchor.current.at) / 1000, MAX_LEAD);
      const f = Math.floor(anchor.current.frames + elapsed * rate);
      if (rate >= 0 ? f > shownRef.current : f < shownRef.current) {
        shownRef.current = f;
        setShown(f);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [status, speed, fps]);

  return shown;
}
