import { formatBytes, formatDuration } from '../lib/tc';
import type { Device } from '../lib/types';

type Send = (command: string, params?: Record<string, string | number | boolean>) => Promise<void>;

export function Slots({ device, send }: { device: Device; send: Send }) {
  const { slots, transport } = device.state;
  if (!slots.length) return null;
  return (
    <section className="slots">
      {slots.map((s) => {
        const active = transport?.slotId === s.slotId;
        const used = s.totalSize && s.remainingSize !== undefined ? 1 - s.remainingSize / s.totalSize : 0;
        const mounted = s.status === 'mounted';
        return (
          <div key={s.slotId} className={`slot ${active ? 'active' : ''} ${mounted ? '' : 'unmounted'}`}>
            <div className="slot-top">
              <span className="slot-name">{s.volumeName || s.slotName || `Slot ${s.slotId}`}</span>
              <span className="muted small">{(s.slotName || s.deviceName || '').toUpperCase()}</span>
            </div>
            {mounted ? (
              <>
                <div className="meter"><div style={{ width: `${Math.round(used * 100)}%` }} /></div>
                <div className="muted small">
                  {formatBytes(s.remainingSize)} free · {formatDuration(s.recordingTime)} rec time{s.blocked ? ' · blocked' : ''}
                </div>
              </>
            ) : (
              <div className="muted small">{s.status}</div>
            )}
            {active ? <span className="badge small">ACTIVE</span> : mounted && (
              <button className="btn small ghost" onClick={() => send('slot select', { 'slot id': s.slotId })} disabled={transport?.status === 'record'}>Select</button>
            )}
          </div>
        );
      })}
    </section>
  );
}
