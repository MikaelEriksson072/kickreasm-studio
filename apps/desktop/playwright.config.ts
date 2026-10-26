import { defineConfig } from '@playwright/test';

// End-to-end tests against the built Electron app (`out/`); `pnpm --filter @kickreasm/desktop e2e` builds first.
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  // one Electron window at a time keeps keyboard focus and timings predictable
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
});
