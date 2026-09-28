import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useEditor } from '../lib/editor';
import { fpsFromFormat, framesToTc } from '../lib/tc';
import type { ClipListing, Device, EditEntry } from '../lib/types';
import { ClipBrowser } from './ClipBrowser';
import { ClipViewer } from './ClipViewer';
import { SettingsPanel } from './SettingsPanel';
import { Slots } from './Slots';
import { EditTimeline } from './EditTimeline';
import { Transport } from './Transport';

export function DeviceView({ device, onEdit }: { device: Device; onEdit: () => void }) {
  const s = device.state;
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [tab, setTab] = useState<'control' | 'settings'>('control');
  const [viewing, setViewing] = useState<{ clip: ClipListing; startFrame?: number; editIndex?: number } | null>(null);

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
  const editor = useEditor(device, notify);

  /** Open a timeline entry in the viewer, with its in/out as marks. */
  const openEntry = (e: EditEntry, index: number) => {
    const slotId = s.transport?.slotId;
    if (!slotId) return;
    const slot = s.slots.find((x) => x.slotId === slotId);
    const disk = s.disks[slotId]?.find((d) => d.name === e.file);
    const fps = fpsFromFormat(s.transport?.videoFormat) ?? 25;
    setViewing({
      clip: {
        slotId,
        slotLabel: slot?.volumeName || slot?.slotName || `Slot ${slotId}`,
        isNetwork: /nas|network|smb/i.test(`${slot?.slotName} ${slot?.deviceName}`),
        index: disk?.index ?? 0,
        file: e.file,
        fileFormat: disk?.fileFormat ?? '',
        videoFormat: disk?.videoFormat ?? s.transport?.videoFormat ?? '',
        duration: disk?.duration ?? framesToTc(e.frames, fps),
        fps,
        frames: e.frames,
        timelineId: index + 1,
      },
      startFrame: e.in,
      editIndex: index,
    });
  };

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

      <div className="seg tabs" role="tablist" aria-label="View">
        <button role="tab" aria-selected={tab === 'control'} className={tab === 'control' ? 'on' : ''} onClick={() => setTab('control')}>Control</button>
        <button role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>Deck settings</button>
      </div>

      {tab === 'settings' && <SettingsPanel device={device} notify={notify} />}

      {tab === 'control' && connected && s.transport && (
        <>
          <Transport device={device} send={send} />
          <EditTimeline device={device} editor={editor} send={send} notify={notify} onOpen={openEntry} />
          <Slots device={device} send={send} />
        </>
      )}

      {tab === 'control' && <ClipBrowser device={device} onOpen={(clip) => setViewing({ clip })} notify={notify} />}

      {viewing && (
        <ClipViewer
          key={`${viewing.clip.slotId}/${viewing.clip.file}/${viewing.editIndex ?? ''}`}
          device={device}
          clip={viewing.clip}
          startFrame={viewing.startFrame}
          editIndex={viewing.editIndex ?? null}
          editor={editor}
          onClose={() => setViewing(null)}
          notify={notify}
        />
      )}

      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
    </div>
  );
}
