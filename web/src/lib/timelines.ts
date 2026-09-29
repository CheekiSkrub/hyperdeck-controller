import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { Editor } from './editor';
import type { Device, EditEntry, SavedTimeline } from './types';

export interface Timelines {
  list: SavedTimeline[];
  /** The tab being shown/edited. */
  active: SavedTimeline | null;
  setActive: (id: string) => void;
  /** Edits go to the deck when the active timeline is live, and are just saved otherwise. */
  editor: Editor;
  create: () => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Put a staged timeline on the deck (it becomes the live one). */
  sendToDeck: (id: string) => Promise<void>;
  /** Clip file names on each timeline, for the clip browser's automatic folders. */
  filesByTimeline: { id: string; name: string; live: boolean; files: string[] }[];
}

const activeKey = (deviceId: string) => `hdc.timeline.active.${deviceId}`;
const same = (a: EditEntry[], b: EditEntry[]) =>
  a.length === b.length && a.every((e, i) => e.file === b[i].file && e.in === b[i].in && e.out === b[i].out);

/**
 * Several timelines per deck, one of them live (on the deck). Build a running order in
 * Timeline 1 while Timeline 2 plays, then send it to the deck. The live timeline is edited
 * through the deck editor (`deck`) exactly as before; staged ones are saved on the server.
 */
export function useTimelines(device: Device, deck: Editor, notify: (m: string, kind?: 'ok' | 'err') => void): Timelines {
  const [list, setList] = useState<SavedTimeline[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(() => {
    try { return localStorage.getItem(activeKey(device.id)); } catch { return null; }
  });
  const [busy, setBusy] = useState(false);

  const setActive = useCallback((id: string) => {
    setActiveIdState(id);
    try { localStorage.setItem(activeKey(device.id), id); } catch { /* per-viewer convenience only */ }
  }, [device.id]);

  const refresh = useCallback(async () => {
    // The server makes sure there's always a live timeline (the deck's) in this list.
    setList(await api.timelines(device.id));
  }, [device.id]);

  useEffect(() => { refresh().catch((e) => notify((e as Error).message)); }, [refresh, notify]);

  const active = list.find((t) => t.id === activeId) ?? list.find((t) => t.live) ?? list[0] ?? null;
  const isLive = !active || Boolean(active.live); // before the list loads, edits go to the deck as before

  // The live timeline's saved copy follows the deck (the server keeps it in step on each edit).
  const deckEntries = deck.entries;
  const lastDeck = useRef(deckEntries);
  useEffect(() => {
    if (same(lastDeck.current, deckEntries)) return;
    lastDeck.current = deckEntries;
    setList((l) => l.map((t) => (t.live ? { ...t, entries: deckEntries } : t)));
  }, [deckEntries]);

  // ------------------------------------------------------------------ staged editor
  const commitStaged = useCallback(async (next: EditEntry[]) => {
    if (!active || active.live) return false;
    const before = active.entries;
    setList((l) => l.map((t) => (t.id === active.id ? { ...t, entries: next } : t)));
    setBusy(true);
    try {
      const saved = await api.overwriteTimeline(active.id, next);
      setList((l) => l.map((t) => (t.id === saved.id ? saved : t)));
      return true;
    } catch (e) {
      setList((l) => l.map((t) => (t.id === active.id ? { ...t, entries: before } : t)));
      notify((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [active, notify]);

  const staged: Editor = useMemo(() => ({
    entries: active?.entries ?? [],
    commit: commitStaged,
    preview: (next) => setList((l) => l.map((t) => (t.id === active?.id ? { ...t, entries: next } : t))),
    append: (entry) => commitStaged([...(active?.entries ?? []), entry]),
    busy,
  }), [active, commitStaged, busy]);

  // ------------------------------------------------------------------ tab actions
  const create = useCallback(async () => {
    const used = new Set(list.map((t) => t.name));
    let n = list.length + 1;
    while (used.has(`Timeline ${n}`)) n++;
    try {
      const t = await api.saveTimeline(device.id, `Timeline ${n}`, []);
      setList((l) => [...l, t]);
      setActive(t.id);
    } catch (e) {
      notify((e as Error).message);
    }
  }, [device.id, list, notify, setActive]);

  const rename = useCallback(async (id: string, name: string) => {
    try {
      const t = await api.renameTimeline(id, name);
      setList((l) => l.map((x) => (x.id === id ? t : x)));
    } catch (e) {
      notify((e as Error).message);
    }
  }, [notify]);

  const remove = useCallback(async (id: string) => {
    try {
      await api.deleteTimeline(id);
      setList((l) => l.filter((x) => x.id !== id));
    } catch (e) {
      notify((e as Error).message);
    }
  }, [notify]);

  const sendToDeck = useCallback(async (id: string) => {
    const t = list.find((x) => x.id === id);
    setBusy(true);
    try {
      await api.loadTimeline(id);
      await refresh();
      notify(`"${t?.name ?? 'Timeline'}" is now on the deck`, 'ok');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [list, refresh, notify]);

  const filesByTimeline = useMemo(() => list.map((t) => ({
    id: t.id, name: t.name, live: Boolean(t.live),
    files: [...new Set((t.live ? deckEntries : t.entries).map((e) => e.file))],
  })), [list, deckEntries]);

  return {
    list, active, setActive,
    editor: isLive ? deck : staged,
    create, rename, remove, sendToDeck, filesByTimeline,
  };
}
