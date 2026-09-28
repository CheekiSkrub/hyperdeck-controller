import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { ClipListing, Device } from '../lib/types';
import { CLIP_MIME, type DraggedClip } from './EditTimeline';
import { NetworkDrives } from './NetworkDrives';

type ViewMode = 'tiles' | 'details';
type SortKey = 'name' | 'date';
type SortDir = 'asc' | 'desc';

const VIEW_KEY = 'hdc.clips.view';
const SIZE_KEY = 'hdc.clips.tileSize';
const SORT_KEY = 'hdc.clips.sort';

function loadView(): ViewMode {
  try { return (localStorage.getItem(VIEW_KEY) as ViewMode) === 'details' ? 'details' : 'tiles'; } catch { return 'tiles'; }
}
function loadTileSize(): number {
  try { const n = Number(localStorage.getItem(SIZE_KEY)); return n >= 120 && n <= 320 ? n : 210; } catch { return 210; }
}
function loadSort(): { key: SortKey; dir: SortDir } {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (!raw) throw 0;
    const v = JSON.parse(raw);
    return { key: v.key === 'date' ? 'date' : 'name', dir: v.dir === 'desc' ? 'desc' : 'asc' };
  } catch {
    return { key: 'name', dir: 'asc' };
  }
}

function sortClips(list: ClipListing[], key: SortKey, dir: SortDir): ClipListing[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    // The HyperDeck protocol's disk listing carries no file date, only the order clips were
    // recorded onto the slot — so "date" sorts by that recording order (oldest first) rather
    // than a calendar timestamp, which is the closest honest stand-in the deck can give us.
    if (key === 'date') return (a.index - b.index) * factor || a.file.localeCompare(b.file, undefined, { numeric: true });
    return a.file.localeCompare(b.file, undefined, { numeric: true }) * factor;
  });
}

export function ClipBrowser({ device, onOpen, notify }: { device: Device; onOpen: (c: ClipListing) => void; notify: (m: string) => void }) {
  const [clips, setClips] = useState<ClipListing[]>([]);
  const [slot, setSlot] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'clips' | 'network'>('clips');
  const [view, setView] = useState<ViewMode>(loadView);
  const [tileSize, setTileSize] = useState<number>(loadTileSize);
  const [sort, setSort] = useState(loadSort);
  const s = device.state;

  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ } }, [view]);
  useEffect(() => { try { localStorage.setItem(SIZE_KEY, String(tileSize)); } catch { /* ignore */ } }, [tileSize]);
  useEffect(() => { try { localStorage.setItem(SORT_KEY, JSON.stringify(sort)); } catch { /* ignore */ } }, [sort]);

  // Re-fetch whenever the deck reports different media or timeline.
  const signature = useMemo(
    () => JSON.stringify([s.status, s.disks, s.timeline.map((c) => c.name), s.transport?.slotId, s.slots.map((x) => x.status)]),
    [s.status, s.disks, s.timeline, s.transport?.slotId, s.slots],
  );
  useEffect(() => {
    if (s.status !== 'connected') return;
    api.clips(device.id).then(setClips).catch((e) => notify(e.message));
  }, [device.id, signature]);

  const slots = useMemo(() => [...new Map(clips.map((c) => [c.slotId, c.slotLabel])).entries()], [clips]);
  const filtered = clips.filter((c) => (slot === 'all' || c.slotId === slot) && c.file.toLowerCase().includes(search.toLowerCase()));
  const shown = useMemo(() => sortClips(filtered, sort.key, sort.dir), [filtered, sort]);

  return (
    <section className="card clips">
      <div className="clips-head">
        <h2>Clips</h2>
        <div className="seg" role="group" aria-label="Filter by media">
          <button className={mode === 'clips' && slot === 'all' ? 'on' : ''} onClick={() => { setMode('clips'); setSlot('all'); }}>All</button>
          {slots.map(([id, label]) => (
            <button key={id} className={mode === 'clips' && slot === id ? 'on' : ''} onClick={() => { setMode('clips'); setSlot(id); }}>{label}</button>
          ))}
          <button className={mode === 'network' ? 'on' : ''} onClick={() => setMode('network')}>Network drives</button>
        </div>
        {mode === 'clips' && (
          <>
            <input className="search" placeholder="Search clips" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="clips-toolbar">
              <label className="sort-control">
                Sort
                <select value={sort.key} onChange={(e) => setSort((v) => ({ ...v, key: e.target.value as SortKey }))}>
                  <option value="name">Name</option>
                  <option value="date">Date recorded</option>
                </select>
              </label>
              <button
                type="button"
                className="btn small ghost sort-dir"
                title={sort.dir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
                onClick={() => setSort((v) => ({ ...v, dir: v.dir === 'asc' ? 'desc' : 'asc' }))}
              >
                {sort.dir === 'asc' ? '↑' : '↓'}
              </button>
              <div className="seg small" role="group" aria-label="View">
                <button className={view === 'tiles' ? 'on' : ''} title="Tiles" onClick={() => setView('tiles')}>▦</button>
                <button className={view === 'details' ? 'on' : ''} title="Details" onClick={() => setView('details')}>☰</button>
              </div>
              {view === 'tiles' && (
                <input
                  type="range" className="tile-size" min={120} max={320} step={10} value={tileSize}
                  onChange={(e) => setTileSize(Number(e.target.value))} title="Tile size"
                  aria-label="Tile size"
                />
              )}
            </div>
          </>
        )}
      </div>
      {mode === 'network' ? (
        <NetworkDrives device={device} knownClips={clips} onOpen={onOpen} notify={notify} />
      ) : s.status !== 'connected' && clips.length === 0 ? (
        <p className="muted">Connect to the HyperDeck to browse its clips.</p>
      ) : shown.length === 0 ? (
        <p className="muted">No clips{search ? ' match your search' : ' on mounted media'}.</p>
      ) : view === 'details' ? (
        <ClipTable device={device} clips={shown} onOpen={onOpen} />
      ) : (
        <div className="clip-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize}px, 1fr))` }}>
          {shown.map((c) => (
            <ClipCard key={`${c.slotId}/${c.file}`} device={device} clip={c} onOpen={() => onOpen(c)} />
          ))}
        </div>
      )}
    </section>
  );
}

