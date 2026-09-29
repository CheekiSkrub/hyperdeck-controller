import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from './store.js';

/** A named collection of clips, for sorting content (a rundown's segments, a guest, a camera…). */
export interface ClipGroup {
  id: string;
  name: string;
  /** Clip file names, in the order they were added. */
  files: string[];
}

/** Per-device organisation of the deck's clips: free-text tags on each file, and groups. */
export interface ClipLibrary {
  tags: Record<string, string[]>;
  groups: ClipGroup[];
}

const empty = (): ClipLibrary => ({ tags: {}, groups: [] });
const cleanTag = (t: string) => t.trim().replace(/\s+/g, ' ').slice(0, 40);

export class LibraryStore {
  private data: Record<string, ClipLibrary> = {};
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'library.json');
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, ClipLibrary>;
    } catch {
      this.data = {};
    }
  }

  get(deviceId: string): ClipLibrary {
    return this.data[deviceId] ?? empty();
  }

  setTags(deviceId: string, file: string, tags: string[]): ClipLibrary {
    if (!file) throw new ValidationError('file is required');
    const lib = this.mine(deviceId);
    const clean = [...new Set(tags.map(cleanTag).filter(Boolean))];
    if (clean.length) lib.tags[file] = clean;
    else delete lib.tags[file];
    this.save();
    return lib;
  }

  createGroup(deviceId: string, name: string, files: string[] = []): ClipLibrary {
    const n = name.trim();
    if (!n) throw new ValidationError('Group name is required');
    const lib = this.mine(deviceId);
    lib.groups.push({ id: crypto.randomUUID(), name: n, files: [...new Set(files)] });
    this.save();
    return lib;
  }

  updateGroup(deviceId: string, groupId: string, patch: { name?: string; add?: string[]; remove?: string[] }): ClipLibrary {
    const lib = this.mine(deviceId);
    const g = lib.groups.find((x) => x.id === groupId);
    if (!g) throw new ValidationError('Group not found');
    if (patch.name !== undefined) {
      const n = patch.name.trim();
      if (!n) throw new ValidationError('Group name is required');
      g.name = n;
    }
    if (patch.add) for (const f of patch.add) if (!g.files.includes(f)) g.files.push(f);
    if (patch.remove) g.files = g.files.filter((f) => !patch.remove!.includes(f));
    this.save();
    return lib;
  }

  removeGroup(deviceId: string, groupId: string): ClipLibrary {
    const lib = this.mine(deviceId);
    lib.groups = lib.groups.filter((g) => g.id !== groupId);
    this.save();
    return lib;
  }

  removeForDevice(deviceId: string): void {
    if (!(deviceId in this.data)) return;
    delete this.data[deviceId];
    this.save();
  }

  private mine(deviceId: string): ClipLibrary {
    return (this.data[deviceId] ??= empty());
  }

  private save(): void {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2));
    fs.renameSync(this.file + '.tmp', this.file);
  }
}
