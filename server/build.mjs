// Bundles the server into a single CommonJS file (dist/server.cjs) suitable for
// running with plain `node` or injecting into a Node single executable (SEA).
import { build } from 'esbuild';
import { buildInfo } from '../scripts/buildinfo.mjs';

const info = buildInfo();

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/server.cjs',
  define: {
    __APP_VERSION__: JSON.stringify(info.version),
    __APP_COMMIT__: JSON.stringify(info.commit),
    __APP_BUILT__: JSON.stringify(info.builtAt),
  },
  // dtrace-provider: an optional, dynamically-`require()`d bunyan dependency (from ftp-srv,
  // used by the simulated test-deck FTP server) that esbuild can't statically resolve — bunyan
  // already wraps the require in try/catch and works fine without it, so leave it external
  // rather than fighting to bundle a native DTrace binding nothing here uses.
  external: ['bufferutil', 'utf-8-validate', 'dtrace-provider'],
  logLevel: 'info',
});
