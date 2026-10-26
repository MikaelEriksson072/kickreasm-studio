import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  // @kickreasm/core ships TypeScript sources: bundle it into the executable
  noExternal: ['@kickreasm/core'],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
});
