import { useState } from 'react';
import { api } from '../lib/api';
import type { AddressCheck, Device, ShareMapping, SourcesTest } from '../lib/types';
import { CredentialPicker } from './CredentialPicker';
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
  const [restPort, setRestPort] = useState(device?.restPort ?? 80);
  /** Result of checking a new/changed address; shown as a warning before saving. */
  const [probe, setProbe] = useState<{ host: string; result: AddressCheck } | null>(null);
  const [ftp, setFtp] = useState(device?.ftp ?? { enabled: true, port: 21, user: 'anonymous', password: '' });
  const [shares, setShares] = useState<ShareMapping[]>(device?.shares ?? []);
  const [advanced, setAdvanced] = useState(Boolean(device?.shares.length));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<SourcesTest | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [creatingTestDeck, setCreatingTestDeck] = useState(false);
  const isTestDevice = Boolean(device?.test);

  const hostValid = IP_OR_HOST.test(host.trim());

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Give the HyperDeck a name');
    if (!hostValid) return setError('Enter a valid IP address');
    setBusy(true);
    try {
      const addressChanged = !device || device.host !== host.trim() || device.port !== port;
      const confirmed = probe?.host === `${host.trim()}:${port}`;
      if (addressChanged && !confirmed) {
        const result = await api.probe(host.trim(), port);
        if (!result.reachable || !result.sameSubnet) {
          setProbe({ host: `${host.trim()}:${port}`, result });
          return; // show the warning; pressing Save again confirms
        }
      }
      const body = { name: name.trim(), host: host.trim(), port, restPort, ftp, shares: shares.filter((s) => s.localPath.trim()) };
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

  const addTestDeck = async () => {
    setError(null);
    setCreatingTestDeck(true);
    try {
      const saved = await api.createTestDevice();
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreatingTestDeck(false);
    }
  };

  const updateShare = (i: number, patch: Partial<ShareMapping>) => setShares(shares.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const [connectResult, setConnectResult] = useState<Record<string, { busy: boolean; ok?: boolean; message?: string }>>({});
  const connectShare = async (shareId: string) => {
    if (!device) return;
    setConnectResult((r) => ({ ...r, [shareId]: { busy: true } }));
    try {
      const r = await api.connectShare(device.id, shareId);
      setConnectResult((r0) => ({ ...r0, [shareId]: { busy: false, ok: r.ok, message: r.message } }));
    } catch (e) {
      setConnectResult((r0) => ({ ...r0, [shareId]: { busy: false, ok: false, message: (e as Error).message } }));
    }
  };

  return (
    <Modal title={device ? `Edit ${device.name}` : 'Add HyperDeck'} onClose={onClose}>
      <form onSubmit={save} className="form">
        {!device && (
          <div className="test-deck-offer">
            <button type="button" className="btn ghost" onClick={addTestDeck} disabled={creatingTestDeck}>
              {creatingTestDeck ? 'Starting simulated deck…' : '▣ Use a simulated test HyperDeck instead'}
            </button>
            <p className="muted small">No hardware needed — spins up a fake HyperDeck on this computer with sample clips, so you can try the app or test a workflow.</p>
          </div>
        )}

        {isTestDevice && (
          <div className="banner info" role="note">
            <strong>Simulated HyperDeck</strong>
            <p className="muted small">This is a test deck running on this computer, not real hardware. Its connection settings are managed automatically; rename it or remove it below.</p>
          </div>
        )}

        <label>
          <span>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Studio A Deck 1" />
        </label>
        {!isTestDevice && (
          <label>
            <span>IP address</span>
            <input value={host} onChange={(e) => { setHost(e.target.value); setProbe(null); }} placeholder="192.168.10.50" className={host && !hostValid ? 'invalid' : ''} inputMode="decimal" />
          </label>
        )}

        {probe && (
          <div className="banner warn ip-warning" role="alert">
            <div>
              <strong>{probe.result.reachable ? 'Check this address' : `No HyperDeck answered at ${probe.host}`}</strong>
              {!probe.result.reachable && <span className="muted"> ({probe.result.error})</span>}
              {device && !probe.result.reachable && (
                <p>If you save, the panel will lose contact with <strong>{device.name}</strong> until a deck answers at this address.
                  It's currently reachable at {device.host}{device.state.status === 'connected' ? '' : ' (offline now)'}.</p>
              )}
              {!probe.result.sameSubnet && (
                <p>{probe.host.split(':')[0]} isn't on any of this server's networks ({probe.result.serverAddresses.join(', ') || 'none found'}),
                  so the server can only reach it through a router.</p>
              )}
              <p className="muted small">Press {device ? 'Save' : 'Add'} again to use it anyway.</p>
            </div>
          </div>
        )}

        {!isTestDevice && (
        <button type="button" className="link" onClick={() => setAdvanced(!advanced)}>
          {advanced ? '▾' : '▸'} Media access &amp; advanced
        </button>
        )}

        {!isTestDevice && advanced && (
          <div className="advanced">
            <div className="row3">
              <label>
                <span>Control port (Ethernet protocol)</span>
                <input type="number" value={port} onChange={(e) => { setPort(Number(e.target.value)); setProbe(null); }} />
              </label>
              <label>
                <span>REST API port</span>
                <input type="number" value={restPort} onChange={(e) => setRestPort(Number(e.target.value))} />
              </label>
            </div>

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
                  <div className="row3 share-connect">
                    <label><span>Username</span><input value={s.username ?? ''} onChange={(e) => updateShare(i, { username: e.target.value })} placeholder="This server's own login for the share" /></label>
                    <label><span>Password</span><input type="password" value={s.password ?? ''} onChange={(e) => updateShare(i, { password: e.target.value })} /></label>
                    <CredentialPicker onPick={(c) => updateShare(i, { username: c.username, password: c.password })} />
                    <label className="share-connect-action">
                      <span>&nbsp;</span>
                      {s.id ? (
                        <button type="button" className="btn small ghost" disabled={connectResult[s.id]?.busy} onClick={() => connectShare(s.id!)}>
                          {connectResult[s.id]?.busy ? 'Connecting…' : 'Connect'}
                        </button>
                      ) : (
                        <span className="muted small">Save first to connect</span>
                      )}
                    </label>
                  </div>
                  {s.id && connectResult[s.id]?.message && (
                    <p className={`small share-connect-result ${connectResult[s.id].ok ? 'ok' : 'err'}`}>{connectResult[s.id].message}</p>
                  )}
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
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Checking…' : probe ? `${device ? 'Save' : 'Add'} anyway` : device ? 'Save' : 'Add'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
