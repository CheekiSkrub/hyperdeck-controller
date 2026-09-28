import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Device, EditEntry } from './types';

export interface Editor {
  entries: EditEntry[];
  /** Replace the whole timeline (optimistic; reverts and reports on failure). */
  commit: (next: EditEntry[]) => Promise<boolean>;
  /** Local-only preview while dragging a trim handle. */
  preview: (next: EditEntry[]) => void;
  append: (entry: EditEntry) => Promise<boolean>;
  busy: boolean;
}

const same = (a: EditEntry[], b: EditEntry[]) =>
  a.length === b.length && a.every((e, i) => e.file === b[i].file && e.in === b[i].in && e.out === b[i].out);

/** Keeps a local, optimistic copy of the deck's edit list. */
export function useEditor(device: Device, notify: (m: string, kind?: 'ok' | 'err') => void): Editor {
  const server = device.state.edit ?? [];
  const [entries, setEntries] = useState<EditEntry[]>(server);
  const [busy, setBusy] = useState(false);
  const pending = useRef(0);

  useEffect(() => {
    if (pending.current === 0 && !same(server, entries)) setEntries(server);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  const commit = useCallback(async (next: EditEntry[]) => {
    const before = device.state.edit ?? [];
    setEntries(next);
    pending.current++;
    setBusy(true);
    try {
      await api.setEdit(device.id, next);
      return true;
    } catch (e) {
      setEntries(before);
      notify((e as Error).message);
      return false;
    } finally {
      pending.current--;
      if (pending.current === 0) setBusy(false);
    }
  }, [device.id, device.state.edit, notify]);

  const append = useCallback((entry: EditEntry) => commit([...entries, entry]), [commit, entries]);

  return { entries, commit, preview: setEntries, append, busy };
}

export const entryLength = (e: EditEntry) => Math.max(1, e.out - e.in);
export const isSlice = (e: EditEntry) => e.in > 0 || e.out < e.frames;
