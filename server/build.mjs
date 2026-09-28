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
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'info',
});
