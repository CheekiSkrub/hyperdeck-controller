import { useState } from 'react';
import { api } from '../lib/api';
import { useDevices } from '../lib/store';
import { framesToTc } from '../lib/tc';
import type { Device } from '../lib/types';
import { Modal } from './Modal';

/**
 * EVS-style instant replay: grab the last N seconds of whatever another
 * HyperDeck is currently capturing (or most recently captured) and drop it
 * onto this device's timeline. This works when the two decks can both see
 * the same file — typically because the source deck(s) are recording to a
 * shared network location and this deck is also pointed at it, the classic
 * "replay channel watches the record channels' storage" setup.
 */
export function InstantReplay({ device, onClose, notify }: {
  device: Device;
  onClose: () => void;
  notify: (m: string, kind?: 'ok' | 'err') => void;
}) {
  const devices = useDevices();
  const sources = devices.filter((d) => d.id !== device.id);
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [seconds, setSeconds] = useState(20);
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ file: string; inFrames: number; outFrames: number; fps: number } | null>(null);

  const source = sources.find((d) => d.id === sourceId);

  const take = async () => {
    if (!sourceId) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const r = await api.instantReplay(sourceId, { seconds, targetId: device.id, mode });
      setResult({ file: r.source.file, inFrames: r.inFrames, outFrames: r.outFrames, fps: r.source.fps });
      notify(`Loaded the last ${seconds}s of "${r.source.file}" onto ${device.name}'s timeline`, 'ok');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Instant replay → ${device.name}`} onClose={onClose}>
      <div className="form">
        <p className="muted small">
          Take the last few seconds of what another HyperDeck is recording (or last recorded) and put it on
          <strong> {device.name}</strong>'s timeline. Works when both decks can see the same file — usually because
          they're recording to and watching the same network share.
        </p>

        {sources.length === 0 ? (
          <p className="muted">No other HyperDecks configured yet.</p>
        ) : (
          <>
            <label>
              <span>Source HyperDeck</span>
              <select value={sourceId} onChange={(e) => { setSourceId(e.target.value); setResult(null); setError(null); }}>
                {sources.map((d) => <option key={d.id} value={d.id}>{d.name}{d.state.status !== 'connected' ? ' (offline)' : ''}</option>)}
              </select>
            </label>

            <div className="row3">
              <label>
                <span>Seconds back</span>
                <input type="number" min={1} max={3600} value={seconds} onChange={(e) => setSeconds(Math.max(1, Number(e.target.value) || 1))} />
              </label>
              <label>
                <span>Onto the timeline</span>
                <select value={mode} onChange={(e) => setMode(e.target.value as 'append' | 'replace')}>
                  <option value="append">Add to end</option>
                  <option value="replace">Replace timeline</option>
                </select>
              </label>
            </div>

            {source && source.state.status !== 'connected' && (
              <div className="banner warn" role="alert">{source.name} isn't connected right now.</div>
            )}

            {error && <div className="error">{error}</div>}
            {result && (
              <div className="banner info" role="status">
                <div>
                  <strong>Loaded</strong>
                  <p className="muted small">
                    {result.file}: {framesToTc(result.inFrames, result.fps)} – {framesToTc(result.outFrames, result.fps)}
                  </p>
                </div>
              </div>
            )}
          </>
        )}

        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
          <button type="button" className="btn primary" disabled={!sourceId || busy} onClick={take}>
            {busy ? 'Loading…' : `Take last ${seconds}s`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
