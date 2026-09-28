import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the panel runs on :5173 and proxies API + WebSocket to the server on :8080.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
