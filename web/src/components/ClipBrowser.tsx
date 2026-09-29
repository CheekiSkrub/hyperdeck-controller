import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useLibrary, type Library } from '../lib/library';
import type { ClipListing, Device } from '../lib/types';
import { CLIP_MIME, type DraggedClip } from './EditTimeline';
import { NetworkDrives } from './NetworkDrives';
import { BrowserToolbar, useBrowserPrefs, type SortDir, type SortKey } from './BrowserToolbar';

function sortClips(list: ClipListing[], key: SortKey, dir: SortDir): ClipListing[] {
  // No size on deck clips; anything but date sorts by name.
  const factor = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    // The HyperDeck protocol's disk listing carries no file date, only the order clips were
    // recorded onto the slot — so "date" sorts by that recording order (oldest first) rather
    // than a calendar timestamp, which is the closest honest stand-in the deck can give us.
    if (key === 'date') return (a.index - b.index) * factor || a.file.localeCompare(b.file, undefined, { numeric: true });
    return a.file.localeCompare(b.file, undefined, { numeric: true }) * factor;
  });
}

/** Clip files on each timeline — shown as automatic folders. */
export interface TimelineFolder { id: string; name: string; live: boolean; files: string[] }
type Folder = { kind: 'timeline' | 'group' | 'tag'; id: string } | null;
type Menu = { x: number; y: number; clip: ClipListing } | null;

export function ClipBrowser({ device, onOpen, notify, timelines = [], onRenameTimeline }: {
  device: Device;
  onOpen: (c: ClipListing) => void;
  notify: (m: string) => void;
  timelines?: TimelineFolder[];
  onRenameTimeline?: (id: string, name: string) => void;
}) {
  const library = useLibrary(device.id, notify);
  const { lib } = library;
  const [folder, setFolder] = useState<Folder>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [clips, setClips] = useState<ClipListing[]>([]);
  const [slot, setSlot] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'clips' | 'network'>('clips');
  const [netSearch, setNetSearch] = useState('');
  const [prefs, setPrefs] = useBrowserPrefs();
  const { view, tileSize } = prefs;
  const s = device.state;

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
  const inFolder = useMemo(() => {
    if (!folder) return null;
    if (folder.kind === 'timeline') return new Set(timelines.find((t) => t.id === folder.id)?.files ?? []);
    if (folder.kind === 'group') return new Set(lib.groups.find((g) => g.id === folder.id)?.files ?? []);
    return new Set(Object.entries(lib.tags).filter(([, tags]) => tags.includes(folder.id)).map(([f]) => f));
  }, [folder, timelines, lib]);
  const q = search.trim().toLowerCase();
  const filtered = clips.filter((c) => (slot === 'all' || c.slotId === slot)
    && (!inFolder || inFolder.has(c.file))
    && (!q || c.file.toLowerCase().includes(q) || (lib.tags[c.file] ?? []).some((t) => t.toLowerCase().includes(q))));

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); };
  }, [menu]);
  const openMenu = (e: React.MouseEvent, clip: ClipListing) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, clip }); };
  const shown = useMemo(() => sortClips(filtered, prefs.sortKey, prefs.sortDir), [filtered, prefs.sortKey, prefs.sortDir]);

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
        {mode === 'clips' ? (
          <BrowserToolbar prefs={prefs} set={setPrefs} search={search} onSearch={setSearch} placeholder="Search clips"
            sortOptions={[{ key: 'name', label: 'Name' }, { key: 'date', label: 'Date recorded' }]} />
        ) : (
          <BrowserToolbar prefs={prefs} set={setPrefs} search={netSearch} onSearch={setNetSearch} placeholder="Search this folder"
            sortOptions={[{ key: 'name', label: 'Name' }, { key: 'date', label: 'Date modified' }, { key: 'size', label: 'Size' }]} />
        )}
      </div>
      {mode === 'clips' && <FolderBar library={library} timelines={timelines} folder={folder} setFolder={setFolder} onRenameTimeline={onRenameTimeline} />}
      {mode === 'network' ? (
        <NetworkDrives device={device} knownClips={clips} onOpen={onOpen} notify={notify} search={netSearch} prefs={prefs} />
      ) : s.status !== 'connected' && clips.length === 0 ? (
        <p className="muted">Connect to the HyperDeck to browse its clips.</p>
      ) : shown.length === 0 ? (
        <p className="muted">No clips{search ? ' match your search' : folder ? ' in this folder' : ' on mounted media'}.</p>
      ) : view === 'details' ? (
        <ClipTable device={device} clips={shown} onOpen={onOpen} tags={lib.tags} onMenu={openMenu} />
      ) : (
        <div className="clip-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize}px, 1fr))` }}>
          {shown.map((c) => (
            <ClipCard key={`${c.slotId}/${c.file}`} device={device} clip={c} onOpen={() => onOpen(c)} tags={lib.tags[c.file]} onMenu={(e) => openMenu(e, c)} />
          ))}
        </div>
      )}
      {menu && <ClipMenu menu={menu} library={library} folder={folder} onOpen={onOpen} close={() => setMenu(null)} />}
    </section>
  );
}

