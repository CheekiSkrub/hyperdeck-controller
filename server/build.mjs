// Bundles the server into a single CommonJS file (dist/server.cjs) suitable for
// running with plain `node` or injecting into a Node single executable (SEA).
import { build } from 'esbuild';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/server.cjs',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // dtrace-provider: an optional, dynamically-`require()`d bunyan dependency (from ftp-srv,
  // used by the simulated test-deck FTP server) that esbuild can't statically resolve — bunyan
  // already wraps the require in try/catch and works fine without it, so leave it external
  // rather than fighting to bundle a native DTrace binding nothing here uses.
  external: ['bufferutil', 'utf-8-validate', 'dtrace-provider'],
  logLevel: 'info',
});