function ClipTable({ device, clips, onOpen }: { device: Device; clips: ClipListing[]; onOpen: (c: ClipListing) => void }) {
  return (
    <div className="clip-table-wrap">
      <table className="clip-table">
        <thead>
          <tr>
            <th className="ct-thumb" />
            <th>Name</th>
            <th>Slot</th>
            <th>Video format</th>
            <th>File format</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {clips.map((c) => {
            const current = device.state.transport?.slotId === c.slotId && c.timelineId !== null && device.state.transport?.clipId === c.timelineId;
            return (
              <tr
                key={`${c.slotId}/${c.file}`}
                className={current ? 'current' : ''}
                onClick={() => onOpen(c)}
                draggable={c.frames !== null}
                onDragStart={(e) => {
                  const data: DraggedClip = { slotId: c.slotId, file: c.file, frames: c.frames ?? 0 };
                  e.dataTransfer.setData(CLIP_MIME, JSON.stringify(data));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <td className="ct-thumb"><ClipRowThumb device={device} clip={c} /></td>
                <td className="clip-table-name">{c.file}{c.isNetwork && <span className="tag net inline">NAS</span>}{current && <span className="tag live inline">ON DECK</span>}</td>
                <td className="muted">{c.slotLabel}</td>
                <td className="muted">{c.videoFormat}</td>
                <td className="muted">{c.fileFormat}</td>
                <td className="mono">{c.duration}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ClipRowThumb({ device, clip }: { device: Device; clip: ClipListing }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="ct-thumb-fail" aria-hidden>🎬</span>;
  return <img loading="lazy" className="ct-thumb-img" src={api.thumbUrl(device.id, clip.slotId, clip.file)} alt="" onError={() => setFailed(true)} />;
}

function ClipCard({ device, clip, onOpen }: { device: Device; clip: ClipListing; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  const current = device.state.transport?.slotId === clip.slotId && clip.timelineId !== null && device.state.transport?.clipId === clip.timelineId;
  return (
    <button
      className={`clip-card ${current ? 'current' : ''}`}
      onClick={onOpen}
      title={`Open ${clip.file} · drag onto the timeline to add it`}
      draggable={clip.frames !== null}
      onDragStart={(e) => {
        const data: DraggedClip = { slotId: clip.slotId, file: clip.file, frames: clip.frames ?? 0 };
        e.dataTransfer.setData(CLIP_MIME, JSON.stringify(data));
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <div className="thumb">
        {failed ? (
          <span className="thumb-fail">No preview{clip.isNetwork ? ' — map network share' : ''}</span>
        ) : (
          <img loading="lazy" src={api.thumbUrl(device.id, clip.slotId, clip.file)} alt="" onError={() => setFailed(true)} />
        )}
        <span className="duration mono">{clip.duration}</span>
        {clip.isNetwork && <span className="tag net">NAS</span>}
        {current && <span className="tag live">ON DECK</span>}
      </div>
      <div className="clip-name">{clip.file}</div>
      <div className="clip-meta muted small">{clip.slotLabel} · {clip.videoFormat} · {clip.fileFormat}</div>
    </button>
  );
}
