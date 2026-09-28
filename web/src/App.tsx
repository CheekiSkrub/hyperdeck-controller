import { useCallback, useEffect, useRef, useState } from 'react';
import { DeviceForm } from './components/DeviceForm';
import { DeviceList } from './components/DeviceList';
import { DeviceView } from './components/DeviceView';
import { SettingsPage } from './components/SettingsPage';
import { api } from './lib/api';
import { DEMO_BANNER, useDevices, useServerConnected } from './lib/store';
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
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((text: string, kind: 'ok' | 'err' = 'err') => {
    setToast({ text, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  const selected = devices.find((d) => d.id === selectedId) ?? null;
  const [ffmpegMissing, setFfmpegMissing] = useState(false);
  useEffect(() => {
    api.info().then((i) => setFfmpegMissing(!i.ffmpeg.ok)).catch(() => {});
  }, [online]);

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
        <div className="sidebar-actions">
          <button className="btn add-device" onClick={() => setEditing('new')}>+ Add HyperDeck</button>
          <button className="btn ghost" onClick={() => setShowSettings(true)} title="Controller settings">⚙ Settings</button>
        </div>
      </aside>

      <main className="main">
        {DEMO_BANNER && <div className="demo-banner" role="note">{DEMO_BANNER}</div>}
        {ffmpegMissing && (
          <div className="demo-banner warn" role="alert">
            ffmpeg wasn't found, so thumbnails and scrubbing are off (deck control still works). Put ffmpeg and ffprobe next to the app,
            or on Windows run <code>winget install Gyan.FFmpeg</code>, then restart HyperDeck Controller.
          </div>
        )}
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
      {showSettings && <SettingsPage onClose={() => setShowSettings(false)} notify={notify} />}
      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
    </div>
  );
}
