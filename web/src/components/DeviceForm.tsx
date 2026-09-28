import { useState } from 'react';
import { api } from '../lib/api';
import type { Device, ShareMapping, SourcesTest } from '../lib/types';
import { Modal } from './Modal';

const IP_OR_HOST = /^((\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?)$/;

export function DeviceForm({ device, onClose, onSaved, onDeleted }: {
  device: Device | null;
  onClose: () => void;
  onSaved: (d: Device) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(device?.name ?? '');
  const [host, setHost] = useState(device?.host ?? '');
  const [port, setPort] = useState(device?.port ?? 9993);
  const [ftp, setFtp] = useState(device?.ftp ?? { enabled: true, port: 21, user: 'anonymous', password: '' });
  const [shares, setShares] = useState<ShareMapping[]>(device?.shares ?? []);
  const [advanced, setAdvanced] = useState(Boolean(device?.shares.length));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<SourcesTest | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const hostValid = IP_OR_HOST.test(host.trim());

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Give the HyperDeck a name');
    if (!hostValid) return setError('Enter a valid IP address');
    setBusy(true);
    try {
      const body = { name: name.trim(), host: host.trim(), port, ftp, shares: shares.filter((s) => s.localPath.trim()) };
      const saved = device ? await api.updateDevice(device.id, body) : await api.createDevice(body);
      onSaved({ ...saved, state: device?.state ?? (saved as Device).state });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (!device) return;
    setTest(null);
    try {
      setTest(await api.testSources(device.id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async () => {
    if (!device) return;
    await api.deleteDevice(device.id);
    onDeleted();
  };

  const updateShare = (i: number, patch: Partial<ShareMapping>) => setShares(shares.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <Modal title={device ? `Edit ${device.name}` : 'Add HyperDeck'} onClose={onClose}>
      <form onSubmit={save} className="form">
        <label>
          <span>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Studio A Deck 1" />
        </label>
        <label>
          <span>IP address</span>
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.10.50" className={host && !hostValid ? 'invalid' : ''} inputMode="decimal" />
        </label>

        <button type="button" className="link" onClick={() => setAdvanced(!advanced)}>
          {advanced ? '▾' : '▸'} Media access &amp; advanced
        </button>

        {advanced && (
          <div className="advanced">
            <label className="inline">
              <span>Control port</span>
              <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
            </label>

            <fieldset>
              <legend>HyperDeck FTP (internal media, SD/SSD/USB)</legend>
              <label className="check">
                <input type="checkbox" checked={ftp.enabled} onChange={(e) => setFtp({ ...ftp, enabled: e.target.checked })} /> Enabled
              </label>
              <div className="row3">
                <label><span>Port</span><input type="number" value={ftp.port} onChange={(e) => setFtp({ ...ftp, port: Number(e.target.value) })} /></label>
                <label><span>User</span><input value={ftp.user} onChange={(e) => setFtp({ ...ftp, user: e.target.value })} /></label>
                <label><span>Password</span><input type="password" value={ftp.password} onChange={(e) => setFtp({ ...ftp, password: e.target.value })} placeholder="(anonymous)" /></label>
              </div>
            </fieldset>

            <fieldset>
              <legend>Network storage (SMB / AFP)</legend>
              <p className="muted small">
                When this HyperDeck records to a network share, clips aren't available over its FTP. Tell the server where it can
                read the same share: a UNC path on Windows (<code>\\nas\Recordings</code>) or the mount point on macOS/Linux
                (<code>/Volumes/Recordings</code>).
              </p>
              {shares.map((s, i) => (
                <div className="share" key={s.id ?? i}>
                  <div className="row3">
                    <label><span>Label</span><input value={s.label} onChange={(e) => updateShare(i, { label: e.target.value })} placeholder="Studio NAS" /></label>
                    <label><span>HyperDeck URL (optional)</span><input value={s.url ?? ''} onChange={(e) => updateShare(i, { url: e.target.value })} placeholder="smb://nas.local/Recordings" /></label>
                    <label><span>Path on this server</span><input value={s.localPath} onChange={(e) => updateShare(i, { localPath: e.target.value })} placeholder="\\nas\Recordings or /Volumes/Recordings" /></label>
                  </div>
                  <button type="button" className="btn small ghost" onClick={() => setShares(shares.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
              <button type="button" className="btn small" onClick={() => setShares([...shares, { label: '', url: device?.state.nasUrl ?? '', localPath: '' }])}>+ Add share</button>
            </fieldset>

            {device && (
              <div className="test">
                <button type="button" className="btn small" onClick={runTest}>Test media access</button>
                {test && (
                  <ul className="test-results">
                    <li className={test.ftp.ok ? 'ok' : 'bad'}>FTP: {test.ftp.message}{test.ftp.folders?.length ? ` (${test.ftp.folders.join(', ')})` : ''}</li>
                    {test.shares.map((s) => <li key={s.id} className={s.ok ? 'ok' : 'bad'}>{s.label}: {s.message}</li>)}
                    {test.nasUrl && <li className="muted">HyperDeck network storage selected: {test.nasUrl}</li>}
                  </ul>
                )}
                <p className="muted small">Save first to test changes.</p>
              </div>
            )}
          </div>
        )}

        {error && <div className="error">{error}</div>}

        <div className="form-actions">
          {device && !confirmDelete && <button type="button" className="btn danger ghost" onClick={() => setConfirmDelete(true)}>Remove device</button>}
          {device && confirmDelete && (
            <span className="confirm">
              Remove {device.name}? <button type="button" className="btn danger small" onClick={remove}>Remove</button>
              <button type="button" className="btn small ghost" onClick={() => setConfirmDelete(false)}>Keep</button>
            </span>
          )}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{device ? 'Save' : 'Add'}</button>
        </div>
      </form>
    </Modal>
  );
}
