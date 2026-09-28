import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Browser demo build: swaps the server-backed api/store for an in-browser
 * HyperDeck simulator and emits one IIFE bundle with React loaded as UMD
 * globals, so the result can be inlined into a single HTML page.
 */
export default defineConfig({
  plugins: [react({ jsxRuntime: 'classic' })],
  esbuild: { jsxInject: `import React from 'react'` },
  resolve: {
    alias: [
      { find: /^(\.\.?\/)+lib\/api$/, replacement: path.resolve(__dirname, 'src/demo/api.ts') },
      { find: /^(\.\.?\/)+lib\/store$/, replacement: path.resolve(__dirname, 'src/demo/store.ts') },
    ],
  },
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/main.tsx'),
      external: ['react', 'react-dom', 'react-dom/client'],
      output: {
        format: 'iife',
        entryFileNames: 'demo.js',
        assetFileNames: 'demo[extname]',
        globals: { react: 'React', 'react-dom': 'ReactDOM', 'react-dom/client': 'ReactDOM' },
      },
    },
  },
});
