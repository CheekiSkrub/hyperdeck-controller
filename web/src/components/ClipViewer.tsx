import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useMediaEvents } from '../lib/store';
import { framesToTc, tcToFrames } from '../lib/tc';
import type { ClipListing, Device, MediaInfo, ProxyStatus, StripStatus } from '../lib/types';
import { Modal } from './Modal';

/**
 * Scrub a clip in the browser and cue the HyperDeck to the chosen frame.
 *
 * While dragging, the nearest filmstrip tile is shown instantly; the exact
 * frame is fetched (debounced) and swapped in. If an H.264 proxy exists the
 * preview switches to a <video> element for smooth scrubbing and playback.
 */
export function ClipViewer({ device, clip, onClose, notify }: {
  device: Device;
  clip: ClipListing;
  onClose: () => void;
  notify: (m: string, kind?: 'ok' | 'err') => void;
}) {
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [strip, setStrip] = useState<StripStatus | null>(null);
  const [tileVersion, setTileVersion] = useState(0);
  const [frame, setFrame] = useState(0);
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
  // Proxies are H.264; every mainstream browser decodes it, but some Linux Chromium builds don't.
  const canPlayProxy = useMemo(() => Boolean(document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"')), []);
  const proxyReady = proxy?.state === 'ready' && useProxy && canPlayProxy;

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
    if (!info || proxyReady) return;
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
  }, [frame, info, proxyReady, exactHeight]);

  // ------------------------------------------------------------------ video mode sync
  useEffect(() => {
    const v = video.current;
    if (!v || !proxyReady || videoPlaying) return;
    const target = (frame + 0.1) / fps;
    if (Math.abs(v.currentTime - target) > 0.5 / fps) v.currentTime = target;
  }, [frame, proxyReady, videoPlaying, fps]);

  useEffect(() => {
    const v = video.current;
    if (!v || !videoPlaying) return;
    let raf = 0;
    const tick = () => {
      setFrame(Math.min(frames - 1, Math.floor(v.currentTime * fps)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoPlaying, fps, frames]);

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
    setFrame(frameFromX(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging.current) setFrame(frameFromX(e.clientX));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    setFrame(frameFromX(e.clientX));
  };

  const step = useCallback((n: number) => {
    video.current?.pause();
    setFrame((f) => Math.min(frames - 1, Math.max(0, f + n)));
  }, [frames]);

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
      else if (e.key === 'Home') { e.preventDefault(); setFrame(0); }
      else if (e.key === 'End') { e.preventDefault(); setFrame(frames - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); void cue(e.shiftKey); }
      else if (e.code === 'Space' && proxyReady) { e.preventDefault(); togglePlay(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const togglePlay = () => {
    const v = video.current;
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
            {proxyReady ? (
              <video
                ref={video}
                src={api.proxyUrl(proxy!.key)}
                preload="auto"
                playsInline
                onPlay={() => setVideoPlaying(true)}
                onPause={() => setVideoPlaying(false)}
                onLoadedMetadata={(e) => { e.currentTarget.currentTime = (frame + 0.1) / fps; }}
                onError={() => { setUseProxy(false); notify('This browser could not play the proxy — using frame-accurate stills instead'); }}
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
            <div className="scrub-head" style={{ left: `${(frame / Math.max(1, frames - 1)) * 100}%` }} />
          </div>

          <div className="viewer-controls">
            <div className="readout">
              <div><span className="muted small">Source TC</span> <span className="mono">{sourceTc}</span></div>
              <div><span className="muted small">Clip</span> <span className="mono">{framesToTc(frame, fps)}</span></div>
              <div><span className="muted small">Frame</span> <span className="mono">{frame} / {frames - 1}</span></div>
            </div>
            <div className="step-buttons">
              <button className="btn small" onClick={() => setFrame(0)} title="First frame (Home)">|◂</button>
              <button className="btn small" onClick={() => step(-Math.round(fps))} title="Back 1 second (Shift+←)">−1s</button>
              <button className="btn small" onClick={() => step(-1)} title="Back 1 frame (←)">−1f</button>
              {proxyReady && <button className="btn small" onClick={togglePlay} title="Play proxy (Space)">{videoPlaying ? '❚❚' : '▶'}</button>}
              <button className="btn small" onClick={() => step(1)} title="Forward 1 frame (→)">+1f</button>
              <button className="btn small" onClick={() => step(Math.round(fps))} title="Forward 1 second (Shift+→)">+1s</button>
              <button className="btn small" onClick={() => setFrame(frames - 1)} title="Last frame (End)">▸|</button>
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
