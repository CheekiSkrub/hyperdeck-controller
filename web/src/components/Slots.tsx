import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatBytes, formatDuration } from '../lib/tc';
import type { Device, ShareSpace } from '../lib/types';

type Send = (command: string, params?: Record<string, string | number | boolean>) => Promise<void>;

export function Slots({ device, send }: { device: Device; send: Send }) {
  const { slots, transport } = device.state;
  const nasSpace = useNasSpace(device);
  if (!slots.length) return null;
  return (
    <section className="slots">
      {slots.map((s) => {
        const active = transport?.slotId === s.slotId;
        // For the network slot, prefer the space the server measured on the mapped share itself.
        const share = nasSpace?.slotId === s.slotId ? nasSpace.space : null;
        const total = share ? share.total : s.totalSize;
        const free = share ? share.free : s.remainingSize;
        // The deck's rec time is its free space at the current codec's bitrate; rescale it to the share's free space.
        const recTime = share && s.recordingTime && s.remainingSize ? s.recordingTime * (share.free / s.remainingSize) : s.recordingTime;
        const used = total && free !== undefined ? 1 - free / total : 0;
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
                <div className="muted small" title={share ? `Measured on ${share.label} (${share.path})` : 'As reported by the deck'}>
                  {formatBytes(free)} free{total ? ` of ${formatBytes(total)}` : ''} · {formatDuration(recTime)} rec time{s.blocked ? ' · blocked' : ''}
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

/** Polls the server for the mapped share's space while the deck has a network slot. */
function useNasSpace(device: Device) {
  const [space, setSpace] = useState<{ slotId: number | null; space: ShareSpace | null } | null>(null);
  const nasUrl = device.state.nasUrl;
  useEffect(() => {
    let cancelled = false;
    const load = () => api.nasSpace(device.id).then((r) => { if (!cancelled) setSpace(r); }).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [device.id, nasUrl]);
  return space;
}
