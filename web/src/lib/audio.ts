import { useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * Per-channel audio levels for a clip, generated once by the server (see
 * server/src/media/ffmpeg.ts audioLevels): `rate` windows a second, each
 * channel stored as [peak, rms] bytes in 0.25 dB steps from -60 dBFS.
 */
export interface AudioLevels {
  key: string;
  channels: number;
  rate: number;
  count: number;
  data: Uint8Array;
}

/** Byte -> dBFS (0 means silence / below -60). */
export const levelDb = (q: number) => (q ? q / 4 - 60 : -Infinity);

/** Levels at a position in the clip, per channel (null outside the clip). */
export function levelsAt(l: AudioLevels, seconds: number): { peak: number; rms: number }[] | null {
  const w = Math.floor(seconds * l.rate);
  if (w < 0 || w >= l.count) return null;
  const out: { peak: number; rms: number }[] = [];
  for (let c = 0; c < l.channels; c++) {
    const i = (w * l.channels + c) * 2;
    out.push({ peak: l.data[i], rms: l.data[i + 1] });
  }
  return out;
}

// Levels never change for a key (it's tied to the file's size/mtime), so keep them for the session.
const byKey = new Map<string, Promise<AudioLevels>>();

function fetchLevels(st: { key: string; channels?: number; rate?: number; count?: number }): Promise<AudioLevels> {
  let p = byKey.get(st.key);
  if (!p) {
    p = fetch(api.audioLevelsUrl(st.key))
      .then((r) => { if (!r.ok) throw new Error(`levels ${r.status}`); return r.arrayBuffer(); })
      .then((b) => ({ key: st.key, channels: st.channels ?? 2, rate: st.rate ?? 20, count: st.count ?? 0, data: new Uint8Array(b) }));
    p.catch(() => byKey.delete(st.key));
    byKey.set(st.key, p);
  }
  return p;
}

/**
 * Levels for every file on a slot, keyed by file name: null while the server is still
 * analysing it, false if it has no audio (or the analysis failed). Starts the analysis as
 * needed and checks back every couple of seconds until it's done.
 */
export function useAudioLevels(deviceId: string, slotId: number | null | undefined, files: string[]) {
  const [levels, setLevels] = useState<Record<string, AudioLevels | null | false>>({});
  const scope = `${deviceId}|${slotId ?? ''}`;
  // Which files have been asked for in the current scope. A ref, not state, so re-renders
  // (the timeline re-renders every frame) never re-request, and a check in flight when the
  // file list changes still lands. Results for a stale scope are dropped.
  const started = useRef({ scope, files: new Set<string>() });
  const live = useRef({ scope, mounted: true });
  live.current.scope = scope;
  useEffect(() => {
    live.current.mounted = true; // (again) after React's dev-mode unmount/remount
    return () => { live.current.mounted = false; };
  }, []);
  if (started.current.scope !== scope) {
    started.current = { scope, files: new Set() };
    if (Object.keys(levels).length) setLevels({}); // file names are only unique per slot
  }
  const list = [...new Set(files)].join('\n');

  useEffect(() => {
    if (!slotId) return;
    const mine = scope;
    const ok = () => live.current.mounted && live.current.scope === mine;
    const set = (file: string, v: AudioLevels | null | false) => { if (ok()) setLevels((l) => ({ ...l, [file]: v })); };
    const check = (file: string) => {
      api.audio(deviceId, slotId, file).then((st) => {
        if (!ok()) return;
        if (st.state === 'running') window.setTimeout(() => ok() && check(file), 2000);
        else if (st.state === 'ready') fetchLevels(st).then((lv) => set(file, lv)).catch(() => set(file, false));
        else set(file, false);
      }).catch(() => set(file, false));
    };
    for (const file of list ? list.split('\n') : []) {
      if (started.current.files.has(file)) continue;
      started.current.files.add(file);
      set(file, null);
      check(file);
    }
  }, [scope, list, deviceId, slotId]);

  return levels;
}
