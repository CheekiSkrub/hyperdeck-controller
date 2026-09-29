import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { ClipListing, Device, NetworkDriveEntry, NetworkDriveSource } from '../lib/types';
import type { BrowserPrefs } from './BrowserToolbar';

const MEDIA_EXT = /\.(mov|mp4|mxf|m4v)$/i;

/**
 * Browse whatever's actually on a mapped NAS or share — this server's own
 * share mappings for the device, plus any saved NAS credential that has a
 * path — independent of what the HyperDeck itself reports as a slot. Useful
 * for confirming a mapping/credential really works and seeing what's there.
 *
 * A HyperDeck can only play a file from storage IT has mounted (its own
 * media, or a NAS destination it has selected), so a file found here is only
 * offered as "Load onto the deck" when it also shows up in the deck's own
 * clip listing (passed in as `knownClips`) — otherwise this is read-only
 * exploration, and we say why.
 */
export function NetworkDrives({ device, knownClips, onOpen, notify, search, prefs }: {
  device: Device;
  knownClips: ClipListing[];
  onOpen: (c: ClipListing) => void;
  notify: (m: string) => void;
  search: string;
  prefs: BrowserPrefs;
}) {
  const [sources, setSources] = useState<NetworkDriveSource[] | null>(null);
  const [sourceKey, setSourceKey] = useState<string | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [entries, setEntries] = useState<NetworkDriveEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.networkDriveSources(device.id).then((s) => {
      setSources(s);
      setSourceKey((k) => k ?? s[0]?.key ?? null);
    }).catch((e) => notify((e as Error).message));
  }, [device.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPath([]);
  }, [sourceKey]);

  useEffect(() => {
    if (!sourceKey) return;
    setLoading(true);
    setError(null);
    api.browseNetworkDrive(device.id, sourceKey, path.join('/') || undefined)
      .then((r) => {
        if (!r.ok) { setError(r.message); setEntries([]); return; }
        setEntries(r.entries ?? []);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [device.id, sourceKey, path]);

  const findOnDeck = (name: string) => knownClips.find((c) => c.file.toLowerCase() === name.toLowerCase());

  // Folders always first (like any file browser), then the chosen sort within each group.
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q));
    const f = prefs.sortDir === 'asc' ? 1 : -1;
    const byName = (a: NetworkDriveEntry, b: NetworkDriveEntry) => a.name.localeCompare(b.name, undefined, { numeric: true });
    return list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let c = 0;
      if (prefs.sortKey === 'date') c = (Date.parse(a.modifiedAt ?? '') || 0) - (Date.parse(b.modifiedAt ?? '') || 0);
      else if (prefs.sortKey === 'size') c = (a.size ?? 0) - (b.size ?? 0);
      return (c || byName(a, b)) * f;
    });
  }, [entries, search, prefs.sortKey, prefs.sortDir]);

  const open = (e: NetworkDriveEntry) => setPath([...path, e.name]);
  const source = sources?.find((s) => s.key === sourceKey);
  // A file at the root of the deck's own selected NAS is playable even if the deck's disk list
  // doesn't show it (loading it adds it by name) — hand the viewer a minimal listing for it.
  const cueable = (e: NetworkDriveEntry): ClipListing | null => {
    if (!source?.deckSlotId || path.length > 0) return null;
    const slot = device.state.slots.find((s) => s.slotId === source.deckSlotId);
    return {
      slotId: source.deckSlotId, slotLabel: slot?.volumeName || slot?.slotName || 'NAS', isNetwork: true, index: 0,
      file: e.name, fileFormat: '', videoFormat: '', duration: '', fps: null, frames: null, timelineId: null,
    };
  };
  const status = (e: NetworkDriveEntry) => {
    if (e.isDir || !MEDIA_EXT.test(e.name)) return null;
    const known = findOnDeck(e.name) ?? cueable(e);
    return known ? (
      <button type="button" className="btn small ghost" onClick={(ev) => { ev.stopPropagation(); onOpen(known); }}>Open</button>
    ) : (
      <span className="muted small" title="This deck doesn't see this file on any of its own media — point its Network storage (deck) at this same share to make it playable.">
        not on deck
      </span>
    );
  };
  const rel = (e: NetworkDriveEntry) => [...path, e.name].join('/');

  if (sources === null) return <p className="muted small">Reading…</p>;
  if (sources.length === 0) {
    return (
      <p className="muted small">
        No mapped NAS or share to browse yet. Add one in this HyperDeck's Edit &rarr; Network storage, or save a NAS
        credential with a path in Controller Settings.
      </p>
    );
  }

  return (
    <div className="network-drives">
      <div className="nd-head">
        <select value={sourceKey ?? ''} onChange={(e) => setSourceKey(e.target.value)}>
          {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <div className="nd-breadcrumb">
          <button type="button" className="btn small ghost" disabled={path.length === 0} onClick={() => setPath([])}>root</button>
          {path.map((seg, i) => (
            <span key={i}>
              <span className="muted"> / </span>
              <button type="button" className="btn small ghost" disabled={i === path.length - 1} onClick={() => setPath(path.slice(0, i + 1))}>{seg}</button>
            </span>
          ))}
        </div>
      </div>

      {loading && <p className="muted small">Reading…</p>}
      {error && <p className="error small">{error}</p>}
      {!loading && !error && entries && entries.length === 0 && <p className="muted small">Empty folder.</p>}

      {!loading && entries && entries.length > 0 && shown.length === 0 && <p className="muted small">Nothing in this folder matches your search.</p>}

      {!loading && shown.length > 0 && prefs.view === 'details' && (
        <div className="clip-table-wrap">
          <table className="clip-table">
            <thead>
              <tr><th className="ct-thumb" /><th>Name</th><th>Size</th><th>Modified</th><th /></tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.name} onClick={e.isDir ? () => open(e) : undefined} className={e.isDir ? '' : 'nd-row-file'}>
                  <td className="ct-thumb">
                    {e.isDir ? <span className="ct-thumb-fail">📁</span>
                      : MEDIA_EXT.test(e.name) ? <NdThumb deviceId={device.id} sourceKey={sourceKey!} relPath={rel(e)} className="ct-thumb-img" />
                      : <span className="ct-thumb-fail">📄</span>}
                  </td>
                  <td className="clip-table-name">{e.name}</td>
                  <td className="muted">{e.size !== undefined && !e.isDir ? formatSize(e.size) : ''}</td>
                  <td className="muted">{formatDate(e.modifiedAt)}</td>
                  <td>{status(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && shown.length > 0 && prefs.view === 'tiles' && (
        <div className="clip-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${prefs.tileSize}px, 1fr))` }}>
          {shown.map((e) => (
            <div
              key={e.name}
              className={`clip-card nd-card ${e.isDir ? 'nd-card-dir' : ''}`}
              onClick={e.isDir ? () => open(e) : undefined}
              role={e.isDir ? 'button' : undefined}
              title={e.name}
            >
              <div className="thumb">
                {e.isDir ? <span className="nd-big-icon" aria-hidden>📁</span>
                  : MEDIA_EXT.test(e.name) ? <NdThumb deviceId={device.id} sourceKey={sourceKey!} relPath={rel(e)} big />
                  : <span className="nd-big-icon" aria-hidden>📄</span>}
              </div>
              <div className="clip-name">{e.name}</div>
              <div className="clip-meta muted small nd-card-meta">
                <span>{[!e.isDir && e.size !== undefined ? formatSize(e.size) : null, formatDate(e.modifiedAt)].filter(Boolean).join(' · ') || (e.isDir ? 'Folder' : '')}</span>
                {status(e)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NdThumb({ deviceId, sourceKey, relPath, big, className }: {
  deviceId: string; sourceKey: string; relPath: string; big?: boolean; className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={big ? 'nd-big-icon' : className ? 'ct-thumb-fail' : 'nd-icon'} aria-hidden>🎬</span>;
  const img = <img loading="lazy" className={className} src={api.networkThumbUrl(deviceId, sourceKey, relPath)} alt="" onError={() => setFailed(true)} />;
  return big || className ? img : <span className="nd-thumb">{img}</span>;
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