/**
 * Folders along the top of the clip browser: one per timeline (automatic — whatever clips it
 * uses), the user's own groups, and one per tag. Click to filter; drag clips onto a group to add
 * them; double-click a group to rename it.
 */
function FolderBar({ library, timelines, folder, setFolder, onRenameTimeline }: {
  library: Library;
  timelines: TimelineFolder[];
  folder: Folder;
  setFolder: (f: Folder) => void;
  onRenameTimeline?: (id: string, name: string) => void;
}) {
  const renameTimeline = (t: TimelineFolder) => {
    const n = window.prompt('Rename timeline', t.name);
    if (n?.trim() && onRenameTimeline) onRenameTimeline(t.id, n.trim());
  };
  const renameGroup = (id: string, name: string) => {
    const n = window.prompt('Rename group', name);
    if (n?.trim()) void library.renameGroup(id, n.trim());
  };
  const { lib } = library;
  const [dropOn, setDropOn] = useState<string | null>(null);
  const tags = useMemo(() => [...new Set(Object.values(lib.tags).flat())].sort((a, b) => a.localeCompare(b)), [lib.tags]);
  const is = (kind: 'timeline' | 'group' | 'tag', id: string) => folder?.kind === kind && folder.id === id;
  const toggle = (kind: 'timeline' | 'group' | 'tag', id: string) => setFolder(is(kind, id) ? null : { kind, id });
  const dropClip = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    setDropOn(null);
    try {
      const c = JSON.parse(e.dataTransfer.getData(CLIP_MIME)) as DraggedClip;
      void library.addToGroup(groupId, [c.file]);
    } catch { /* not a clip */ }
  };
  const newGroup = () => {
    const name = window.prompt('New group name');
    if (name?.trim()) void library.createGroup(name.trim());
  };

  return (
    <div className="folder-bar">
      {timelines.map((t) => (
        <button key={t.id} className={`folder-chip auto ${is('timeline', t.id) ? 'on' : ''}`} onClick={() => toggle('timeline', t.id)}
          onContextMenu={(e) => { e.preventDefault(); renameTimeline(t); }}
          title={`Clips on ${t.name} (automatic) — right-click to rename the timeline`}>
          <span aria-hidden>▤</span> {t.name}{t.live && <span className="badge live small">LIVE</span>} <span className="muted small">{t.files.length}</span>
        </button>
      ))}
      {lib.groups.map((g) => (
        <button key={g.id} className={`folder-chip ${is('group', g.id) ? 'on' : ''} ${dropOn === g.id ? 'drop' : ''}`}
          onClick={() => toggle('group', g.id)}
          onDoubleClick={() => renameGroup(g.id, g.name)}
          onContextMenu={(e) => { e.preventDefault(); renameGroup(g.id, g.name); }}
          onDragOver={(e) => { if (e.dataTransfer.types.includes(CLIP_MIME)) { e.preventDefault(); setDropOn(g.id); } }}
          onDragLeave={() => setDropOn(null)}
          onDrop={(e) => dropClip(e, g.id)}
          title="Your group — drop clips here to add them; double-click or right-click to rename">
          <span aria-hidden>📁</span> {g.name} <span className="muted small">{g.files.length}</span>
          {is('group', g.id) && (
            <span className="folder-x" role="button" aria-label={`Delete group ${g.name}`}
              onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete group "${g.name}"? The clips aren't touched.`)) { void library.deleteGroup(g.id); setFolder(null); } }}>×</span>
          )}
        </button>
      ))}
      <button className="folder-chip add" onClick={newGroup}>+ Group</button>
      {tags.map((t) => (
        <button key={t} className={`folder-chip tag-chip ${is('tag', t) ? 'on' : ''}`} onClick={() => toggle('tag', t)} title={`Clips tagged "${t}"`}>#{t}</button>
      ))}
    </div>
  );
}

