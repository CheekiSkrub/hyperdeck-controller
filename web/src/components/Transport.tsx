import { useEffect, useRef, useState } from 'react';
import type { Device } from '../lib/types';
import { StatusBadge } from './StatusBadge';

type Send = (command: string, params?: Record<string, string | number | boolean>) => Promise<void>;

const SPEEDS = [200, 400, 800, 1600];

export function Transport({ device, send }: { device: Device; send: Send }) {
  const t = device.state.transport!;
  const clip = device.state.timeline.find((c) => c.id === t.clipId);
  const recording = t.status === 'record';
  const [recName, setRecName] = useState('');
  const [armRecord, setArmRecord] = useState(false);
  const [loop, setLoop] = useState(t.loop);
  const [single, setSingle] = useState(t.singleClip);
  const [shuttle, setShuttle] = useState(0);
  const lastShuttle = useRef(0);

  useEffect(() => setLoop(t.loop), [t.loop]);
  useEffect(() => setSingle(t.singleClip), [t.singleClip]);

  const nextSpeed = (dir: 1 | -1) => {
    const cur = Math.abs(t.speed);
    const sameDir = Math.sign(t.speed) === dir;
    const next = SPEEDS.find((s) => s > (sameDir ? cur : 100)) ?? SPEEDS[SPEEDS.length - 1];
    return dir * next;
  };

  const play = () => send('play', { loop, 'single clip': single });

  const onShuttle = (v: number) => {
    setShuttle(v);
    const now = performance.now();
    if (now - lastShuttle.current > 80) {
      lastShuttle.current = now;
      void send('shuttle', { speed: v });
    }
  };
  const releaseShuttle = () => {
    setShuttle(0);
    void send('stop');
  };

  // Keyboard: space play/stop, ←/→ frame step, shift+←/→ clip jump.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || document.querySelector('.modal')) return;
      if (e.code === 'Space') { e.preventDefault(); t.status === 'play' ? send('stop') : play(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); send('goto', e.shiftKey ? { 'clip id': '-1' } : { timeline: '-1' }); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); send('goto', e.shiftKey ? { 'clip id': '+1' } : { timeline: '+1' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const startRecord = () => {
    void send('record', recName.trim() ? { name: recName.trim() } : undefined);
    setArmRecord(false);
  };

  return (
    <section className={`card transport ${recording ? 'is-recording' : ''}`}>
      <div className="tc-block">
        <div className="tc mono" aria-label="Timecode">{t.displayTimecode}</div>
        <div className="tc-meta">
          <StatusBadge status={t.status} />
          {t.speed !== 0 && t.speed !== 100 && <span className="badge">{(t.speed / 100).toFixed(t.speed % 100 ? 1 : 0)}×</span>}
          <span className="muted">{clip ? clip.name : t.clipId ? `Clip ${t.clipId}` : 'No clip'}</span>
          <span className="muted">· {t.slotName ?? (t.slotId ? `Slot ${t.slotId}` : 'No media')}</span>
          <span className="muted">· {t.videoFormat}</span>
          {t.inputVideoFormat && <span className="muted">· Input {t.inputVideoFormat}</span>}
        </div>
      </div>

      <div className="transport-buttons">
        <button className="tbtn" title="Go to start" onClick={() => send('goto', { timeline: 'start' })} disabled={recording}>⏮</button>
        <button className="tbtn" title="Previous clip (Shift+←)" onClick={() => send('goto', { 'clip id': '-1' })} disabled={recording}>◂◂|</button>
        <button className="tbtn" title="Rewind" onClick={() => send('play', { speed: nextSpeed(-1) })} disabled={recording}>◀◀</button>
        <button className="tbtn" title="Step back one frame (←)" onClick={() => send('goto', { timeline: '-1' })} disabled={recording}>◂|</button>
        <button className="tbtn stop" title="Stop (Space)" onClick={() => send('stop')}>■</button>
        <button className={`tbtn play ${t.status === 'play' ? 'on' : ''}`} title="Play (Space)" onClick={play} disabled={recording}>▶</button>
        <button className="tbtn" title="Step forward one frame (→)" onClick={() => send('goto', { timeline: '+1' })} disabled={recording}>|▸</button>
        <button className="tbtn" title="Fast forward" onClick={() => send('play', { speed: nextSpeed(1) })} disabled={recording}>▶▶</button>
        <button className="tbtn" title="Next clip (Shift+→)" onClick={() => send('goto', { 'clip id': '+1' })} disabled={recording}>|▸▸</button>
        <button className="tbtn" title="Go to end" onClick={() => send('goto', { timeline: 'end' })} disabled={recording}>⏭</button>
        <span className="tsep" />
        {recording ? (
          <button className="tbtn rec on" title="Stop recording" onClick={() => send('stop')}>● Stop rec</button>
        ) : armRecord ? (
          <span className="rec-arm">
            <input autoFocus value={recName} onChange={(e) => setRecName(e.target.value)} placeholder="Clip name (optional)"
              onKeyDown={(e) => { if (e.key === 'Enter') startRecord(); if (e.key === 'Escape') setArmRecord(false); }} />
            <button className="tbtn rec" onClick={startRecord}>● Record</button>
            <button className="btn small ghost" onClick={() => setArmRecord(false)}>Cancel</button>
          </span>
        ) : (
          <button className="tbtn rec" title="Record" onClick={() => setArmRecord(true)}>● Rec</button>
        )}
      </div>

      <div className="transport-options">
        <label className="shuttle">
          <span>Shuttle</span>
          <input type="range" min={-1600} max={1600} step={25} value={shuttle} disabled={recording}
            onChange={(e) => onShuttle(Number(e.target.value))}
            onPointerUp={releaseShuttle} onKeyUp={releaseShuttle} />
          <span className="mono small shuttle-val">{(shuttle / 100).toFixed(2)}×</span>
        </label>
        <label className="check"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop</label>
        <label className="check"><input type="checkbox" checked={single} onChange={(e) => setSingle(e.target.checked)} /> Single clip</label>
        <div className="seg" role="group" aria-label="Output mode">
          <button className={t.status === 'preview' ? 'on' : ''} onClick={() => send('preview', { enable: true })} disabled={recording}>Input</button>
          <button className={t.status !== 'preview' ? 'on' : ''} onClick={() => send('preview', { enable: false })} disabled={recording}>Playback</button>
        </div>
      </div>
    </section>
  );
}
