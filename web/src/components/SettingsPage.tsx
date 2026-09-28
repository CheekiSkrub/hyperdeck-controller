import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { AppSettings, NasCredential } from '../lib/types';
import { Modal } from './Modal';

/**
 * The controller app's own settings — not any one HyperDeck's. Two things
 * live here: the server-level config (port, cache, transcode load) and a
 * reusable list of NAS/SMB logins that any device's share mapping or deck-
 * side NAS bookmark can pick from instead of retyping a username/password.
 */
export function SettingsPage({ onClose, notify }: { onClose: () => void; notify: (m: string, kind?: 'ok' | 'err') => void }) {
  return (
    <Modal title="Controller settings" onClose={onClose} wide>
      <div className="app-settings">
        <SystemSection notify={notify} />
        <CredentialsSection notify={notify} />
      </div>
    </Modal>
  );
}

function SystemSection({ notify }: { notify: (m: string, kind?: 'ok' | 'err') => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<Partial<AppSettings>>({});
  const [saving, setSaving] = useState(false);
  const [restartNotice, setRestartNotice] = useState(false);

  useEffect(() => { api.appSettings().then(setSettings).catch((e) => notify((e as Error).message)); }, [notify]);

  const value = <K extends keyof AppSettings>(k: K): AppSettings[K] | undefined =>
    (k in draft ? draft[k] : settings?.[k]) as AppSettings[K] | undefined;
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    if (Object.keys(draft).length === 0) return;
    setSaving(true);
    try {
      const r = await api.updateAppSettings(draft);
      setSettings(r);
      setDraft({});
      setRestartNotice(r.restartRequired);
      notify('Settings saved', 'ok');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return <section className="card settings-group"><h3>System</h3><p className="muted small">Reading…</p></section>;

  return (
    <fieldset className="card settings-group app-settings-system">
      <legend>System</legend>
      {restartNotice && (
        <div className="banner warn" role="alert">
          <div>
            <strong>Restart required</strong>
            <p className="muted small">These changes are saved but won't take effect until HyperDeck Controller is restarted.</p>
          </div>
        </div>
      )}
      <div className="row3">
        <label>
          <span>Panel port</span>
          <input type="number" min={1} max={65535} value={value('port') ?? ''} onChange={(e) => set('port', Number(e.target.value) || 0)} />
        </label>
        <label>
          <span>Bind address</span>
          <input value={value('host') ?? ''} onChange={(e) => set('host', e.target.value)} placeholder="0.0.0.0" />
        </label>
        <label>
          <span>Open browser on start</span>
          <select value={String(value('openBrowser') ?? true)} onChange={(e) => set('openBrowser', e.target.value === 'true')}>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
      </div>
      <div className="row3">
        <label>
          <span>Transcode concurrency</span>
          <input type="number" min={1} max={16} value={value('mediaConcurrency') ?? ''} onChange={(e) => set('mediaConcurrency', Number(e.target.value) || 1)} />
        </label>
        <label>
          <span>Proxy height (px)</span>
          <input type="number" min={144} max={2160} value={value('proxyHeight') ?? ''} onChange={(e) => set('proxyHeight', Number(e.target.value) || 540)} />
        </label>
        <label>
          <span>Max cache (GB)</span>
          <input type="number" min={1} max={2000} value={value('maxCacheGB') ?? ''} onChange={(e) => set('maxCacheGB', Number(e.target.value) || 1)} />
        </label>
      </div>
      <div className="row3">
        <label>
          <span>ffmpeg path (optional)</span>
          <input value={value('ffmpegPath') ?? ''} onChange={(e) => set('ffmpegPath', e.target.value)} placeholder="Leave blank to use the bundled/PATH ffmpeg" />
        </label>
        <label>
          <span>ffprobe path (optional)</span>
          <input value={value('ffprobePath') ?? ''} onChange={(e) => set('ffprobePath', e.target.value)} placeholder="Leave blank to use the bundled/PATH ffprobe" />
        </label>
        <label>
          <span>Cache folder</span>
          <input className="mono" value={settings.cacheDir} disabled title="Set with the HDC_CACHE_DIR environment variable" />
        </label>
      </div>
      <div className="form-actions">
        <span className="spacer" />
        <button type="button" className="btn primary" disabled={saving || Object.keys(draft).length === 0} onClick={save}>
          {saving ? 'Saving…' : 'Save system settings'}
        </button>
      </div>
    </fieldset>
  );
}

function CredentialsSection({ notify }: { notify: (m: string, kind?: 'ok' | 'err') => void }) {
  const [list, setList] = useState<NasCredential[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editUser, setEditUser] = useState('');
  const [editPass, setEditPass] = useState('');
  const [editPath, setEditPath] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newUser, setNewUser] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newPath, setNewPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<Record<string, { busy: boolean; ok?: boolean; message?: string; entries?: { name: string; isDir: boolean }[] }>>({});

  const load = () => api.credentials().then(setList).catch((e) => notify((e as Error).message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    if (!newLabel.trim() || !newUser.trim()) return;
    setBusy(true);
    try {
      await api.createCredential(newLabel.trim(), newUser.trim(), newPass, newPath);
      setNewLabel(''); setNewUser(''); setNewPass(''); setNewPath('');
      notify('Saved credential added', 'ok');
      load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (c: NasCredential) => { setEditing(c.id); setEditLabel(c.label); setEditUser(c.username); setEditPass(''); setEditPath(c.path ?? ''); };

  const saveEdit = async (id: string) => {
    setBusy(true);
    try {
      await api.updateCredential(id, { label: editLabel, username: editUser, path: editPath, ...(editPass ? { password: editPass } : {}) });
      setEditing(null);
      notify('Saved credential updated', 'ok');
      load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = async (c: NasCredential) => {
    setTesting((t) => ({ ...t, [c.id]: { busy: true } }));
    try {
      const r = await api.testCredential(c.id);
      setTesting((t) => ({ ...t, [c.id]: { busy: false, ok: r.ok, message: r.message, entries: r.entries } }));
    } catch (e) {
      setTesting((t) => ({ ...t, [c.id]: { busy: false, ok: false, message: (e as Error).message } }));
    }
  };

  const remove = async (c: NasCredential) => {
    setBusy(true);
    try {
      await api.deleteCredential(c.id);
      load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="card settings-group app-settings-creds">
      <legend>Saved NAS credentials</legend>
      <p className="muted small">
        A reusable login for a NAS or share. Pick one from a HyperDeck's Network storage settings instead of typing the same
        username and password again — it fills the fields in at that moment, so editing or removing one here doesn't change
        a device that already used it.
      </p>

      {list === null && <p className="muted small">Reading…</p>}
      {list?.length === 0 && <p className="muted small">No saved credentials yet.</p>}

      {list && list.length > 0 && (
        <ul className="cred-list">
          {list.map((c) => (
            <li key={c.id}>
              {editing === c.id ? (
                <div className="cred-edit">
                  <div className="row3">
                    <label><span>Name</span><input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} /></label>
                    <label><span>Username</span><input value={editUser} onChange={(e) => setEditUser(e.target.value)} /></label>
                    <label><span>New password (leave blank to keep)</span><input type="password" value={editPass} onChange={(e) => setEditPass(e.target.value)} /></label>
                  </div>
                  <div className="row3">
                    <label><span>Path (UNC or mount point, for Test)</span><input value={editPath} onChange={(e) => setEditPath(e.target.value)} placeholder="\\nas.local\Share" /></label>
                    <span className="cred-edit-actions">
                      <button type="button" className="btn small primary" disabled={busy} onClick={() => saveEdit(c.id)}>Save</button>
                      <button type="button" className="btn small ghost" onClick={() => setEditing(null)}>Cancel</button>
                    </span>
                  </div>
                </div>
              ) : (
                <div className="cred-row-wrap">
                  <div className="cred-row">
                    <span className="cred-label">{c.label}</span>
                    <span className="mono muted small cred-user">{c.username}{c.path ? ` · ${c.path}` : ''}</span>
                    <span className="cred-actions">
                      <button type="button" className="btn small ghost" disabled={testing[c.id]?.busy} onClick={() => test(c)}>
                        {testing[c.id]?.busy ? 'Testing…' : 'Test'}
                      </button>
                      <button type="button" className="btn small ghost" onClick={() => startEdit(c)}>Edit</button>
                      <button type="button" className="btn small ghost" disabled={busy} onClick={() => remove(c)}>Remove</button>
                    </span>
                  </div>
                  {testing[c.id] && !testing[c.id].busy && (
                    <div className={`cred-test-result ${testing[c.id].ok ? 'ok' : 'err'}`}>
                      <p className="small">{testing[c.id].message}</p>
                      {testing[c.id].entries && testing[c.id].entries!.length > 0 && (
                        <ul className="cred-entries">
                          {testing[c.id].entries!.map((e) => (
                            <li key={e.name}>{e.isDir ? '📁' : '📄'} {e.name}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="cred-add">
        <div className="row3">
          <label><span>Name</span><input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Studio NAS" /></label>
          <label><span>Username</span><input value={newUser} onChange={(e) => setNewUser(e.target.value)} /></label>
          <label><span>Password</span><input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} /></label>
        </div>
        <div className="row3">
          <label><span>Path (UNC or mount point, for Test)</span><input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="\\nas.local\Share" /></label>
        </div>
      </div>
      <div className="form-actions">
        <span className="spacer" />
        <button type="button" className="btn primary" disabled={!newLabel.trim() || !newUser.trim() || busy} onClick={add}>Add saved credential</button>
      </div>
    </fieldset>
  );
}
