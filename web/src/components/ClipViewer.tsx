import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAudioLevels } from '../lib/audio';
import type { Editor } from '../lib/editor';
import { useMediaEvents } from '../lib/store';
import { framesToTc, tcToFrames } from '../lib/tc';
import type { ClipListing, Device, MediaInfo, ProxyStatus, StripStatus } from '../lib/types';
import { Modal } from './Modal';
import { Waveform } from './Waveform';

/**
 * Scrub a clip in the browser and cue the HyperDeck to the chosen frame.
 *
 * While dragging, the nearest filmstrip tile is shown instantly; the exact
 * frame is fetched (debounced) and swapped in. If an H.264 proxy exists the
 * preview switches to a <video> element for smooth scrubbing and playback.
 */
export function ClipViewer({ device, clip, onClose, notify, editor, startFrame, editIndex = null }: {
  device: Device;
  clip: ClipListing;
  onClose: () => void;
  notify: (m: string, kind?: 'ok' | 'err') => void;
  editor: Editor;
  /** Open at this frame (e.g. from a timeline entry). */
  startFrame?: number;
  /** When opened from the timeline: the entry being edited. */
  editIndex?: number | null;
}) {
  const editing = editIndex !== null ? editor.entries[editIndex] : null;
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [strip, setStrip] = useState<StripStatus | null>(null);
  const [tileVersion, setTileVersion] = useState(0);
  const [frame, setFrame] = useState(startFrame ?? editing?.in ?? 0);
  const [markIn, setMarkIn] = useState<number | null>(editing && editing.in > 0 ? editing.in : null);
  const [markOut, setMarkOut] = useState<number | null>(editing && editing.out < editing.frames ? editing.out - 1 : null);
  /** Live-transcode playback started at this frame (null = not in live mode). */
  const [live, setLive] = useState<number | null>(null);
  const [directFailed, setDirectFailed] = useState(false);
  const [exact, setExact] = useState<{ frame: number; url: string } | null>(null);
  const [loadingExact, setLoadingExact] = useState(false);
  const [proxy, setProxy] = useState<ProxyStatus | null>(null);
  const [useProxy, setUseProxy] = useState(true);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [singleClip, setSingleClip] = useState(false);
  const [busy, setBusy] = useState<'cue' | 'play' | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const fps = info?.probe.fps ?? clip.fps ?? 25;
  const frames = Math.max(1, info?.probe.frames ?? clip.frames ?? 1);
  const wave = useAudioLevels(device.id, clip.slotId, [clip.file])[clip.file];
  // Proxies are H.264; every mainstream browser decodes it, but some Linux Chromium builds don't.
  const canPlayProxy = useMemo(() => Boolean(document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"')), []);
  const proxyReady = proxy?.state === 'ready' && useProxy && canPlayProxy;

  // Play the original file directly when the browser can decode it (H.264/H.265;
  // ProRes in Safari). From a network share this is just a fast ranged file read.
  const directOk = useMemo(() => {
    const codec = info?.probe.codec;
    const type = codec === 'h264' ? 'video/mp4; codecs="avc1.640028"'
      : codec === 'hevc' ? 'video/mp4; codecs="hvc1.1.6.L123.B0"'
        : codec === 'prores' ? 'video/quicktime; codecs="apch"' : null;
    return Boolean(type && document.createElement('video').canPlayType(type));
  }, [info?.probe.codec]);
  const originalUrl = api.originalUrl(device.id, clip.slotId, clip.file);
  const smoothSrc = proxyReady ? api.proxyUrl(proxy!.key) : directOk && !directFailed && originalUrl ? originalUrl : null;
  const smoothKind = proxyReady ? 'proxy' : smoothSrc ? 'original' : null;
  const liveAvailable = !smoothSrc && api.liveUrl(device.id, clip.slotId, clip.file, 0) !== null;

  // ------------------------------------------------------------------ load media info + filmstrip
  useEffect(() => {
    let cancelled = false;
    api.mediaInfo(device.id, clip.slotId, clip.file).then((i) => {
      if (cancelled) return;
      setInfo(i);
      setProxy(i.proxy);
      // Open at the deck's current position if this clip is on air.
      const t = device.state.transport;
      if (t && clip.timelineId === t.clipId && t.slotId === clip.slotId) {
        const tl = device.state.timeline.find((c) => c.id === clip.timelineId);
        if (tl?.inTimecode && t.timeline !== undefined) setFrame(Math.max(0, t.timeline - tcToFrames(tl.inTimecode, i.probe.fps)));
      }
      return api.strip(device.id, clip.slotId, clip.file).then((s) => !cancelled && setStrip(s));
    }).catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [device.id, clip.slotId, clip.file]);

  useMediaEvents((e) => {
    if (!info || e.key !== info.key) return;
    if (e.type === 'strip') {
      setStrip((s) => {
        if (!s) return s;
        if (e.index >= 0) s.ready[e.index] = true;
        return { ...s, done: e.done ?? s.done };
      });
      setTileVersion((v) => v + 1);
    } else if (e.type === 'proxy') {
      setProxy({ key: e.key, state: e.state as ProxyStatus['state'], progress: e.progress, error: e.error });
    }
  }, [info?.key]);

  // ------------------------------------------------------------------ exact frame (image mode)
  const exactHeight = useMemo(() => {
    const h = (stage.current?.clientHeight ?? 540) * (window.devicePixelRatio || 1);
    return h > 800 ? 1080 : h > 600 ? 720 : 540;
  }, [info]);

  useEffect(() => {
    if (!info || smoothSrc || live !== null) return;
    const delay = dragging.current ? 140 : 0;
    const timer = setTimeout(() => {
      const url = api.frameUrl(device.id, clip.slotId, clip.file, frame, exactHeight);
      setLoadingExact(true);
      const img = new Image();
      img.onload = () => {
        setExact((cur) => (cur?.frame === frame ? cur : { frame, url }));
        setLoadingExact(false);
      };
      img.onerror = () => setLoadingExact(false);
      img.src = url;
    }, delay);
    return () => clearTimeout(timer);
  }, [frame, info, smoothSrc, live, exactHeight]);

  // ------------------------------------------------------------------ video mode sync
  useEffect(() => {
    const v = video.current;
    if (!v || !smoothSrc || videoPlaying) return;
    const target = (frame + 0.1) / fps;
    if (Math.abs(v.currentTime - target) > 0.5 / fps) v.currentTime = target;
  }, [frame, smoothSrc, videoPlaying, fps]);

  useEffect(() => {
    const v = video.current;
    if (!v || !videoPlaying) return;
    let raf = 0;
    const tick = () => {
      setFrame(Math.min(frames - 1, (live ?? 0) + Math.floor(v.currentTime * fps)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoPlaying, fps, frames, live]);

  /** Any manual seek leaves live-transcode mode and goes back to exact stills. */
  const seek = useCallback((f: number) => {
    if (live !== null) { setLive(null); setVideoPlaying(false); }
    setFrame(Math.min(frames - 1, Math.max(0, f)));
  }, [live, frames]);

  // ------------------------------------------------------------------ scrubbing
  const frameFromX = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(ratio * (frames - 1));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    video.current?.pause();
    seek(frameFromX(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging.current) seek(frameFromX(e.clientX));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    seek(frameFromX(e.clientX));
  };

  const step = useCallback((n: number) => {
    video.current?.pause();
    seek(frame + n);
  }, [seek, frame]);

  // ------------------------------------------------------------------ in/out marks → timeline
  const onActiveSlot = device.state.transport?.slotId === clip.slotId;
  const entryFrames = clip.frames ?? frames;
  const sliceIn = markIn ?? 0;
  const sliceOut = Math.min(entryFrames, (markOut ?? entryFrames - 1) + 1);
  const addToTimeline = useCallback(async (replace: boolean) => {
    if (!onActiveSlot) {
      notify(`The deck's timeline uses the active media. Select ${clip.slotLabel} on the deck first.`);
      return;
    }
    if (sliceOut - sliceIn < 1) return notify('Out point must be after the in point');
    const entry = { file: clip.file, in: sliceIn, out: sliceOut, frames: entryFrames };
    const ok = replace && editIndex !== null
      ? await editor.commit(editor.entries.map((e, i) => (i === editIndex ? entry : e)))
      : await editor.append(entry);
    if (ok) notify(`${replace ? 'Updated' : 'Added'} ${clip.file} ${framesToTc(sliceIn, fps)}–${framesToTc(sliceOut, fps)} ${replace ? 'on' : 'to'} the timeline`, 'ok');
  }, [onActiveSlot, sliceIn, sliceOut, entryFrames, editIndex, editor, clip, fps, notify]);

  // ------------------------------------------------------------------ cue on the HyperDeck
  const cue = useCallback(async (play: boolean) => {
    setBusy(play ? 'play' : 'cue');
    try {
      await api.load(device.id, { slotId: clip.slotId, file: clip.file, frame, play, singleClip });
      notify(`${play ? 'Playing' : 'Cued'} ${clip.file} at ${framesToTc(frame, fps)}`, 'ok');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [device.id, clip, frame, fps, singleClip, notify]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const big = Math.round(fps);
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(e.shiftKey ? -big : -1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(e.shiftKey ? big : 1); }
      else if (e.key === 'Home') { e.preventDefault(); seek(0); }
      else if (e.key === 'End') { e.preventDefault(); seek(frames - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); void cue(e.shiftKey); }
      else if (e.code === 'Space' && (smoothSrc || liveAvailable || live !== null)) { e.preventDefault(); togglePlay(); }
      else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); setMarkIn(frame); if (markOut !== null && markOut < frame) setMarkOut(null); }
      else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); setMarkOut(frame); if (markIn !== null && markIn > frame) setMarkIn(null); }
      else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); setMarkIn(null); setMarkOut(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const togglePlay = () => {
    const v = video.current;
    if (!smoothSrc && live === null) {
      // Start a live transcode from the current frame (ProRes/DNx in Chrome etc.).
      if (liveAvailable) setLive(frame);
      return;
    }
    if (!v) return;
    if (v.paused) { void v.play(); } else v.pause();
  };

  // ------------------------------------------------------------------ derived display
  const nearestTile = useMemo(() => {
    if (!strip) return null;
    const t = frame / fps;
    let best = -1;
    let bestD = Infinity;
    strip.times.forEach((tt, i) => {
      if (!strip.ready[i]) return;
      const d = Math.abs(tt - t);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best >= 0 ? api.stripTileUrl(strip.key, best) : null;
  }, [strip, frame, fps, tileVersion]);

  const showExact = exact && exact.frame === frame;
  const startFrames = info?.probe.timecode ? tcToFrames(info.probe.timecode, fps) : 0;
  const sourceTc = framesToTc(startFrames + frame, fps);
  const readyCount = strip?.ready.filter(Boolean).length ?? 0;

  return (
    <Modal wide title={<span className="viewer-title">{clip.file} <span className="muted small">{clip.slotLabel}{clip.isNetwork ? ' · network storage' : ''}</span></span>} onClose={onClose}>
      {error ? (
        <div className="viewer-error">
          <p className="error">{error}</p>
          <p className="muted">You can still cue the HyperDeck to the start of this clip.</p>
          <button className="btn primary" onClick={() => cue(false)}>Cue on HyperDeck</button>
        </div>
      ) : (
        <div className="viewer">
          <div className="stage" ref={stage}>
            {smoothSrc ? (
              <video
                key={smoothSrc}
                ref={video}
                src={smoothSrc}
                preload="auto"
                playsInline
                onPlay={() => setVideoPlaying(true)}
                onPause={() => setVideoPlaying(false)}
                onLoadedMetadata={(e) => { e.currentTarget.currentTime = (frame + 0.1) / fps; }}
                onError={() => {
                  if (smoothKind === 'proxy') { setUseProxy(false); notify('This browser could not play the proxy — using frame-accurate stills instead'); }
                  else { setDirectFailed(true); notify("This browser couldn't play the original file — use ▶ for a live preview"); }
                }}
              />
            ) : live !== null ? (
              <video
                key={`live-${live}`}
                ref={video}
                src={api.liveUrl(device.id, clip.slotId, clip.file, live / fps)!}
                autoPlay
                playsInline
                onPlay={() => setVideoPlaying(true)}
                onPause={() => setVideoPlaying(false)}
                onEnded={() => setVideoPlaying(false)}
                onError={() => { setLive(null); setVideoPlaying(false); notify('Live preview failed — is ffmpeg available on the server?'); }}
              />
            ) : (
              <>
                {nearestTile && <img className="stage-img blur" src={nearestTile} alt="" />}
                {showExact && <img className="stage-img" src={exact!.url} alt={`Frame ${frame}`} />}
                {!nearestTile && !showExact && <div className="stage-wait muted">{info ? 'Loading frame…' : 'Opening clip…'}</div>}
                {loadingExact && <div className="spinner" aria-label="Loading exact frame" />}
              </>
            )}
            <div className="stage-tc mono">{sourceTc}</div>
          </div>

          <div className="scrub"
            ref={bar}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            role="slider"
            aria-valuemin={0}
            aria-valuemax={frames - 1}
            aria-valuenow={frame}
            aria-label="Scrub clip"
            tabIndex={0}
          >
            <div className="strip">
              {strip?.times.map((_, i) => (
                <div key={i} className="strip-tile">
                  {strip.ready[i] && <img src={api.stripTileUrl(strip.key, i)} alt="" draggable={false} />}
                </div>
              ))}
            </div>
            {wave && <Waveform levels={wave} from={0} to={frames / fps} className="scrub-wave" />}
            {(markIn !== null || markOut !== null) && (
              <div className="scrub-range" style={{
                left: `${(sliceIn / Math.max(1, frames - 1)) * 100}%`,
                width: `${(Math.max(1, Math.min(frames, sliceOut) - sliceIn) / Math.max(1, frames - 1)) * 100}%`,
              }} />
            )}
            <div className="scrub-head" style={{ left: `${(frame / Math.max(1, frames - 1)) * 100}%` }} />
          </div>

          <div className="viewer-controls">
            <div className="readout">
              <div><span className="muted small">Source TC</span> <span className="mono">{sourceTc}</span></div>
              <div><span className="muted small">Clip</span> <span className="mono">{framesToTc(frame, fps)}</span></div>
              <div><span className="muted small">Frame</span> <span className="mono">{frame} / {frames - 1}</span></div>
            </div>
            <div className="step-buttons">
              <button className="btn small" onClick={() => seek(0)} title="First frame (Home)">|◂</button>
              <button className="btn small" onClick={() => step(-Math.round(fps))} title="Back 1 second (Shift+←)">−1s</button>
              <button className="btn small" onClick={() => step(-1)} title="Back 1 frame (←)">−1f</button>
              {(smoothSrc || liveAvailable || live !== null) && (
                <button className="btn small play-btn" onClick={togglePlay}
                  title={smoothSrc ? `Play ${smoothKind === 'proxy' ? 'proxy' : 'original file'} in the browser (Space)` : 'Play a live preview transcoded by the server (Space)'}>
                  {videoPlaying ? '❚❚' : '▶'}
                </button>
              )}
              <button className="btn small" onClick={() => step(1)} title="Forward 1 frame (→)">+1f</button>
              <button className="btn small" onClick={() => step(Math.round(fps))} title="Forward 1 second (Shift+→)">+1s</button>
              <button className="btn small" onClick={() => seek(frames - 1)} title="Last frame (End)">▸|</button>
            </div>
          </div>

          <div className="viewer-controls marks">
            <div className="step-buttons">
              <button className="btn small" onClick={() => { setMarkIn(frame); if (markOut !== null && markOut < frame) setMarkOut(null); }} title="Mark in (I)">Mark in</button>
              <button className="btn small" onClick={() => { setMarkOut(frame); if (markIn !== null && markIn > frame) setMarkIn(null); }} title="Mark out (O)">Mark out</button>
              {(markIn !== null || markOut !== null) && <button className="btn small ghost" onClick={() => { setMarkIn(null); setMarkOut(null); }} title="Clear marks (X)">Clear</button>}
              <span className="mono small muted">
                {markIn !== null || markOut !== null
                  ? `In ${framesToTc(sliceIn, fps)} · Out ${framesToTc(sliceOut, fps)} · ${framesToTc(sliceOut - sliceIn, fps)}`
                  : 'No marks: the whole clip'}
              </span>
            </div>
            <div className="cue-buttons">
              {editIndex !== null && editing && (
                <button className="btn" onClick={() => addToTimeline(true)} disabled={editor.busy} title="Replace the timeline entry you opened with these marks">Update timeline entry</button>
              )}
              <button className="btn" onClick={() => addToTimeline(false)} disabled={editor.busy}
                title={onActiveSlot ? 'Append this clip (or the marked section) to the deck timeline' : `Timeline uses the active media; select ${clip.slotLabel} first`}>
                + Add {markIn !== null || markOut !== null ? 'section' : 'clip'} to timeline
              </button>
            </div>
            <div className="cue-buttons">
              <label className="check small"><input type="checkbox" checked={singleClip} onChange={(e) => setSingleClip(e.target.checked)} /> Play this clip only</label>
              <button className="btn primary" disabled={!!busy || device.state.status !== 'connected'} onClick={() => cue(false)} title="Enter">
                {busy === 'cue' ? 'Cueing…' : 'Cue on HyperDeck'}
              </button>
              <button className="btn go" disabled={!!busy || device.state.status !== 'connected'} onClick={() => cue(true)} title="Shift+Enter">
                {busy === 'play' ? 'Starting…' : 'Cue & Play'}
              </button>
            </div>
          </div>

          <div className="viewer-foot muted small">
            {info && (
              <span>
                {info.probe.width}×{info.probe.height} · {info.probe.codec}{info.probe.profile ? ` ${info.probe.profile}` : ''} · {Number(fps.toFixed(3))} fps ·{' '}
                {info.source.kind === 'ftp' ? 'via HyperDeck FTP' : `from share ${info.source.display}`}
              </span>
            )}
            {strip && !strip.done && <span> · filmstrip {readyCount}/{strip.count}</span>}
            {smoothKind === 'original' && <span> · plays the original file</span>}
            {live !== null && <span> · live preview (transcoding)</span>}
            <span className="spacer" />
            {proxy?.state === 'ready' && !canPlayProxy ? (
              <span>Proxy ready, but this browser can't play H.264</span>
            ) : proxy?.state === 'ready' ? (
              <label className="check"><input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} /> Smooth scrub (proxy)</label>
            ) : proxy?.state === 'running' || proxy?.state === 'queued' ? (
              <span className="proxy-progress">
                Making proxy {Math.round(proxy.progress * 100)}%
                <span className="meter"><span style={{ width: `${proxy.progress * 100}%` }} /></span>
                <button className="btn small ghost" onClick={() => api.cancelProxy(proxy.key).then(() => setProxy({ ...proxy, state: 'none', progress: 0 }))}>Cancel</button>
              </span>
            ) : (
              <button className="btn small" disabled={!info} title="Transcode a lightweight H.264 copy for smooth scrubbing and in-browser playback"
                onClick={() => api.startProxy(device.id, clip.slotId, clip.file).then(setProxy).catch((e) => notify(e.message))}>
                {proxy?.state === 'error' ? 'Retry proxy' : 'Make proxy'}
              </button>
            )}
            {api.downloadUrl(device.id, clip.slotId, clip.file) && (
              <a className="btn small ghost" href={api.downloadUrl(device.id, clip.slotId, clip.file)!} download>Download original</a>
            )}
          </div>
          {proxy?.state === 'error' && proxy.error && <p className="error small">Proxy failed: {proxy.error}</p>}
        </div>
      )}
    </Modal>
  );
}
