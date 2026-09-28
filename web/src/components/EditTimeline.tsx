import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { entryLength, isSlice, type Editor } from '../lib/editor';
import { useLiveFrames } from '../lib/liveFrames';
import { useMediaEvents } from '../lib/store';
import { SavedTimelines } from './SavedTimelines';
import { fpsFromFormat, framesToTc, tcToFrames } from '../lib/tc';
import type { Device, EditEntry, StripStatus } from '../lib/types';

type Send = (command: string, params?: Record<string, string | number | boolean>) => Promise<void>;

export const CLIP_MIME = 'application/x-hdc-clip';
const ENTRY_MIME = 'application/x-hdc-entry';

export interface DraggedClip { slotId: number; file: string; frames: number; in?: number; out?: number }

interface Menu { x: number; y: number; index: number | null; frame: number }

/** Zoom limits in pixels per frame (≈ 1 hour across 1000px … individual frames 60px wide). */
const MIN_PPF = 0.01;
const MAX_PPF = 60;
const HEADER_W = 72;
const MOVING = new Set(['play', 'forward', 'rewind', 'shuttle']);
const THUMB_H = 52;
const THUMB_W = Math.round((THUMB_H * 16) / 9);

/**
 * Filmstrips for every file on the timeline, used for continuous thumbnails
 * along each clip (the server generates them progressively and caches them).
 */
