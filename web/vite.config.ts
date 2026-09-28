import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-ignore — plain .mjs helper shared with server/build.mjs, no type declarations
import { buildInfo } from '../scripts/buildinfo.mjs';

const info = buildInfo();

// In dev, the panel runs on :5173 and proxies API + WebSocket to the server on :8080.
export default defineConfig({
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
