import { useEffect, useState } from 'react';

export type ViewMode = 'tiles' | 'details';
export type SortKey = 'name' | 'date' | 'size';
export type SortDir = 'asc' | 'desc';
export interface BrowserPrefs { view: ViewMode; tileSize: number; sortKey: SortKey; sortDir: SortDir }

const KEY = 'hdc.browser.prefs';
const DEFAULTS: BrowserPrefs = { view: 'tiles', tileSize: 210, sortKey: 'name', sortDir: 'asc' };

function load(): BrowserPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      view: v.view === 'details' ? 'details' : 'tiles',
      tileSize: v.tileSize >= 120 && v.tileSize <= 320 ? v.tileSize : DEFAULTS.tileSize,
      sortKey: v.sortKey === 'date' || v.sortKey === 'size' ? v.sortKey : 'name',
      sortDir: v.sortDir === 'desc' ? 'desc' : 'asc',
    };
  } catch {
    return DEFAULTS;
  }
}

/** View/sort/tile-size choices, shared by every tab of the clip browser and kept per-browser. */
export function useBrowserPrefs(): [BrowserPrefs, (p: Partial<BrowserPrefs>) => void] {
  const [prefs, setPrefs] = useState<BrowserPrefs>(load);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ } }, [prefs]);
  return [prefs, (p) => setPrefs((v) => ({ ...v, ...p }))];
}

export function BrowserToolbar({ prefs, set, search, onSearch, placeholder, sortOptions }: {
  prefs: BrowserPrefs;
  set: (p: Partial<BrowserPrefs>) => void;
  search: string;
  onSearch: (s: string) => void;
  placeholder: string;
  sortOptions: { key: SortKey; label: string }[];
}) {
  // A sort key this tab doesn't offer (e.g. "size" on on-deck clips) shows as the first option.
  const sortKey = sortOptions.some((o) => o.key === prefs.sortKey) ? prefs.sortKey : sortOptions[0].key;
  return (
    <>
      <input className="search" placeholder={placeholder} value={search} onChange={(e) => onSearch(e.target.value)} />
      <div className="clips-toolbar">
        <label className="sort-control">
          Sort
          <select value={sortKey} onChange={(e) => set({ sortKey: e.target.value as SortKey })}>
            {sortOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="btn small ghost sort-dir"
          title={prefs.sortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
          onClick={() => set({ sortDir: prefs.sortDir === 'asc' ? 'desc' : 'asc' })}
        >
          {prefs.sortDir === 'asc' ? '↑' : '↓'}
        </button>
        <div className="seg small" role="group" aria-label="View">
          <button className={prefs.view === 'tiles' ? 'on' : ''} title="Tiles" onClick={() => set({ view: 'tiles' })}>▦</button>
          <button className={prefs.view === 'details' ? 'on' : ''} title="Details" onClick={() => set({ view: 'details' })}>☰</button>
        </div>
        {prefs.view === 'tiles' && (
          <input
            type="range" className="tile-size" min={120} max={320} step={10} value={prefs.tileSize}
            onChange={(e) => set({ tileSize: Number(e.target.value) })} title="Tile size" aria-label="Tile size"
          />
        )}
      </div>
    </>
  );
}