function useStrips(deviceId: string, slotId: number | null, files: string[]) {
  const [strips, setStrips] = useState<Record<string, StripStatus | null>>({});
  const [, bump] = useState(0);
  const key = files.join('|');
  useEffect(() => {
    if (!slotId) return;
    let cancelled = false;
    for (const f of new Set(files)) {
      if (f in strips) continue;
      setStrips((s) => ({ ...s, [f]: null }));
      api.strip(deviceId, slotId, f).then((st) => !cancelled && setStrips((s) => ({ ...s, [f]: st }))).catch(() => {});
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, slotId, key]);
  useMediaEvents((e) => {
    if (e.type !== 'strip') return;
    for (const st of Object.values(strips)) {
      if (st && st.key === e.key && e.index >= 0) { st.ready[e.index] = true; bump((n) => n + 1); }
    }
  }, [strips]);
  return strips;
}

function nearestReadyTile(st: StripStatus, seconds: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < st.times.length; i++) {
    if (!st.ready[i]) continue;
    const d = Math.abs(st.times[i] - seconds);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * NLE-style timeline (think Premiere / Resolve): a fixed time scale in pixels
 * per frame, a timecode ruler, an open-ended track you scroll through, zoom
 * around the cursor, a draggable playhead that scrubs the deck, and page
 * scrolling that follows playback. Clips butt together because the deck's
 * timeline has no gaps — trims ripple.
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
  const lengths = useMemo(() => entries.map(entryLength), [entries]);
  const total = lengths.reduce((a, b) => a + b, 0);
  const starts = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const l of lengths) { out.push(acc); acc += l; }
    return out;
  }, [lengths]);
  const activeSlot = device.state.slots.find((s) => s.slotId === t.slotId);
  const activeLabel = activeSlot?.volumeName || activeSlot?.slotName || `slot ${t.slotId}`;

  // ------------------------------------------------------------------ scale & viewport
  const scroller = useRef<HTMLDivElement>(null);
  const [ppf, setPpf] = useState<number | null>(null); // null until first fit
  const [view, setView] = useState({ left: 0, width: 800 });
  const zoomAnchor = useRef<{ frame: number; x: number } | null>(null);

  const fitPpf = useCallback((width: number) => {
    const frames = Math.max(total, fps * 30);
    return clamp((width - 40) / frames, MIN_PPF, MAX_PPF);
  }, [total, fps]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setView({ left: el.scrollLeft, width: el.clientWidth });
    update();
    if (ppf === null) setPpf(fitPpf(el.clientWidth));
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ppf, fitPpf]);

  const scale = ppf ?? 1;
  // Open-ended: always at least a screen of empty track after the last clip.
  const contentWidth = Math.max(view.width, (total * scale) + view.width * 0.75);

  // Keep the frame under the cursor fixed while zooming.
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const el = scroller.current;
    if (!a || !el) return;
    zoomAnchor.current = null;
    el.scrollLeft = Math.max(0, a.frame * scale - a.x);
    setView({ left: el.scrollLeft, width: el.clientWidth });
  }, [scale]);

  const zoomTo = useCallback((next: number, anchorX?: number) => {
    const el = scroller.current;
    if (!el) return;
    const x = anchorX ?? el.clientWidth / 2;
    zoomAnchor.current = { frame: (el.scrollLeft + x) / scale, x };
    setPpf(clamp(next, MIN_PPF, MAX_PPF));
  }, [scale]);

  const onWheel = useCallback((e: WheelEvent) => {
    const el = scroller.current!;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      // Premiere: Alt+wheel zooms; trackpad pinch arrives as ctrl+wheel.
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomTo(scale * Math.exp(-e.deltaY * 0.0025), e.clientX - rect.left);
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
      // Plain vertical wheel scrolls the timeline horizontally, like an NLE.
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
  }, [scale, zoomTo]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  // ------------------------------------------------------------------ playhead
  const livePos = useLiveFrames(t.timeline ?? 0, t.status, t.speed, fps);
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const pos = Math.max(0, Math.min(Math.max(0, total - 1), scrubbing ?? livePos));
  const lastScrubSent = useRef(0);

  // Which clip the playhead is over, and how much time is left in it and in the whole timeline —
  // shown as countdowns next to the elapsed timecode, the way an NLE does.
  const currentClipIndex = useMemo(() => {
    for (let i = starts.length - 1; i >= 0; i--) if (pos >= starts[i]) return i;
    return -1;
  }, [starts, pos]);
  const clipRemaining = currentClipIndex >= 0 ? Math.max(0, starts[currentClipIndex] + lengths[currentClipIndex] - pos) : 0;
  const timelineRemaining = Math.max(0, total - pos);

  // Page-scroll to follow the playhead during playback (Premiere "page scroll").
  useEffect(() => {
    const el = scroller.current;
    if (!el || scrubbing !== null || !MOVING.has(t.status)) return;
    const x = pos * scale;
    if (x > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = x - 40;
    else if (x < el.scrollLeft) el.scrollLeft = Math.max(0, x - el.clientWidth + 80);
  }, [pos, scale, t.status, scrubbing]);

  const frameAtClientX = (clientX: number) => {
    const el = scroller.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.round((clientX - rect.left + el.scrollLeft) / scale));
  };

  const scrubTo = (f: number, final: boolean) => {
    const frame = clamp(f, 0, Math.max(0, total - 1));
    setScrubbing(frame);
    const now = performance.now();
    if (final || now - lastScrubSent.current > 50) {
      lastScrubSent.current = now;
      if (entries.length) void send('goto', { timeline: frame });
    }
  };
  const onRulerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    scrubTo(frameAtClientX(e.clientX), false);
  };
  const onRulerMove = (e: React.PointerEvent) => {
    if (scrubbing !== null) scrubTo(frameAtClientX(e.clientX), false);
  };
  const onRulerUp = (e: React.PointerEvent) => {
    if (scrubbing === null) return;
    scrubTo(frameAtClientX(e.clientX), true);
    // Hold the local position briefly so the head doesn't jump back before the deck reports.
    setTimeout(() => setScrubbing(null), 250);
  };

  // ------------------------------------------------------------------ ruler ticks (visible range only)
  const strips = useStrips(device.id, t.slotId, entries.map((e) => e.file));
  const ticks = useMemo(() => rulerTicks(view.left, view.width, scale, fps), [view.left, view.width, scale, fps]);

  // ------------------------------------------------------------------ editing
  const [selected, setSelected] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const trim = useRef<{ index: number; side: 'in' | 'out'; x: number; orig: EditEntry; base: EditEntry[] } | null>(null);

  const indexAtFrame = (f: number) => starts.findIndex((s, i) => f >= s && f < s + lengths[i]);
  const insertIndexAtClientX = (clientX: number) => {
    const f = frameAtClientX(clientX);
    const i = starts.findIndex((s, k) => f < s + lengths[k] / 2);
    return i < 0 ? entries.length : i;
  };
  const editPoints = useMemo(() => [...starts, total], [starts, total]);

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
      const frames = tcToFrames(d.duration, fps);
      return { file: d.name, in: 0, out: frames, frames };
    }));
  };

  // Keyboard, NLE conventions: S split, Delete remove, ↑/↓ previous/next edit, +/- zoom, \ fit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName) || document.querySelector('.modal')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) { e.preventDefault(); remove(selected); }
      else if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); splitAt(pos); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); const p = [...editPoints].reverse().find((x) => x < pos); if (p !== undefined) scrubTo(p, true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); const n = editPoints.find((x) => x > pos); if (n !== undefined) scrubTo(Math.min(n, total - 1), true); }
      else if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomTo(scale * 1.5); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomTo(scale / 1.5); }
      else if (e.key === '\\') { e.preventDefault(); fit(); }
      else if (e.key === 'Escape') { setMenu(null); setSelected(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const fit = () => {
    const el = scroller.current;
    if (!el) return;
    setPpf(fitPpf(el.clientWidth));
    el.scrollLeft = 0;
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); };
  }, [menu]);

  // Drag & drop from the clip browser (copy) and within the track (move).
  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (!types.includes(CLIP_MIME) && !types.includes(ENTRY_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = types.includes(ENTRY_MIME) ? 'move' : 'copy';
    setDropAt(insertIndexAtClientX(e.clientX));
    // Auto-scroll when dragging near the edges.
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    if (e.clientX > r.right - 40) el.scrollLeft += 20;
    else if (e.clientX < r.left + 40) el.scrollLeft -= 20;
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

  // Ripple trim by dragging a clip edge.
  const startTrim = (e: React.PointerEvent, index: number, side: 'in' | 'out') => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    trim.current = { index, side, x: e.clientX, orig: entries[index], base: entries };
  };
  const moveTrim = (e: React.PointerEvent) => {
    const tr = trim.current;
    if (!tr) return;
    const delta = Math.round((e.clientX - tr.x) / scale);
    const o = tr.orig;
    const next = { ...o };
    if (tr.side === 'in') next.in = clamp(o.in + delta, 0, o.out - 1);
    else next.out = clamp(o.out + delta, o.in + 1, o.frames);
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
    if ((e.target as HTMLElement).closest('.nle-clip')) return;
    setSelected(null);
    if (!entries.length) return;
    scrubTo(frameAtClientX(e.clientX), true);
    setTimeout(() => setScrubbing(null), 250);
  };

  const playheadX = pos * scale;
  const zoomSlider = Math.log(scale / MIN_PPF) / Math.log(MAX_PPF / MIN_PPF);

  return (
    <section className="card timeline editor">
      <div className="timeline-head">
        <span>
          Timeline · {entries.length} clip{entries.length === 1 ? '' : 's'} · <span className="muted">{activeLabel}</span>
          {editor.busy && <span className="muted"> · updating deck…</span>}
        </span>
        <span className="tl-tools">
          <span className="mono tl-pos">{framesToTc(pos, fps)}</span>
          <span className="mono muted">/ {framesToTc(total, fps)}</span>
          {entries.length > 0 && (
            <span className="tl-countdowns">
              <span className="mono muted small" title="Time remaining in the current clip">clip −{framesToTc(clipRemaining, fps)}</span>
              <span className="mono muted small" title="Time remaining in the timeline">tl −{framesToTc(timelineRemaining, fps)}</span>
            </span>
          )}
          <button className="btn small ghost" onClick={() => splitAt(pos)} disabled={!entries.length} title="Split the clip under the playhead (S)">Split</button>
          <button className="btn small ghost" onClick={fit} title="Zoom to fit the sequence (\)">Fit</button>
          <label className="zoom" title="Zoom (Alt/Ctrl + wheel, + and −)">
            <span aria-hidden>−</span>
            <input type="range" min={0} max={1} step={0.001} value={zoomSlider}
              onChange={(e) => zoomTo(MIN_PPF * Math.pow(MAX_PPF / MIN_PPF, Number(e.target.value)), playheadX - view.left)} aria-label="Timeline zoom" />
            <span aria-hidden>+</span>
          </label>
        </span>
      </div>

      <div className="nle">
        <div className="nle-headers" style={{ width: HEADER_W }}>
          <div className="nle-ruler-spacer" />
          <div className="nle-track-header">
            <strong>V1</strong>
            <span className="muted small">Deck</span>
          </div>
        </div>

        <div className="nle-scroll" ref={scroller} onScroll={(e) => setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })}>
          <div className="nle-canvas" style={{ width: contentWidth }}>
            <div className="nle-ruler" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
              {ticks.map((k) => (
                <div key={k.frame} className={`tick ${k.major ? 'major' : ''}`} style={{ left: k.frame * scale }}>
                  {k.major && <span>{framesToTc(k.frame, fps)}</span>}
                </div>
              ))}
            </div>

            <div
              className={`nle-track ${dropAt !== null ? 'dropping' : ''}`}
              onClick={onTrackClick}
              onDragOver={onDragOver}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null); }}
              onDrop={onDrop}
              onPointerMove={moveTrim}
              onPointerUp={endTrim}
              onContextMenu={(e) => {
                if ((e.target as HTMLElement).closest('.nle-clip')) return;
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, index: null, frame: frameAtClientX(e.clientX) });
              }}
            >
              {entries.length === 0 && <div className="tl-empty muted" style={{ width: view.width - 16 }}>Drag clips here to build the deck's playlist</div>}
              {entries.map((e, i) => {
                const w = lengths[i] * scale;
                const current = t.clipId === i + 1;
                return (
                  <div
                    key={`${i}-${e.file}`}
                    className={`nle-clip ${current ? 'current' : ''} ${selected === i ? 'selected' : ''} ${isSlice(e) ? 'slice' : ''} ${w < 40 ? 'tiny' : ''}`}
                    style={{ left: starts[i] * scale, width: Math.max(2, w) }}
                    draggable
                    onDragStart={(ev) => {
                      if (trim.current || (ev.target as HTMLElement).classList.contains('tl-handle')) { ev.preventDefault(); return; }
                      ev.dataTransfer.setData(ENTRY_MIME, String(i));
                      ev.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDropAt(null)}
                    onClick={(ev) => { ev.stopPropagation(); setSelected(i); }}
                    onDoubleClick={() => onOpen(e, i)}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      setSelected(i);
                      setMenu({ x: ev.clientX, y: ev.clientY, index: i, frame: frameAtClientX(ev.clientX) });
                    }}
                    title={`${e.file}\nIn ${framesToTc(e.in, fps)} · Out ${framesToTc(e.out, fps)} · ${framesToTc(lengths[i], fps)}${e.approx ? '\n(in point estimated)' : ''}`}
                  >
                    <ClipThumbs entry={e} left={starts[i] * scale} width={w} scale={scale} fps={fps} view={view}
                      strip={strips[e.file] ?? null} frameUrl={(f) => api.frameUrl(device.id, t.slotId!, e.file, f, 180)} />
                    {w >= 40 && (
                      <span className="nle-label" style={{ transform: `translateX(${labelOffset(starts[i] * scale, w, view.left)}px)` }}>
                        <span className="tl-name">{isSlice(e) ? '✂ ' : ''}{e.file}</span>
                        <span className="mono">{framesToTc(lengths[i], fps)}</span>
                      </span>
                    )}
                    <span className="nle-audio" aria-hidden />
                    <span className="tl-handle in" onPointerDown={(ev) => startTrim(ev, i, 'in')} title="Drag to trim the start (ripple)" />
                    <span className="tl-handle out" onPointerDown={(ev) => startTrim(ev, i, 'out')} title="Drag to trim the end (ripple)" />
                  </div>
                );
              })}
              {dropAt !== null && <div className="tl-drop" style={{ left: (starts[dropAt] ?? total) * scale }} />}
            </div>

            <div className="nle-playhead" style={{ transform: `translateX(${playheadX}px)` }}>
              <span className="nle-playhead-cap" />
            </div>
          </div>
        </div>
      </div>
      <div className="muted small tl-hint">
        Drag clips in from below · drag to reorder · drag edges to trim · right-click for split and remove ·
        Alt/Ctrl + wheel to zoom · \ fit · ↑/↓ previous/next edit · S split · Delete remove
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

