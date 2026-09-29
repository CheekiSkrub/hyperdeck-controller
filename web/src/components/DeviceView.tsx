import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useEditor } from '../lib/editor';
import { useTimelines } from '../lib/timelines';
import { fpsFromFormat, framesToTc } from '../lib/tc';
import type { ClipListing, Device, EditEntry } from '../lib/types';
import { ClipBrowser } from './ClipBrowser';
import { ClipViewer } from './ClipViewer';
import { SettingsPanel } from './SettingsPanel';
import { Slots } from './Slots';
import { EditTimeline } from './EditTimeline';
import { InstantReplay } from './InstantReplay';
import { TimelineTabs } from './TimelineTabs';
import { Transport } from './Transport';

export function DeviceView({ device, onEdit }: { device: Device; onEdit: () => void }) {
  const s = device.state;
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [tab, setTab] = useState<'control' | 'settings'>('control');
  const [viewing, setViewing] = useState<{ clip: ClipListing; startFrame?: number; editIndex?: number } | null>(null);
  const [replaying, setReplaying] = useState(false);

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
  const deckEditor = useEditor(device, notify);
  const timelines = useTimelines(device, deckEditor, notify);
  const editor = timelines.editor;
  const live = timelines.active ? Boolean(timelines.active.live) : true;
  const [split, setSplit] = useSplit();

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
          <button className="btn small ghost" onClick={() => setReplaying(true)} disabled={!connected} title="Load the last N seconds of another HyperDeck's recording onto this timeline">⏮ Instant replay</button>
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

      {tab === 'settings' && <div className="pane pane-settings"><SettingsPanel device={device} notify={notify} /></div>}

      {tab === 'control' && connected && s.transport && <Transport device={device} send={send} />}

      {tab === 'control' && (
        <div className="workspace" style={{ gridTemplateRows: `minmax(120px, ${split}fr) 8px minmax(120px, ${1 - split}fr)` }}>
          <div className="pane pane-timelines">
            {connected && s.transport ? (
              <>
                <TimelineTabs device={device} timelines={timelines} />
                <EditTimeline key={timelines.active?.id ?? 'deck'} device={device} editor={editor} live={live}
                  send={send} notify={notify} onOpen={openEntry} />
              </>
            ) : (
              <p className="muted">Timelines appear once the HyperDeck is connected.</p>
            )}
          </div>
          <Splitter onDrag={setSplit} />
          <div className="pane pane-content">
            {connected && s.transport && <Slots device={device} send={send} />}
            <ClipBrowser device={device} onOpen={(clip) => setViewing({ clip })} notify={notify} timelines={timelines.filesByTimeline} onRenameTimeline={(id, name) => void timelines.rename(id, name)} />
          </div>
        </div>
      )}

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

      {replaying && <InstantReplay device={device} onClose={() => setReplaying(false)} notify={notify} />}

      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
    </div>
  );
}

const SPLIT_KEY = 'hdc.workspace.split';

/** Share of the workspace given to the timelines (the rest is content), remembered per browser. */
function useSplit(): [number, (v: number) => void] {
  const [split, setSplitState] = useState(() => {
    try { const v = Number(localStorage.getItem(SPLIT_KEY)); return v > 0.1 && v < 0.9 ? v : 0.5; } catch { return 0.5; }
  });
  const setSplit = useCallback((v: number) => {
    const c = Math.min(0.85, Math.max(0.15, v));
    setSplitState(c);
    try { localStorage.setItem(SPLIT_KEY, String(c)); } catch { /* per-viewer convenience only */ }
  }, []);
  return [split, setSplit];
}

/** Drag bar between the timelines and the content. */
function Splitter({ onDrag }: { onDrag: (share: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    const box = ref.current?.parentElement?.getBoundingClientRect();
    if (box) onDrag((e.clientY - box.top) / box.height);
  };
  return (
    <div ref={ref} className="splitter" role="separator" aria-orientation="horizontal" aria-label="Resize timelines and content"
      onPointerDown={(e) => (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)}
      onPointerMove={move} />
  );
}
