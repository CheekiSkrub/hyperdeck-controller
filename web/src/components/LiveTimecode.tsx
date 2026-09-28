import { useLiveFrames } from '../lib/liveFrames';
import { fpsFromFormat, framesToTc, tcToFrames } from '../lib/tc';
import type { TransportInfo } from '../lib/types';

/** Timecode display that ticks every video frame (see useLiveFrames). */
export function LiveTimecode({ transport, className }: { transport: TransportInfo; className?: string }) {
  const fps = fpsFromFormat(transport.videoFormat) ?? 25;
  const dropFrame = transport.displayTimecode.includes(';');
  const frames = useLiveFrames(tcToFrames(transport.displayTimecode, fps), transport.status, transport.speed, fps);
  const text = framesToTc(frames, fps).replace(/:(\d{2})$/, dropFrame ? ';$1' : ':$1');
  return <div className={className} aria-label="Timecode">{text}</div>;
}
