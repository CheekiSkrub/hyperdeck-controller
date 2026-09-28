import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { EditEntry, SavedTimeline } from '../lib/types';

/**
 * Multiple named timelines per device: save the current edit list under a
 * name, come back and load a different one onto the deck, rename or delete
 * saved ones. Loading replaces the deck's timeline the same way any other
 * edit does.
 */
export function SavedTimelines({ deviceId, currentEntries, onLoaded, notify }: {
  deviceId: string;
  currentEntries: EditEntry[];
  onLoaded: (entries: EditEntry[]) => void;
  notify: (m: string, kind?: 'ok' | 'err') => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<SavedTimeline[] | null>(null);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = () => api.timelines(deviceId).then(setList).catch(() => setList([]));

  useEffect(() => { if (open) refresh(); }, [open, deviceId]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const saveNew = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await api.saveTimeline(deviceId, newName.trim(), currentEntries);
      setNewName('');
      notify(`Saved "${newName.trim()}"`, 'ok');
      refresh();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const load = async (t: SavedTimeline) => {
    setBusy(true);
    try {
      const entries = await api.loadTimeline(t.id);
      onLoaded(entries);
      notify(`Loaded "${t.name}" onto the deck`, 'ok');
      setOpen(false);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const overwrite = async (t: SavedTimeline) => {
    setBusy(true);
    try {
      await api.overwriteTimeline(t.id, currentEntries);
      notify(`Updated "${t.name}" with the current timeline`, 'ok');
      refresh();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (t: SavedTimeline) => {
    if (!renameValue.trim()) { setRenaming(null); return; }
    try {
      await api.renameTimeline(t.id, renameValue.trim());
      setRenaming(null);
      refresh();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const remove = async (t: SavedTimeline) => {
    try {
      await api.deleteTimeline(t.id);
      refresh();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  return (
    <div className="saved-timelines" ref={ref}>
      <button type="button" className="btn small ghost" onClick={() => setOpen(!open)} title="Save the current timeline, or switch to a saved one">
        Timelines {list ? `(${list.length})` : ''} ▾
      </button>
      {open && (
        <div className="saved-timelines-pop">
          {list === null && <p className="muted small">Loading…</p>}
          {list?.length === 0 && <p className="muted small">No saved timelines yet for this deck.</p>}
          {list && list.length > 0 && (
            <ul className="saved-timelines-list">
              {list.map((t) => (
                <li key={t.id}>
                  {renaming === t.id ? (
                    <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && rename(t)} onBlur={() => rename(t)} />
                  ) : (
                    <span className="stl-name" title={`${t.entries.length} clip${t.entries.length === 1 ? '' : 's'}`}>{t.name}</span>
                  )}
                  <span className="stl-actions">
                    <button type="button" className="btn small ghost" disabled={busy} onClick={() => load(t)}>Load</button>
                    <button type="button" className="btn small ghost" disabled={busy} title="Overwrite with the current timeline" onClick={() => overwrite(t)}>Save</button>
                    <button type="button" className="btn small ghost" onClick={() => { setRenaming(t.id); setRenameValue(t.name); }} title="Rename">✎</button>
                    <button type="button" className="btn small ghost" onClick={() => remove(t)} title="Delete">✕</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="stl-new">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New timeline name"
              onKeyDown={(e) => e.key === 'Enter' && saveNew()} />
            <button type="button" className="btn small primary" disabled={!newName.trim() || busy} onClick={saveNew}>Save current as…</button>
          </div>
        </div>
      )}
    </div>
  );
}
