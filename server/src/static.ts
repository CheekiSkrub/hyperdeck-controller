import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/**
 * Serves the built web panel. In a packaged single-executable build the files
 * are embedded as a SEA asset ("web.json": path -> base64); in development they
 * are read from web/dist.
 */
export function registerStatic(app: FastifyInstance) {
  const files = loadEmbedded() ?? loadFromDisk();
  if (!files) {
    app.get('/', async (_req, reply) => reply.type('text/html').send(
      '<h1>HyperDeck Controller</h1><p>Web panel not built. Run <code>npm run build --workspace web</code> or use the Vite dev server on :5173.</p>',
    ));
    return;
  }
  app.get('/*', async (req, reply) => {
    let p = decodeURIComponent((req.params as { '*': string })['*'] || 'index.html');
    if (p.startsWith('api/')) return reply.status(404).send({ error: 'Not found' });
    if (!files.has(p)) p = 'index.html'; // SPA fallback
    const body = files.get(p)!;
    reply.header('Content-Type', TYPES[path.extname(p)] ?? 'application/octet-stream');
    if (p.startsWith('assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(body);
  });
}

function loadEmbedded(): Map<string, Buffer> | null {
  try {
    const req = createRequire(__filenameCompat());
    const sea = req('node:sea');
    if (!sea.isSea()) return null;
    const json = JSON.parse(sea.getAsset('web.json', 'utf8')) as Record<string, string>;
    return new Map(Object.entries(json).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  } catch {
    return null;
  }
}

function loadFromDisk(): Map<string, Buffer> | null {
  const candidates = [
    process.env.HDC_WEB_DIR,
    path.resolve(process.cwd(), 'web/dist'),
    path.resolve(process.cwd(), '../web/dist'),
    path.resolve(path.dirname(process.execPath), 'web'),
  ].filter(Boolean) as string[];
  const root = candidates.find((c) => fs.existsSync(path.join(c, 'index.html')));
  if (!root) return null;
  const out = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(root, full).split(path.sep).join('/'), fs.readFileSync(full));
    }
  };
  walk(root);
  return out;
}

function __filenameCompat(): string {
  // Works in both the ESM dev build (tsx) and the bundled CJS build.
  return typeof __filename !== 'undefined' ? __filename : path.join(process.cwd(), 'index.js');
}
