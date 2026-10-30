import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  // @mimir/core and @mimir/unpacker ship TypeScript sources: bundle them into the executable
  noExternal: ['@mimir/core', '@mimir/unpacker'],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
});
