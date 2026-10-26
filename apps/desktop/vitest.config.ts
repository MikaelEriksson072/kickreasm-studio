import { defineConfig } from 'vitest/config';

// Unit tests for the Electron main-process logic and the renderer's pure helpers (no Electron needed).
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
