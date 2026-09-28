import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ClipListing, Device, NetworkDriveEntry, NetworkDriveSource } from '../lib/types';

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
export function NetworkDrives({ device, knownClips, onOpen, notify }: {
  device: Device;
  knownClips: ClipListing[];
  onOpen: (c: ClipListing) => void;
  notify: (m: string) => void;
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

      {!loading && entries && entries.length > 0 && (
        <ul className="nd-list">
          {entries.map((e) => {
            const known = !e.isDir && MEDIA_EXT.test(e.name) ? findOnDeck(e.name) : undefined;
            return (
              <li key={e.name} className={e.isDir ? 'nd-dir' : 'nd-file'}>
                {e.isDir ? (
                  <button type="button" className="nd-entry" onClick={() => setPath([...path, e.name])}>
                    <span className="nd-icon" aria-hidden>📁</span>
                    <span className="nd-name">{e.name}</span>
                  </button>
                ) : (
                  <span className="nd-entry">
                    <span className="nd-icon" aria-hidden>{MEDIA_EXT.test(e.name) ? '🎬' : '📄'}</span>
                    <span className="nd-name">{e.name}</span>
                    {e.size !== undefined && <span className="muted small nd-size">{formatSize(e.size)}</span>}
                    {known ? (
                      <button type="button" className="btn small ghost" onClick={() => onOpen(known)}>Open</button>
                    ) : MEDIA_EXT.test(e.name) ? (
                      <span className="muted small" title="This deck doesn't see this file on any of its own media — point its Network storage (deck) at this same share to make it playable.">
                        not on deck
                      </span>
                    ) : null}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