/** Right-click menu on a clip: tags, groups. */
function ClipMenu({ menu, library, folder, onOpen, close }: {
  menu: NonNullable<Menu>;
  library: Library;
  folder: Folder;
  onOpen: (c: ClipListing) => void;
  close: () => void;
}) {
  const { lib } = library;
  const file = menu.clip.file;
  const tags = lib.tags[file] ?? [];
  const editTags = () => {
    close();
    const v = window.prompt(`Tags for ${file} (comma separated)`, tags.join(', '));
    if (v !== null) void library.setTags(file, v.split(',').map((t) => t.trim()).filter(Boolean));
  };
  const currentGroup = folder?.kind === 'group' ? lib.groups.find((g) => g.id === folder.id) : undefined;
  return (
    <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} role="menu" onClick={(e) => e.stopPropagation()}>
      <button role="menuitem" onClick={() => { close(); onOpen(menu.clip); }}>Open…</button>
      <hr />
      <button role="menuitem" onClick={editTags}>{tags.length ? 'Edit tags…' : 'Add tags…'}</button>
      {lib.groups.filter((g) => !g.files.includes(file)).map((g) => (
        <button key={g.id} role="menuitem" onClick={() => { close(); void library.addToGroup(g.id, [file]); }}>Add to “{g.name}”</button>
      ))}
      <button role="menuitem" onClick={() => {
        close();
        const name = window.prompt('New group name');
        if (name?.trim()) void library.createGroup(name.trim(), [file]);
      }}>Add to new group…</button>
      {currentGroup && (
        <>
          <hr />
          <button role="menuitem" className="danger" onClick={() => { close(); void library.removeFromGroup(currentGroup.id, [file]); }}>Remove from “{currentGroup.name}”</button>
        </>
      )}
    </div>
  );
}

function ClipTable({ device, clips, onOpen, tags, onMenu }: {
  device: Device;
  clips: ClipListing[];
  onOpen: (c: ClipListing) => void;
  tags: Record<string, string[]>;
  onMenu: (e: React.MouseEvent, c: ClipListing) => void;
}) {
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
                onContextMenu={(e) => onMenu(e, c)}
                draggable={c.frames !== null}
                onDragStart={(e) => {
                  const data: DraggedClip = { slotId: c.slotId, file: c.file, frames: c.frames ?? 0 };
                  e.dataTransfer.setData(CLIP_MIME, JSON.stringify(data));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <td className="ct-thumb"><ClipRowThumb device={device} clip={c} /></td>
                <td className="clip-table-name">{c.file}{c.isNetwork && <span className="tag net inline">NAS</span>}{current && <span className="tag live inline">ON DECK</span>}<ClipTags tags={tags[c.file]} /></td>
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

function ClipTags({ tags }: { tags?: string[] }) {
  if (!tags?.length) return null;
  return <span className="clip-tags">{tags.map((t) => <span key={t} className="clip-tag">#{t}</span>)}</span>;
}

function ClipCard({ device, clip, onOpen, tags, onMenu }: {
  device: Device;
  clip: ClipListing;
  onOpen: () => void;
  tags?: string[];
  onMenu: (e: React.MouseEvent) => void;
}) {
  const [failed, setFailed] = useState(false);
  const current = device.state.transport?.slotId === clip.slotId && clip.timelineId !== null && device.state.transport?.clipId === clip.timelineId;
  return (
    <button
      className={`clip-card ${current ? 'current' : ''}`}
      onClick={onOpen}
      onContextMenu={onMenu}
      title={`Open ${clip.file} · drag onto a timeline or group · right-click to tag or group`}
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
      <ClipTags tags={tags} />
    </button>
  );
}
