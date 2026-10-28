import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * The renderer ships a strict Content-Security-Policy. During `electron-vite dev` the React
 * refresh preamble is an inline module script and HMR talks over a websocket, so the dev
 * server relaxes exactly those two directives.
 */
function devCsp(): Plugin {
  return {
    name: 'mimir-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*");
    },
  };
}

export default defineConfig({
  main: {
    // @mimir/core is TypeScript source in the workspace: bundle it into the main process
    plugins: [externalizeDepsPlugin({ exclude: ['@mimir/core'] })],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'electron/main/index.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'electron/preload/index.ts') } } },
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react(), devCsp()],
    worker: { format: 'es' },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/index.html') } } },
    server: { fs: { allow: [resolve(__dirname, '../..')] } },
  },
});
