import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EditEntry } from './edit.js';
import { ValidationError } from './store.js';

/**
 * A named, saved edit list for a device — lets an operator build more than
 * one timeline (a rundown, a highlights reel, a rehearsal cut…) and switch
 * the deck between them, instead of only ever having "whatever's on the
 * deck right now". Loading one applies it to the deck the same way any
 * other edit is applied (PUT /api/devices/:id/edit).
 *
 * At most one timeline per device is `live`: the one on the deck. Edits to it go to the deck
 * (and are saved back here); the others are staged — edited and saved without touching the deck,
 * ready to be sent to it.
 */
export interface SavedTimeline {
  id: string;
  deviceId: string;
  name: string;
  entries: EditEntry[];
  /** This is the timeline currently on the deck. */
  live?: boolean;
  createdAt: string;
  updatedAt: string;
}

export class TimelineStore {
  private timelines: SavedTimeline[] = [];
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'timelines.json');
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      this.timelines = JSON.parse(fs.readFileSync(this.file, 'utf8')) as SavedTimeline[];
    } catch {
      this.timelines = [];
    }
  }

  list(deviceId: string): SavedTimeline[] {
    // Creation order, so tabs stay put (Timeline 1, Timeline 2, …) when one is renamed.
    return this.timelines.filter((t) => t.deviceId === deviceId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): SavedTimeline | undefined {
    return this.timelines.find((t) => t.id === id);
  }

  create(deviceId: string, name: string, entries: EditEntry[], live = false): SavedTimeline {
    const n = name.trim();
    if (!n) throw new ValidationError('Name is required');
    const now = new Date().toISOString();
    if (live) for (const o of this.timelines) if (o.deviceId === deviceId) o.live = false;
    const t: SavedTimeline = { id: crypto.randomUUID(), deviceId, name: n, entries, live: live || undefined, createdAt: now, updatedAt: now };
    this.timelines.push(t);
    this.save();
    return t;
  }

  update(id: string, patch: { name?: string; entries?: EditEntry[] }): SavedTimeline {
    const t = this.get(id);
    if (!t) throw new ValidationError('Saved timeline not found');
    if (patch.name !== undefined) {
      const n = patch.name.trim();
      if (!n) throw new ValidationError('Name is required');
      t.name = n;
    }
    if (patch.entries !== undefined) t.entries = patch.entries;
    t.updatedAt = new Date().toISOString();
    this.save();
    return t;
  }

  live(deviceId: string): SavedTimeline | undefined {
    return this.timelines.find((t) => t.deviceId === deviceId && t.live);
  }

  /** Mark `id` as the timeline on its deck (and no other). */
  setLive(id: string): SavedTimeline {
    const t = this.get(id);
    if (!t) throw new ValidationError('Saved timeline not found');
    for (const o of this.timelines) if (o.deviceId === t.deviceId) o.live = o.id === id || undefined;
    this.save();
    return t;
  }

  remove(id: string): boolean {
    const before = this.timelines.length;
    this.timelines = this.timelines.filter((t) => t.id !== id);
    if (this.timelines.length !== before) this.save();
    return this.timelines.length !== before;
  }

  /** Called when a device is removed, so its saved timelines don't linger. */
  removeForDevice(deviceId: string): void {
    const before = this.timelines.length;
    this.timelines = this.timelines.filter((t) => t.deviceId !== deviceId);
    if (this.timelines.length !== before) this.save();
  }

  private save(): void {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.timelines, null, 2));
    fs.renameSync(this.file + '.tmp', this.file);
  }
}
