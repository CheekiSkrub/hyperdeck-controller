// Version stamp shared by the web (vite.config.ts) and server (server/build.mjs) builds:
// package version from the root package.json plus the git commit it was built from, so the
// panel can show exactly which code is running (and flag when web and server don't match).
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);

export function buildInfo() {
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
  let commit = 'unknown';
  let dirty = false;
  try {
    const cwd = new URL('.', root);
    commit = execSync('git rev-parse --short HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    dirty = execSync('git status --porcelain', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
  } catch { /* not a git checkout (e.g. a source tarball) */ }
  return { version: pkg.version, commit: dirty ? `${commit}+dirty` : commit, builtAt: new Date().toISOString() };
}
