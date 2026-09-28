import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

declare const __APP_VERSION__: string | undefined;
declare const __APP_COMMIT__: string | undefined;
declare const __APP_BUILT__: string | undefined;

export interface BuildInfo {
  version: string;
  /** Short git hash the running code came from; "+dirty" if it had uncommitted changes. */
  commit: string;
  /** When the bundle was built — or, in dev, when this server process started. */
  builtAt: string;
}

/**
 * Packaged builds get these baked in by server/build.mjs. In dev (tsx watch) nothing is
 * baked in, so read the root package.json and ask git directly — each tsx restart re-reads
 * them, so the panel always reflects the code actually running.
 */
export function buildInfo(): BuildInfo {
  if (typeof __APP_VERSION__ !== 'undefined') {
    return {
      version: __APP_VERSION__,
      commit: typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : 'unknown',
      builtAt: typeof __APP_BUILT__ !== 'undefined' ? __APP_BUILT__ : '',
    };
  }
  let dir = process.cwd();
  let version = '0.0.0-dev';
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === 'hyperdeck-controller') { version = pkg.version; break; }
    } catch { /* keep walking up */ }
    dir = path.dirname(dir);
  }
  let commit = 'unknown';
  try {
    const opts = { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
    commit = execSync('git rev-parse --short HEAD', opts).toString().trim();
    if (execSync('git status --porcelain', opts).toString().trim()) commit += '+dirty';
  } catch { /* no git available */ }
  return { version: `${version}-dev`, commit, builtAt: new Date().toISOString() };
}