/** Keep a clip's name visible at the left edge of the view while its start is scrolled off (like an NLE). */
function labelOffset(clipLeft: number, clipWidth: number, viewLeft: number) {
  return Math.max(0, Math.min(viewLeft - clipLeft, clipWidth - 160));
}

/**
 * Continuous thumbnails along a clip, drawn only for the visible part: one
 * slot per thumbnail width, each showing the nearest filmstrip tile for that
 * point in the clip. Falls back to head/tail frames until the strip exists.
 */
function ClipThumbs({ entry, left, width, scale, fps, view, strip, frameUrl }: {
  entry: EditEntry; left: number; width: number; scale: number; fps: number;
  view: { left: number; width: number }; strip: StripStatus | null; frameUrl: (frame: number) => string;
}) {
  if (width < 40) return null;
  if (!strip || !strip.ready.some(Boolean)) {
    return (
      <>
        <img className="nle-thumb head" src={frameUrl(entry.in)} alt="" draggable={false} loading="lazy" />
        {width > 260 && <img className="nle-thumb tail" src={frameUrl(Math.max(entry.in, entry.out - 1))} alt="" draggable={false} loading="lazy" />}
      </>
    );
  }
  const slots = Math.ceil(width / THUMB_W);
  const first = Math.max(0, Math.floor((view.left - left) / THUMB_W) - 1);
  const last = Math.min(slots - 1, Math.ceil((view.left + view.width - left) / THUMB_W) + 1);
  const out: React.ReactNode[] = [];
  for (let k = first; k <= last; k++) {
    const frame = Math.min(entry.out - 1, entry.in + (k * THUMB_W + THUMB_W / 2) / scale);
    const idx = nearestReadyTile(strip, frame / fps);
    if (idx < 0) continue;
    out.push(<img key={k} className="nle-thumb" style={{ left: k * THUMB_W }} src={api.stripTileUrl(strip.key, idx)} alt="" draggable={false} />);
  }
  return <>{out}</>;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Ruler ticks for the visible range; major labels at least ~90px apart. */
function rulerTicks(left: number, width: number, ppf: number, fps: number) {
  const f = Math.round(fps);
  const steps = [1, 2, 5, 10, f, 2 * f, 5 * f, 10 * f, 15 * f, 30 * f, 60 * f, 120 * f, 300 * f, 600 * f, 900 * f, 1800 * f, 3600 * f];
  const major = steps.find((s) => s * ppf >= 90) ?? steps[steps.length - 1];
  const minorCandidates = steps.filter((s) => s < major && major % s === 0 && s * ppf >= 8);
  const minor = minorCandidates.length ? minorCandidates[minorCandidates.length - 1] : major;
  const startF = Math.max(0, Math.floor(left / ppf / minor) * minor);
  const endF = (left + width) / ppf + minor;
  const out: { frame: number; major: boolean }[] = [];
  for (let fr = startF; fr <= endF && out.length < 600; fr += minor) out.push({ frame: fr, major: fr % major === 0 });
  return out;
}
