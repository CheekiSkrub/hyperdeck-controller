import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { entryLength, isSlice, type Editor } from '../lib/editor';
import { fpsFromFormat, framesToTc } from '../lib/tc';
import type { Device, EditEntry } from '../lib/types';

type Send = (command: string, params?: Record<string, string | number | boolean>) => Promise<void>;

export const CLIP_MIME = 'application/x-hdc-clip';
const ENTRY_MIME = 'application/x-hdc-entry';

export interface DraggedClip { slotId: number; file: string; frames: number; in?: number; out?: number }

interface Menu { x: number; y: number; index: number | null; frame: number }

/**
 * The deck's timeline as an editor track. Drag clips in from the browser,
 * drag blocks to reorder, drag block edges to trim, right-click to split,
 * duplicate or remove. Every change is applied to the HyperDeck.
 */
export function EditTimeline({ device, editor, send, notify, onOpen }: {
  device: Device;
  editor: Editor;
  send: Send;
  notify: (m: string, kind?: 'ok' | 'err') => void;
  onOpen: (entry: EditEntry, index: number, frame?: number) => void;
}) {
  const t = device.state.transport!;
  const fps = fpsFromFormat(t.videoFormat) ?? 25;
  const entries = editor.entries;
  const lengths = entries.map(entryLength);
  const total = Math.max(1, lengths.reduce((a, b) => a + b, 0));
  const starts = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const l of lengths) { out.push(acc); acc += l; }
    return out;
  }, [entries]);
  const pos = Math.min(total - 1, t.timeline ?? 0);
  const activeSlot = device.state.slots.find((s) => s.slotId === t.slotId);
  const activeLabel = activeSlot?.volumeName || activeSlot?.slotName || `slot ${t.slotId}`;

  const track = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const trim = useRef<{ index: number; side: 'in' | 'out'; x: number; orig: EditEntry; pxPerFrame: number; base: EditEntry[] } | null>(null);

  const frameAtX = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(total - 1, Math.round(((clientX - r.left) / r.width) * total)));
  };
  const indexAtFrame = (f: number) => starts.findIndex((s, i) => f >= s && f < s + lengths[i]);
  const insertIndexAtX = (clientX: number) => {
    const f = frameAtX(clientX);
    const i = starts.findIndex((s, k) => f < s + lengths[k] / 2);
    return i < 0 ? entries.length : i;
  };

  // ------------------------------------------------------------------ edit operations
  const remove = (i: number) => { setSelected(null); void editor.commit(entries.filter((_, k) => k !== i)); };
  const duplicate = (i: number) => void editor.commit([...entries.slice(0, i + 1), { ...entries[i] }, ...entries.slice(i + 1)]);
  const splitAt = (f: number) => {
    const i = indexAtFrame(f);
    if (i < 0) return;
    const off = f - starts[i];
    if (off <= 0 || off >= lengths[i]) return notify('Move the playhead inside a clip to split it');
    const e = entries[i];
    void editor.commit([...entries.slice(0, i), { ...e, out: e.in + off }, { ...e, in: e.in + off }, ...entries.slice(i + 1)]);
  };
  const restoreDisk = () => {
    const disk = t.slotId ? device.state.disks[t.slotId] ?? [] : [];
    void editor.commit(disk.map((d) => {
      const frames = Math.round(tcFrames(d.duration, fps));
      return { file: d.name, in: 0, out: frames, frames };
    }));
  };

  // ------------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName) || document.querySelector('.modal')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) { e.preventDefault(); remove(selected); }
      else if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); splitAt(pos); }
      else if (e.key === 'Escape') { setMenu(null); setSelected(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); };
  }, [menu]);

  // ------------------------------------------------------------------ drag & drop
  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (!types.includes(CLIP_MIME) && !types.includes(ENTRY_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = types.includes(ENTRY_MIME) ? 'move' : 'copy';
    setDropAt(insertIndexAtX(e.clientX));
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const at = dropAt ?? entries.length;
    setDropAt(null);
    const moved = e.dataTransfer.getData(ENTRY_MIME);
    if (moved !== '') {
      const from = Number(moved);
      const next = [...entries];
      const [item] = next.splice(from, 1);
      next.splice(from < at ? at - 1 : at, 0, item);
      void editor.commit(next);
      return;
    }
    const raw = e.dataTransfer.getData(CLIP_MIME);
    if (!raw) return;
    const c = JSON.parse(raw) as DraggedClip;
    if (c.slotId !== t.slotId) {
      notify(`The deck's timeline can only use clips from the active media (${activeLabel}). Select that clip's slot first.`);
      return;
    }
    const entry: EditEntry = { file: c.file, in: c.in ?? 0, out: c.out ?? c.frames, frames: c.frames };
    void editor.commit([...entries.slice(0, at), entry, ...entries.slice(at)]);
  };

  // ------------------------------------------------------------------ trimming
  const startTrim = (e: React.PointerEvent, index: number, side: 'in' | 'out') => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const w = track.current!.getBoundingClientRect().width;
    trim.current = { index, side, x: e.clientX, orig: entries[index], pxPerFrame: w / total, base: entries };
  };
  const moveTrim = (e: React.PointerEvent) => {
    const tr = trim.current;
    if (!tr) return;
    const delta = Math.round((e.clientX - tr.x) / tr.pxPerFrame);
    const o = tr.orig;
    const next = { ...o };
    if (tr.side === 'in') next.in = Math.max(0, Math.min(o.out - 1, o.in + delta));
    else next.out = Math.max(o.in + 1, Math.min(o.frames, o.out + delta));
    editor.preview(tr.base.map((x, i) => (i === tr.index ? next : x)));
  };
  const endTrim = () => {
    const tr = trim.current;
    trim.current = null;
    if (!tr) return;
    const cur = editor.entries[tr.index];
    if (cur.in !== tr.orig.in || cur.out !== tr.orig.out) void editor.commit(editor.entries);
  };

  const onTrackClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.tl-block')) return;
    setSelected(null);
    if (entries.length) void send('goto', { timeline: frameAtX(e.clientX) });
  };

  return (
    <section className="card timeline editor">
      <div className="timeline-head">
        <span>
          Timeline · {entries.length} clip{entries.length === 1 ? '' : 's'} · <span className="muted">{activeLabel}</span>
          {editor.busy && <span className="muted"> · updating deck…</span>}
        </span>
        <span className="tl-tools">
          <span className="mono muted">{framesToTc(pos, fps)} / {framesToTc(total, fps)}</span>
          <button className="btn small ghost" onClick={() => splitAt(pos)} disabled={!entries.length} title="Split the clip under the playhead (S)">Split</button>
          <span className="seg small" role="group" aria-label="Zoom">
            <button onClick={() => setZoom((z) => Math.max(1, z / 2))} disabled={zoom <= 1} aria-label="Zoom out">−</button>
            <button onClick={() => setZoom(1)} className={zoom === 1 ? 'on' : ''}>Fit</button>
            <button onClick={() => setZoom((z) => Math.min(32, z * 2))} aria-label="Zoom in">+</button>
          </span>
        </span>
      </div>

      <div className="tl-scroll">
        <div
          className={`tl-track ${dropAt !== null ? 'dropping' : ''}`}
          style={{ width: `${zoom * 100}%` }}
          ref={track}
          onClick={onTrackClick}
          onDragOver={onDragOver}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null); }}
          onDrop={onDrop}
          onPointerMove={moveTrim}
          onPointerUp={endTrim}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('.tl-block')) return;
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, index: null, frame: frameAtX(e.clientX) });
          }}
        >
          {entries.length === 0 && <div className="tl-empty muted">Drag clips here to build the deck's playlist</div>}
          {entries.map((e, i) => {
            const left = (starts[i] / total) * 100;
            const width = (lengths[i] / total) * 100;
            const current = t.clipId === i + 1;
            return (
              <div
                key={`${i}-${e.file}`}
                className={`tl-block ${current ? 'current' : ''} ${selected === i ? 'selected' : ''} ${isSlice(e) ? 'slice' : ''}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                draggable
                onDragStart={(ev) => { if (trim.current || (ev.target as HTMLElement).classList.contains('tl-handle')) { ev.preventDefault(); return; } ev.dataTransfer.setData(ENTRY_MIME, String(i)); ev.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDropAt(null)}
                onClick={(ev) => { ev.stopPropagation(); setSelected(i); }}
                onDoubleClick={() => onOpen(e, i)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  setSelected(i);
                  setMenu({ x: ev.clientX, y: ev.clientY, index: i, frame: frameAtX(ev.clientX) });
                }}
                title={`${e.file}\nIn ${framesToTc(e.in, fps)} · Out ${framesToTc(e.out, fps)} · ${framesToTc(lengths[i], fps)}${e.approx ? '\n(in point estimated)' : ''}`}
              >
                {t.slotId && <img className="tl-thumb" src={api.frameUrl(device.id, t.slotId, e.file, e.in, 180)} alt="" draggable={false} loading="lazy" />}
                <span className="tl-label">
                  <span className="tl-name">{e.file}</span>
                  <span className="mono">{framesToTc(lengths[i], fps)}{isSlice(e) ? ' ✂' : ''}</span>
                </span>
                <span className="tl-handle in" onPointerDown={(ev) => startTrim(ev, i, 'in')} title="Drag to trim the start" />
                <span className="tl-handle out" onPointerDown={(ev) => startTrim(ev, i, 'out')} title="Drag to trim the end" />
              </div>
            );
          })}
          {dropAt !== null && (
            <div className="tl-drop" style={{ left: `${((starts[dropAt] ?? total) / total) * 100}%` }} />
          )}
          <div className="tl-head" style={{ left: `${(pos / total) * 100}%` }} />
        </div>
      </div>
      <div className="muted small tl-hint">
        Drag clips from below to add · drag blocks to reorder · drag edges to trim · right-click for split and remove · S splits at the playhead · Delete removes the selected clip
      </div>

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} role="menu" onClick={(e) => e.stopPropagation()}>
          {menu.index !== null ? (
            <>
              <button role="menuitem" onClick={() => { setMenu(null); void send('goto', { 'clip id': menu.index! + 1 }); }}>Cue this clip</button>
              <button role="menuitem" onClick={() => { setMenu(null); void send('goto', { timeline: menu.frame }).then(() => send('play')); }}>Play from here</button>
              <button role="menuitem" onClick={() => { setMenu(null); onOpen(entries[menu.index!], menu.index!); }}>Open in viewer…</button>
              <hr />
              <button role="menuitem" onClick={() => { setMenu(null); splitAt(menu.frame); }}>Split here</button>
              <button role="menuitem" onClick={() => { setMenu(null); splitAt(pos); }}>Split at playhead</button>
              <button role="menuitem" onClick={() => { setMenu(null); duplicate(menu.index!); }}>Duplicate</button>
              {isSlice(entries[menu.index]) && (
                <button role="menuitem" onClick={() => { setMenu(null); const e = entries[menu.index!]; void editor.commit(entries.map((x, k) => (k === menu.index ? { ...e, in: 0, out: e.frames } : x))); }}>Restore full clip</button>
              )}
              <hr />
              <button role="menuitem" className="danger" onClick={() => { setMenu(null); remove(menu.index!); }}>Remove from timeline</button>
            </>
          ) : (
            <>
              <button role="menuitem" onClick={() => { setMenu(null); restoreDisk(); }}>Reset to all clips on {activeLabel}</button>
              <button role="menuitem" className="danger" onClick={() => { setMenu(null); void editor.commit([]); }} disabled={!entries.length}>Clear timeline</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function tcFrames(tc: string, fps: number) {
  const m = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(tc);
  if (!m) return 0;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * Math.round(fps) + Number(m[4]);
}
