import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  // @mimir/core and @mimir/sindri ship TypeScript sources: bundle them into the executable
  noExternal: ['@mimir/core', '@mimir/sindri'],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
});
