import type { HyperDeckClient, HyperDeckState } from '../hyperdeck/client.js';
import { fpsFromVideoFormat, framesToTimecode, timecodeToFrames } from '../hyperdeck/protocol.js';

/**
 * The deck's timeline as an edit list: an ordered set of clip portions.
 *
 * The HyperDeck can append a whole clip (`clips add: name:`), append a portion
 * by source timecode (`clips add: in: out: name:`), insert a whole
 * clip before another (`clips add: clip id:`), remove one, or clear. There is
 * no "insert portion at position", so edits are applied by clearing the
 * timeline and re-adding every entry in order; that's a handful of commands
 * and keeps the deck and panel in exact agreement.
 *
 * Frame numbers are 0-based within the file; `out` is exclusive.
 *
 * Checked on a Shuttle HD (8.4.1): the `frame in:/frame out:` form is unusable there (frame in
 * is ignored, frame out is read at some other rate, and it answers "109 out of range" for many
 * clips), while `in:/out:` timecodes work. A timeline also can't mix video formats (a 1080p50
 * clip after a 1080p60 one gets "103 unsupported" / "109 out of range"), and on long-GOP H.264
 * the deck widens each portion out to whole keyframes (1 s here) — the panel re-reads the
 * timeline afterwards, so it shows what the deck actually did.
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
  const deckFps = fpsFromVideoFormat(s.transport?.videoFormat) ?? 25;
  const formats = new Map<string, string>(); // video format -> first file in it
  const out = entries.map((e, i) => {
    const file = String((e as EditEntry)?.file ?? '');
    const onDisk = disk.find((d) => d.name === file);
    if (!onDisk) throw new EditError(`"${file}" isn't on the active media. The deck's timeline can only use clips from the selected slot.`);
    if (onDisk.videoFormat && !formats.has(onDisk.videoFormat)) formats.set(onDisk.videoFormat, file);
    // A clip's duration timecode counts in its own frame rate, not necessarily the deck's current one.
    const frames = timecodeToFrames(onDisk.duration, fpsFromVideoFormat(onDisk.videoFormat) ?? deckFps);
    const inF = Math.max(0, Math.floor(Number((e as EditEntry).in) || 0));
    const outF = Math.min(frames, Math.floor(Number((e as EditEntry).out) || frames));
    if (outF - inF < 1) throw new EditError(`Entry ${i + 1} (${file}) is empty`);
    return { file, in: inF, out: outF, frames };
  });
  if (formats.size > 1) {
    const list = [...formats].map(([fmt, f]) => `${fmt} (e.g. ${f})`).join(', ');
    throw new EditError(`A HyperDeck timeline can only hold one video format, but these clips are ${list}. Use clips of one format.`);
  }
  return out;
}

/** Rebuild the deck's timeline to match `entries`. */
export async function applyEdit(c: HyperDeckClient, entries: EditEntry[]): Promise<void> {
  const t = c.state.transport;
  if (t?.status === 'record') throw new EditError("Can't change the timeline while recording");
  const wasPlaying = t && ['play', 'forward', 'rewind', 'shuttle', 'jog'].includes(t.status);
  if (wasPlaying) await c.send('stop');
  // Snapshot before clearing: clearing triggers a timeline refresh that would empty these.
  const slotDisk = c.state.disks[t?.slotId ?? -1] ?? [];
  const starts = new Map(c.state.timeline.map((x) => [x.name.split('/').pop() ?? x.name, x.startTimecode]));
  await c.send('clips clear');
  for (const e of entries) {
    if (e.in === 0 && e.out >= e.frames) {
      await c.send('clips add', { name: e.file });
    } else {
      // Source timecodes: the clip's start timecode (as the deck reports it, when it's on the
      // timeline already; files without embedded timecode start at 00:00:00:00) plus the offset.
      const fmt = slotDisk.find((d) => d.name === e.file)?.videoFormat;
      const fps = fpsFromVideoFormat(fmt ?? t?.videoFormat) ?? 25;
      const known = starts.get(e.file);
      const start = known ? timecodeToFrames(known, fps) : 0;
      const out = DECK_FRAME_OUT_INCLUSIVE ? e.out - 1 : e.out;
      await c.send('clips add', { in: framesToTimecode(start + e.in, fps), out: framesToTimecode(start + out, fps), name: e.file });
    }
  }
  lastApplied.set(c, entries);
  // The deck applies these a moment after acknowledging them — wait until it shows our clips.
  const base = (n: string) => (n.split('/').pop() ?? n).toLowerCase();
  const ok = await c.waitForTimeline((tl) => tl.length === entries.length && tl.every((x, i) => base(x.name) === entries[i].file.toLowerCase()));
  if (!ok) throw new EditError("The HyperDeck didn't show the new timeline in time — press Refresh to see what it has.");
}
