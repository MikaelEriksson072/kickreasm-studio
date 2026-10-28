import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  // @mimir/core ships TypeScript sources: bundle it into the executable
  noExternal: ['@mimir/core'],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
});
