import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A saved NAS/SMB login, reusable across multiple HyperDecks' share mappings
 * and NAS bookmarks instead of retyping the same username/password for each
 * one. Picking a saved credential from a device's form copies its username
 * and password in at that moment — it's a fill-in convenience, not a live
 * link, so editing or deleting a saved credential later doesn't change
 * devices that already used it.
 */
export interface NasCredential {
  id: string;
  label: string;
  username: string;
  password: string;
  createdAt: string;
  updatedAt: string;
}

export class ValidationError extends Error {}

export class CredentialStore {
  private items: NasCredential[] = [];
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'credentials.json');
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')) as NasCredential[];
    } catch {
      this.items = [];
    }
  }

  list(): NasCredential[] {
    return [...this.items].sort((a, b) => a.label.localeCompare(b.label));
  }

  get(id: string): NasCredential | undefined {
    return this.items.find((c) => c.id === id);
  }

  create(input: { label?: string; username?: string; password?: string }): NasCredential {
    const label = input.label?.trim();
    if (!label) throw new ValidationError('Name is required');
    if (!input.username?.trim()) throw new ValidationError('Username is required');
    const now = new Date().toISOString();
    const c: NasCredential = {
      id: crypto.randomUUID(),
      label,
      username: input.username.trim(),
      password: input.password ?? '',
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(c);
    this.save();
    return c;
  }

  update(id: string, patch: { label?: string; username?: string; password?: string }): NasCredential {
    const c = this.get(id);
    if (!c) throw new ValidationError('Saved credential not found');
    if (patch.label !== undefined) {
      const label = patch.label.trim();
      if (!label) throw new ValidationError('Name is required');
      c.label = label;
    }
    if (patch.username !== undefined) {
      if (!patch.username.trim()) throw new ValidationError('Username is required');
      c.username = patch.username.trim();
    }
    if (patch.password !== undefined) c.password = patch.password;
    c.updatedAt = new Date().toISOString();
    this.save();
    return c;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((c) => c.id !== id);
    if (this.items.length !== before) this.save();
    return this.items.length !== before;
  }

  private save(): void {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.items, null, 2));
    fs.renameSync(this.file + '.tmp', this.file);
  }
}
