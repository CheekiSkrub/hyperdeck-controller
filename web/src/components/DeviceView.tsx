import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ClipListing, Device } from '../lib/types';
import { ClipBrowser } from './ClipBrowser';
import { ClipViewer } from './ClipViewer';
import { Slots } from './Slots';
import { Timeline } from './Timeline';
import { Transport } from './Transport';

export function DeviceView({ device, onEdit }: { device: Device; onEdit: () => void }) {
  const s = device.state;
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [viewing, setViewing] = useState<ClipListing | null>(null);

  const notify = useCallback((text: string, kind: 'ok' | 'err' = 'err') => {
    setToast({ text, kind });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  /** Send a protocol command, surfacing errors as a toast. */
  const send = useCallback(async (command: string, params?: Record<string, string | number | boolean>) => {
    try {
      await api.command(device.id, command, params);
    } catch (e) {
      notify((e as Error).message);
    }
  }, [device.id, notify]);

  const connected = s.status === 'connected';

  return (
    <div className="device-view">
      <header className="device-head">
        <div>
          <h1>{device.name}</h1>
          <div className="muted">
            {device.host}
            {s.info?.model && <> · {s.info.model}</>}
            {s.info?.softwareVersion && <> · firmware {s.info.softwareVersion}</>}
          </div>
        </div>
        <div className="head-actions">
          <span className={`conn ${s.status}`}>{s.status === 'connected' ? 'Connected' : s.status === 'connecting' ? 'Connecting…' : 'Offline'}</span>
          <button className="btn small ghost" onClick={() => api.refresh(device.id).catch((e) => notify(e.message))} disabled={!connected}>Refresh</button>
          <button className="btn small" onClick={onEdit}>Edit</button>
        </div>
      </header>

      {!connected && (
        <div className="banner warn">
          Can't reach {device.host}:{device.port}. Check the IP address and that the HyperDeck is on the network. Retrying automatically…
          {s.lastError && <span className="muted"> ({s.lastError})</span>}
        </div>
      )}
      {connected && s.remote && !s.remote.enabled && (
        <div className="banner warn">
          Remote control is disabled on this HyperDeck, so transport commands will be refused.
          <button className="btn small" onClick={() => send('remote', { enable: true })}>Enable remote</button>
        </div>
      )}

      {connected && s.transport && (
        <>
          <Transport device={device} send={send} />
          <Timeline device={device} send={send} />
          <Slots device={device} send={send} />
        </>
      )}

      <ClipBrowser device={device} onOpen={setViewing} notify={notify} />

      {viewing && <ClipViewer device={device} clip={viewing} onClose={() => setViewing(null)} notify={notify} />}

      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
    </div>
  );
}
