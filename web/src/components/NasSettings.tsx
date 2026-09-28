import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Device, NasBookmark, NasHost } from '../lib/types';

/**
 * The HyperDeck's own network-storage destination — what it records/plays to
 * directly (Ethernet protocol `nas`, or REST `/media/nas/...`). Separate from
 * "Network storage (SMB/AFP)" in the device form, which is this server's own
 * read-only view of a share for browsing/thumbnails; this is what the deck
 * itself writes to. Add a mapping if the deck doesn't have one yet, change
 * which one it's using, or update its credentials.
 */
export function NasSettings({ device, notify }: { device: Device; notify: (m: string, kind?: 'ok' | 'err') => void }) {
  const [bookmarks, setBookmarks] = useState<NasBookmark[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hosts, setHosts] = useState<NasHost[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editUser, setEditUser] = useState('');
  const [editPass, setEditPass] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newUser, setNewUser] = useState('');
  const [newPass, setNewPass] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    const [b, sel] = await Promise.allSettled([api.nasBookmarks(device.id), api.nasSelected(device.id)]);
    if (b.status === 'fulfilled') {
      setBookmarks(b.value);
    } else {
      setBookmarks([]);
      setLoadError((b.reason as Error).message);
    }
    if (sel.status === 'fulfilled') {
      setSelected(sel.value.url);
    } else if (b.status === 'fulfilled') {
      // Bookmarks loaded fine but "selected" failed — still worth surfacing.
      setLoadError((sel.reason as Error).message);
    }
  }, [device.id]);

  useEffect(() => { load(); }, [load]);

  const discover = async () => {
    setDiscovering(true);
    setHosts(null);
    try {
      setHosts(await api.nasDiscover(device.id));
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  };

  const add = async () => {
    if (!newUrl.trim()) return;
    setAdding(true);
    try {
      const b = await api.addNasBookmark(device.id, newUrl.trim(), newUser.trim() || undefined, newPass || undefined);
      setBookmarks(b);
      setNewUrl('');
      setNewUser('');
      setNewPass('');
      notify('NAS mapping added', 'ok');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const remove = async (url: string) => {
    setBusy(url);
    try {
      setBookmarks(await api.removeNasBookmark(device.id, url));
      if (selected === url) setSelected(null);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const select = async (url: string | null) => {
    setBusy(url ?? '(unmount)');
    try {
      const r = await api.selectNas(device.id, url);
      setSelected(r.url);
      notify(url ? `HyperDeck now recording/playing to ${url}` : 'HyperDeck network storage unmounted', 'ok');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveCredentials = async (url: string) => {
    setBusy(url);
    try {
      setBookmarks(await api.setNasBookmarkCredentials(device.id, url, editUser.trim() || undefined, editPass || undefined));
      notify('Credentials updated', 'ok');
      setEditing(null);
      setEditUser('');
      setEditPass('');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card settings-group nas-settings">
      <h3>Network storage (deck)</h3>
      <p className="muted small">
        Where this HyperDeck itself records and plays back to over the network. Add a mapping if it doesn't have one yet,
        switch which one it's using, or change its login. This is separate from the server's own read access to a share, above.
      </p>

      {bookmarks === null && <p className="muted small">Reading…</p>}
      {loadError && (
        <p className="error small">
          Couldn't read the deck's NAS mappings: {loadError}
          {' '}<button type="button" className="btn small ghost" onClick={load}>Retry</button>
        </p>
      )}
      {bookmarks && bookmarks.length === 0 && !loadError && <p className="muted small">No NAS mappings on this deck yet.</p>}

      {bookmarks && bookmarks.length > 0 && (
        <ul className="nas-list">
          {bookmarks.map((b) => (
            <li key={b.url} className={selected === b.url ? 'nas-selected' : ''}>
              <div className="nas-row">
                <span className="mono nas-url" title={b.url}>{b.url}</span>
                {selected === b.url && <span className="badge nas-active">In use</span>}
                <span className="nas-actions">
                  {selected === b.url ? (
                    <button type="button" className="btn small ghost" disabled={busy !== null} onClick={() => select(null)}>Unmount</button>
                  ) : (
                    <button type="button" className="btn small" disabled={busy !== null} onClick={() => select(b.url)}>Use this</button>
                  )}
                  <button type="button" className="btn small ghost" onClick={() => { setEditing(editing === b.url ? null : b.url); setEditUser(''); setEditPass(''); }}>
                    Credentials…
                  </button>
                  <button type="button" className="btn small ghost" disabled={busy !== null} onClick={() => remove(b.url)}>Remove</button>
                </span>
              </div>
              {editing === b.url && (
                <div className="row3 nas-edit">
                  <label><span>Username</span><input value={editUser} onChange={(e) => setEditUser(e.target.value)} /></label>
                  <label><span>Password</span><input type="password" value={editPass} onChange={(e) => setEditPass(e.target.value)} /></label>
                  <label className="share-connect-action">
                    <span>&nbsp;</span>
                    <button type="button" className="btn small primary" disabled={busy !== null} onClick={() => saveCredentials(b.url)}>Save</button>
                  </label>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="nas-add">
        <div className="row3">
          <label><span>New mapping URL</span><input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="smb://nas.local/Recordings" /></label>
          <label><span>Username</span><input value={newUser} onChange={(e) => setNewUser(e.target.value)} /></label>
          <label><span>Password</span><input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} /></label>
        </div>
        <div className="nas-add-actions">
          <button type="button" className="btn small ghost" disabled={discovering} onClick={discover}>{discovering ? 'Searching…' : 'Discover'}</button>
          <button type="button" className="btn small primary" disabled={!newUrl.trim() || adding} onClick={add}>{adding ? 'Adding…' : 'Add mapping'}</button>
        </div>
        {hosts && (
          hosts.length === 0 ? <p className="muted small">No NAS hosts found on the network.</p> : (
            <ul className="nas-hosts">
              {hosts.map((h) => (
                <li key={h.ip}>
                  <button type="button" className="btn small ghost" onClick={() => setNewUrl(`smb://${h.hostName || h.ip}/`)}>
                    {h.friendlyName || h.hostName} ({h.ip})
                  </button>
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </section>
  );
}
