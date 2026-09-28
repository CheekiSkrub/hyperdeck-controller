#!/usr/bin/env node
/**
 * Package HyperDeck Controller as a Node single executable application (SEA)
 * for the current platform, with ffmpeg/ffprobe alongside.
 *
 *   npm run package
 *
 * Output: release/hyperdeck-controller-<version>-<platform>-<arch>/
 *
 * Code signing happens afterwards (see .github/workflows/release.yml and
 * docs/SIGNING.md) because it needs platform credentials.
 *
 * Env:
 *   FFMPEG_DIR   folder containing ffmpeg + ffprobe to bundle (otherwise the
 *                ffmpeg-static / ffprobe-static npm packages are used)
 *   SKIP_FFMPEG  set to 1 to produce a build without bundled ffmpeg
 *   TARGET_NODE / TARGET_PLATFORM / TARGET_ARCH
 *                cross-build using another platform's node binary (it must be
 *                the same Node version as the one running this script)
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const host = process.platform;
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const arch = process.env.TARGET_ARCH ?? process.arch;
const nodeBinary = process.env.TARGET_NODE ?? process.execPath;
const exe = platform === 'win32' ? '.exe' : '';
const name = `hyperdeck-controller-${pkg.version}-${platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux'}-${arch}`;
const outDir = path.join(root, 'release', name);
const work = path.join(root, 'release', '.work');

const run = (cmd, opts = {}) => {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: root, ...opts });
};

/**
 * Sniff an executable's file format from its header and say which platform
 * it's actually for, so a binary fetched/cached for the wrong platform (e.g.
 * a Linux ffmpeg-static download left over from packaging for another target
 * on this machine) is caught here instead of shipped and failing silently at
 * runtime on the user's machine. Returns null when it matches `wantPlatform`
 * (or the format is unrecognised — old/exotic formats aren't second-guessed).
 */
function binaryPlatformMismatch(file, wantPlatform) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8);
  fs.readSync(fd, buf, 0, 8, 0);
  fs.closeSync(fd);
  let actual = null;
  if (buf[0] === 0x4d && buf[1] === 0x5a) actual = 'win32'; // MZ
  else if (buf[0] === 0x7f && buf.toString('ascii', 1, 4) === 'ELF') actual = 'linux';
  else if (buf.readUInt32BE(0) === 0xfeedface || buf.readUInt32BE(0) === 0xfeedfacf
    || buf.readUInt32LE(0) === 0xfeedface || buf.readUInt32LE(0) === 0xfeedfacf
    || buf.readUInt32BE(0) === 0xcafebabe || buf.readUInt32BE(0) === 0xbebafeca) actual = 'darwin';
  if (!actual || actual === wantPlatform) return null;
  return actual;
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(work, { recursive: true });

// 1. Build web panel + bundle server
run('npm run build --workspace web');
run('npm run build --workspace server');

// 2. Embed the web panel as a single SEA asset (path -> base64)
const webDist = path.join(root, 'web', 'dist');
const assets = {};
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else assets[path.relative(webDist, full).split(path.sep).join('/')] = fs.readFileSync(full).toString('base64');
  }
};
walk(webDist);
fs.writeFileSync(path.join(work, 'web.json'), JSON.stringify(assets));

// 3. Generate the SEA blob
const seaConfig = {
  main: path.join(root, 'server', 'dist', 'server.cjs'),
  output: path.join(work, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false, // code cache is platform specific and trips on some macOS setups
  assets: { 'web.json': path.join(work, 'web.json') },
};
fs.writeFileSync(path.join(work, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
run(`"${process.execPath}" --experimental-sea-config "${path.join(work, 'sea-config.json')}"`);

// 4. Copy the node binary and inject the blob
const target = path.join(outDir, `hyperdeck-controller${exe}`);
fs.copyFileSync(nodeBinary, target);
fs.chmodSync(target, 0o755);
if (platform === 'darwin' && host === 'darwin') execFileSync('codesign', ['--remove-signature', target], { stdio: 'inherit' });
if (platform === 'win32' && host === 'win32') {
  // Strip the official Node signature so the injected binary can be re-signed cleanly.
  try { execFileSync('signtool', ['remove', '/s', target], { stdio: 'inherit' }); } catch { /* signtool optional here */ }
}
const postject = path.join(root, 'node_modules', '.bin', `postject${host === 'win32' ? '.cmd' : ''}`);
const postjectArgs = [target, 'NODE_SEA_BLOB', seaConfig.output, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
execFileSync(postject, postjectArgs, { stdio: 'inherit', shell: host === 'win32' });
// Ad-hoc sign on macOS so it runs locally; CI replaces this with a Developer ID signature.
if (platform === 'darwin' && host === 'darwin') execFileSync('codesign', ['--sign', '-', target], { stdio: 'inherit' });

// 5. Bundle ffmpeg + ffprobe
if (!process.env.SKIP_FFMPEG) {
  let ffmpeg, ffprobe;
  if (process.env.FFMPEG_DIR) {
    ffmpeg = path.join(process.env.FFMPEG_DIR, `ffmpeg${exe}`);
    ffprobe = path.join(process.env.FFMPEG_DIR, `ffprobe${exe}`);
  } else {
    // ffprobe-static ships every platform's binary inside the npm package itself
    // (no download), so pick TARGET_PLATFORM/TARGET_ARCH's copy directly instead
    // of going through its own index.js, which only picks the *host's* binary.
    const ffprobeStaticDir = path.dirname(require.resolve('ffprobe-static/package.json'));
    ffprobe = path.join(ffprobeStaticDir, 'bin', platform, arch, `ffprobe${exe}`);
    // ffmpeg-static downloads a single binary at `npm install` time, for whatever
    // platform/arch it was told to fetch (npm_config_platform/npm_config_arch, or
    // the host's by default) — verified below against what we're actually
    // packaging for, so a mismatch fails the build instead of shipping quietly
    // broken.
    ffmpeg = require('ffmpeg-static');
  }
  for (const [src, dst] of [[ffmpeg, `ffmpeg${exe}`], [ffprobe, `ffprobe${exe}`]]) {
    if (!src || !fs.existsSync(src)) throw new Error(`Missing ${dst} (looked at ${src}). Set FFMPEG_DIR or SKIP_FFMPEG=1.`);
    const mismatch = binaryPlatformMismatch(src, platform);
    if (mismatch) {
      throw new Error(
        `${dst} at ${src} is a ${mismatch} binary, not ${platform} — refusing to bundle a broken ffmpeg into a ` +
        `${platform}/${arch} release.\n` +
        (process.env.FFMPEG_DIR
          ? `Point FFMPEG_DIR at binaries built for ${platform}/${arch}.`
          : `Reinstall ffmpeg-static for this target before packaging, e.g.:\n` +
            `  npm_config_platform=${platform} npm_config_arch=${arch} npm rebuild ffmpeg-static\n` +
            `or set FFMPEG_DIR to a folder with the right ffmpeg${exe}/ffprobe${exe}, or SKIP_FFMPEG=1.`),
      );
    }
    fs.copyFileSync(src, path.join(outDir, dst));
    fs.chmodSync(path.join(outDir, dst), 0o755);
  }
}

// 6. Docs
fs.copyFileSync(path.join(root, 'docs', 'RUNNING.txt'), path.join(outDir, 'README.txt'));
fs.copyFileSync(path.join(root, 'docs', 'THIRD_PARTY_NOTICES.txt'), path.join(outDir, 'THIRD_PARTY_NOTICES.txt'));

console.log(`\nPackaged ${outDir}`);
