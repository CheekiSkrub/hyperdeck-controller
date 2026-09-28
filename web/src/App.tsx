import { useEffect, useState } from 'react';
import { DeviceForm } from './components/DeviceForm';
import { DeviceList } from './components/DeviceList';
import { DeviceView } from './components/DeviceView';
import { useDevices, useServerConnected } from './lib/store';
import type { Device } from './lib/types';

function useHashDevice(): [string | null, (id: string | null) => void] {
  const read = () => /^#\/device\/(.+)$/.exec(location.hash)?.[1] ?? null;
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = () => setId(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [id, (next) => { location.hash = next ? `#/device/${next}` : ''; }];
}

export function App() {
  const devices = useDevices();
  const online = useServerConnected();
  const [selectedId, select] = useHashDevice();
  const [editing, setEditing] = useState<Device | 'new' | null>(null);
  const selected = devices.find((d) => d.id === selectedId) ?? null;

  // Default to the first device once the list arrives.
  useEffect(() => {
    if (!selected && devices.length > 0 && !selectedId) select(devices[0].id);
  }, [devices, selected, selectedId]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>▣</span>
          <div>
            <div className="brand-name">HyperDeck Controller</div>
            <div className={`server-state ${online ? 'ok' : 'bad'}`}>{online ? 'Server connected' : 'Reconnecting to server…'}</div>
          </div>
        </div>
        <DeviceList devices={devices} selectedId={selected?.id ?? null} onSelect={select} />
        <button className="btn add-device" onClick={() => setEditing('new')}>+ Add HyperDeck</button>
      </aside>

      <main className="main">
        {selected ? (
          <DeviceView key={selected.id} device={selected} onEdit={() => setEditing(selected)} />
        ) : (
          <div className="empty">
            <h2>No HyperDeck selected</h2>
            <p>Add a HyperDeck by name and IP address to start controlling it.</p>
            <button className="btn primary" onClick={() => setEditing('new')}>+ Add HyperDeck</button>
          </div>
        )}
      </main>

      {editing && (
        <DeviceForm
          device={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(d) => { setEditing(null); select(d.id); }}
          onDeleted={() => { setEditing(null); select(null); }}
        />
      )}
    </div>
  );
}
