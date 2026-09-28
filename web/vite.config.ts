import { createLogger, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-ignore — plain .mjs helper shared with server/build.mjs, no type declarations
import { buildInfo } from '../scripts/buildinfo.mjs';

const info = buildInfo();

// The dev proxy logs a full stack trace for routine disconnects: a tab closing or refreshing mid
// WebSocket push (ECONNABORTED/ECONNRESET/EPIPE), and every request while the server is still
// starting or restarting under tsx watch (ECONNREFUSED). Drop the former, and squash the latter
// to one short line every few seconds; anything else is logged as usual.
const logger = createLogger();
const logError = logger.error.bind(logger);
const DISCONNECTS = new Set(['ECONNABORTED', 'ECONNRESET', 'EPIPE']);
let lastRefused = 0;
logger.error = (msg, opts) => {
  const code = (opts?.error as NodeJS.ErrnoException | undefined)?.code
    ?? ((opts?.error as { errors?: NodeJS.ErrnoException[] } | undefined)?.errors?.[0]?.code);
  if (msg.includes('proxy') && code && DISCONNECTS.has(code)) return;
  if (msg.includes('proxy') && code === 'ECONNREFUSED') {
    if (Date.now() - lastRefused > 5000) logger.warn('Server on :8080 not reachable yet (starting/restarting?)', { timestamp: true });
    lastRefused = Date.now();
    return;
  }
  logError(msg, opts);
};

// In dev, the panel runs on :5173 and proxies API + WebSocket to the server on :8080.
export default defineConfig({
  customLogger: logger,
  plugins: [react()],
  // Baked in at build time (or when the Vite dev server starts), so the sidebar shows exactly
  // which code the page came from — and a stale dev server shows a stale commit.
  define: {
    __APP_VERSION__: JSON.stringify(info.version),
    __APP_COMMIT__: JSON.stringify(info.commit),
    __APP_BUILT__: JSON.stringify(info.builtAt),
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
