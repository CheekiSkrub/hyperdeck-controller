import type { Device } from '../lib/types';
import { StatusBadge } from './StatusBadge';

export function DeviceList({ devices, selectedId, onSelect }: { devices: Device[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (devices.length === 0) return <p className="muted pad">No devices yet.</p>;
  return (
    <ul className="device-list">
      {devices.map((d) => {
        const t = d.state.transport;
        return (
          <li key={d.id}>
            <button className={`device-item ${d.id === selectedId ? 'active' : ''}`} onClick={() => onSelect(d.id)}>
              <span className={`dot ${d.state.status}`} title={d.state.status} />
              <span className="device-item-body">
                <span className="device-item-name">{d.name}{d.test && <span className="badge test">Test</span>}</span>
                <span className="device-item-meta">{d.host}{d.state.info?.model ? ` · ${d.state.info.model.replace(/^HyperDeck /, '')}` : ''}</span>
              </span>
              {d.state.status === 'connected' && t ? (
                <span className="device-item-right">
                  <StatusBadge status={t.status} small />
                  <span className="mono small">{t.displayTimecode}</span>
                </span>
              ) : (
                <span className="device-item-right muted small">{d.state.status}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
