import type { HyperDeckClient, HyperDeckState } from '../hyperdeck/client.js';
import { fpsFromVideoFormat, timecodeToFrames } from '../hyperdeck/protocol.js';

/**
 * The deck's timeline as an edit list: an ordered set of clip portions.
 *
 * The HyperDeck can append a whole clip (`clips add: name:`), append a portion
 * by frame numbers (`clips add: frame in: frame out: name:`), insert a whole
 * clip before another (`clips add: clip id:`), remove one, or clear. There is
 * no "insert portion at position", so edits are applied by clearing the
 * timeline and re-adding every entry in order; that's a handful of commands
 * and keeps the deck and panel in exact agreement.
 *
 * Frame numbers are 0-based within the file; `out` is exclusive.
 */
export interface EditEntry {
  file: string;
  in: number;
  out: number;
  /** Total frames in the file (for knowing whether this is a whole clip). */
  frames: number;
}

/**
 * Whether the deck's "frame out" is inclusive. Blackmagic's docs don't say;
 * flip this after checking on hardware if slices come out one frame long/short.
 */
export const DECK_FRAME_OUT_INCLUSIVE = false;

export class EditError extends Error {}

export interface DerivedEntry extends EditEntry {
  /** True when the deck's response didn't let us pin down the exact in point. */
  approx?: boolean;
}

/** What we last wrote to each deck; trusted while the deck still matches it. */
const lastApplied = new WeakMap<object, EditEntry[]>();

/**
 * Derive the edit list from "clips get" (v2/v3). Blackmagic documents the
 * fields as "clipInT clipDuration inT outT" without defining them, so this
 * copes with both readings: in/out as source timecodes within the clip, or
 * as timeline positions. In either reading outT − inT is the portion length.
 */
export function editFromState(s: HyperDeckState, owner?: object): DerivedEntry[] {
  const fps = fpsFromVideoFormat(s.transport?.videoFormat) ?? 25;
  const disk = s.transport?.slotId ? s.disks[s.transport.slotId] ?? [] : [];
  const f = (tc: string) => timecodeToFrames(tc, fps);
  const rows = s.timeline.map((c) => {
    const file = c.name.split('/').pop() ?? c.name;
    const onDisk = disk.find((d) => d.name.toLowerCase() === file.toLowerCase());
    const full = onDisk ? f(onDisk.duration) : f(c.duration);
    const length = c.inTimecode && c.outTimecode ? f(c.outTimecode) - f(c.inTimecode) + (DECK_FRAME_OUT_INCLUSIVE ? 1 : 0) : f(c.duration);
    return { c, file, full, length };
  });

  const known = owner ? lastApplied.get(owner) : undefined;
  if (known && known.length === rows.length && known.every((k, i) => k.file.toLowerCase() === rows[i].file.toLowerCase() && Math.abs(k.out - k.in - rows[i].length) <= 1)) {
    return known;
  }

  return rows.map(({ c, file, full, length }) => {
    if (c.inTimecode && c.outTimecode) {
      const base = f(c.startTimecode);
      const inF = f(c.inTimecode) - base;
      const outF = inF + length;
      // Reading A: in/out are timecodes inside the clip.
      if (f(c.duration) === full && inF >= 0 && outF <= full && length > 0) return { file, in: inF, out: outF, frames: full };
    }
    if (length >= full || length <= 0) return { file, in: 0, out: full, frames: full };
    // Reading B (or unknown): we know the length but not where in the clip it starts.
    return { file, in: 0, out: length, frames: full, approx: true };
  });
}

export function validateEdit(entries: unknown, s: HyperDeckState): EditEntry[] {
  if (!Array.isArray(entries)) throw new EditError('entries must be an array');
  if (entries.length > 500) throw new EditError('Timeline is limited to 500 entries');
  const slotId = s.transport?.slotId;
  const disk = slotId ? s.disks[slotId] ?? [] : [];
  const fps = fpsFromVideoFormat(s.transport?.videoFormat) ?? 25;
  return entries.map((e, i) => {
    const file = String((e as EditEntry)?.file ?? '');
    const onDisk = disk.find((d) => d.name === file);
    if (!onDisk) throw new EditError(`"${file}" isn't on the active media. The deck's timeline can only use clips from the selected slot.`);
    const frames = timecodeToFrames(onDisk.duration, fps);
    const inF = Math.max(0, Math.floor(Number((e as EditEntry).in) || 0));
    const outF = Math.min(frames, Math.floor(Number((e as EditEntry).out) || frames));
    if (outF - inF < 1) throw new EditError(`Entry ${i + 1} (${file}) is empty`);
    return { file, in: inF, out: outF, frames };
  });
}

/** Rebuild the deck's timeline to match `entries`. */
export async function applyEdit(c: HyperDeckClient, entries: EditEntry[]): Promise<void> {
  const t = c.state.transport;
  if (t?.status === 'record') throw new EditError("Can't change the timeline while recording");
  const wasPlaying = t && ['play', 'forward', 'rewind', 'shuttle', 'jog'].includes(t.status);
  if (wasPlaying) await c.send('stop');
  await c.send('clips clear');
  for (const e of entries) {
    if (e.in === 0 && e.out >= e.frames) {
      await c.send('clips add', { name: e.file });
    } else {
      const out = DECK_FRAME_OUT_INCLUSIVE ? e.out - 1 : e.out;
      await c.send('clips add', { 'frame in': e.in, 'frame out': out, name: e.file });
    }
  }
  lastApplied.set(c, entries);
  await c.refreshTimeline();
}
