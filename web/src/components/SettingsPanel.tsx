import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { DeckSetting, DeckSettings, Device } from '../lib/types';
import { NasSettings } from './NasSettings';

/** Order groups the way the deck's own menu does. */
const GROUP_ORDER = ['Record', 'Video', 'Audio', 'Timecode', 'Playback', 'System'];

/**
 * The deck's setup menu. Every change is sent to the HyperDeck immediately
 * and the page re-reads the deck, so what's shown is always what the deck has.
 */
export function SettingsPanel({ device, notify }: { device: Device; notify: (m: string, kind?: 'ok' | 'err') => void }) {
  const [data, setData] = useState<DeckSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const connected = device.state.status === 'connected';

  const load = useCallback(() => {
    setLoading(true);
    api.settings(device.id).then(setData).catch((e) => notify(e.message)).finally(() => setLoading(false));
  }, [device.id, notify]);

  useEffect(() => {
    if (connected) load();
  }, [connected, load]);

  const change = async (s: DeckSetting, value: unknown) => {
    setSaving(s.id);
    try {
      setData(await api.setSetting(device.id, s.id, value));
    } catch (e) {
      notify(`${s.label}: ${(e as Error).message}`);
    } finally {
      setSaving(null);
    }
  };

  const groups = useMemo(() => {
    const map = new Map<string, DeckSetting[]>();
    for (const s of data?.settings ?? []) map.set(s.group, [...(map.get(s.group) ?? []), s]);
    const rank = (g: string) => {
      const i = GROUP_ORDER.indexOf(g);
      return i >= 0 ? i : g.startsWith('Monitoring') ? 50 : 60;
    };
    return [...map.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  }, [data]);

  if (!connected) return <section className="card muted">Connect to the HyperDeck to see its settings.</section>;

  return (
    <div className="settings">
      <div className="settings-head">
        <p className="muted small">
          Changes are applied to the deck as soon as you make them.
          {data && !data.rest && ' The deck\'s REST API isn\'t answering, so codec and video-format lists, audio record formats and monitoring options are limited. Enable it in the deck\'s network settings (or check the REST port under Edit).'}
        </p>
        <button className="btn small ghost" onClick={load} disabled={loading}>{loading ? 'Reading…' : 'Re-read from deck'}</button>
      </div>

      <div className="settings-grid">
        {groups.map(([group, items]) => (
          <section key={group} className="card settings-group">
            <h3>{group}</h3>
            {items.map((s) => (
              <SettingRow key={s.id} setting={s} saving={saving === s.id} disabled={!!saving && saving !== s.id} onChange={(v) => change(s, v)} />
            ))}
          </section>
        ))}

        <section className="card settings-group">
          <h3>Network</h3>
          <div className="setting-row">
            <span>IP address</span>
            <span className="mono">{device.host}</span>
          </div>
          <p className="muted small">
            Blackmagic doesn't expose a HyperDeck's own network settings (IP, DHCP, subnet) over the network. Change them on the
            deck's front panel or with Blackmagic HyperDeck Setup, then update the address here with Edit. The panel checks the
            new address before saving and warns you if it can't reach it.
          </p>
        </section>

        <NasSettings device={device} notify={notify} />

        <DeviceActions device={device} notify={notify} />
      </div>
      {data?.errors.length ? <p className="error small">{data.errors.join(' · ')}</p> : null}
    </div>
  );
}

function SettingRow({ setting: s, saving, disabled, onChange }: { setting: DeckSetting; saving: boolean; disabled: boolean; onChange: (v: unknown) => void }) {
  const [draft, setDraft] = useState(String(s.value ?? ''));
  useEffect(() => setDraft(String(s.value ?? '')), [s.value]);
  const id = `set-${s.id.replace(/[^a-z0-9]/gi, '-')}`;
  const commitText = () => { if (draft !== String(s.value ?? '')) onChange(draft); };

  let control: React.ReactNode;
  if (s.type === 'info' || s.readOnly) {
    control = <span className="mono">{String(s.value ?? '—')}</span>;
  } else if (s.type === 'bool') {
    control = (
      <label className="switch">
        <input id={id} type="checkbox" checked={Boolean(s.value)} disabled={disabled || saving} onChange={(e) => onChange(e.target.checked)} />
        <span aria-hidden />
      </label>
    );
  } else if (s.type === 'select') {
    control = (
      <select id={id} value={String(s.value ?? '')} disabled={disabled || saving} onChange={(e) => onChange(e.target.value)}>
        {s.value === null && <option value="">—</option>}
        {s.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else {
    control = (
      <input
        id={id}
        className={s.type === 'timecode' ? 'mono' : ''}
        value={draft}
        disabled={disabled || saving}
        placeholder={s.type === 'timecode' ? 'hh:mm:ss:ff' : ''}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setDraft(String(s.value ?? '')); }}
      />
    );
  }
  return (
    <div className={`setting-row ${saving ? 'saving' : ''}`}>
      <label htmlFor={id}>
        {s.label}
        {s.help && <span className="muted small setting-help">{s.help}</span>}
      </label>
      <span className="setting-control">{control}{saving && <span className="spinner inline" aria-label="Saving" />}</span>
    </div>
  );
}

function DeviceActions({ device, notify }: { device: Device; notify: (m: string, kind?: 'ok' | 'err') => void }) {
  const [identify, setIdentify] = useState(false);
  const [confirmReboot, setConfirmReboot] = useState(false);
  const [fmt, setFmt] = useState<{ slotId: number; name: string; filesystem: 'exFAT' | 'HFS+'; confirm: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const recording = device.state.transport?.status === 'record';
  const slot = fmt ? device.state.slots.find((s) => s.slotId === fmt.slotId) : null;
  const slotLabel = slot ? slot.volumeName || slot.slotName || `Slot ${slot.slotId}` : '';

  const run = async (action: string, body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      await api.action(device.id, action, body);
      notify(ok, 'ok');
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card settings-group">
      <h3>Maintenance</h3>
      <div className="setting-row">
        <span>Identify (flash the deck's display)</span>
        <label className="switch">
          <input type="checkbox" checked={identify} onChange={(e) => { setIdentify(e.target.checked); void run('identify', { enable: e.target.checked }, e.target.checked ? 'Identifying deck' : 'Identify off'); }} />
          <span aria-hidden />
        </label>
      </div>
      <div className="setting-row">
        <span>Restart the HyperDeck</span>
        {confirmReboot ? (
          <span className="confirm">
            Restart now?
            <button className="btn small danger" disabled={busy} onClick={() => { setConfirmReboot(false); void run('reboot', {}, 'Restarting — the deck reconnects in about a minute'); }}>Restart</button>
            <button className="btn small ghost" onClick={() => setConfirmReboot(false)}>Cancel</button>
          </span>
        ) : (
          <button className="btn small" disabled={recording} onClick={() => setConfirmReboot(true)}>Restart…</button>
        )}
      </div>
      <div className="setting-row">
        <span>Format media</span>
        {!fmt && (
          <button className="btn small danger ghost" disabled={recording || !device.state.slots.length}
            onClick={() => setFmt({ slotId: device.state.slots[0].slotId, name: '', filesystem: 'exFAT', confirm: '' })}>Format…</button>
        )}
      </div>
      {fmt && (
        <div className="format-box">
          <p className="error small">Formatting erases every clip on the selected media. This can't be undone.</p>
          <div className="row3">
            <label><span className="muted small">Media</span>
              <select value={fmt.slotId} onChange={(e) => setFmt({ ...fmt, slotId: Number(e.target.value), confirm: '' })}>
                {device.state.slots.map((s) => <option key={s.slotId} value={s.slotId}>{s.volumeName || s.slotName || `Slot ${s.slotId}`}</option>)}
              </select>
            </label>
            <label><span className="muted small">New volume name</span>
              <input value={fmt.name} onChange={(e) => setFmt({ ...fmt, name: e.target.value })} placeholder="e.g. Show Day 3" />
            </label>
            <label><span className="muted small">File system</span>
              <select value={fmt.filesystem} onChange={(e) => setFmt({ ...fmt, filesystem: e.target.value as 'exFAT' | 'HFS+' })}>
                <option value="exFAT">exFAT (Windows and Mac)</option>
                <option value="HFS+">HFS+ (Mac)</option>
              </select>
            </label>
          </div>
          <label className="confirm-type">
            <span className="muted small">Type <strong>{slotLabel}</strong> to confirm</span>
            <input value={fmt.confirm} onChange={(e) => setFmt({ ...fmt, confirm: e.target.value })} />
          </label>
          <div className="form-actions">
            <span className="spacer" />
            <button className="btn small ghost" onClick={() => setFmt(null)}>Cancel</button>
            <button className="btn small danger" disabled={busy || fmt.confirm !== slotLabel || !fmt.name.trim()}
              onClick={async () => { if (await run('format', { slotId: fmt.slotId, name: fmt.name.trim(), filesystem: fmt.filesystem }, `Formatted ${slotLabel}`)) setFmt(null); }}>
              {busy ? 'Formatting…' : `Erase and format ${slotLabel}`}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
