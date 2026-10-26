/* Playwright-for-Electron fixtures (spec 16). Every test starts the built app (out/main/index.js)
 * with a fresh user-data folder, so settings.json and the project autosaved in localStorage start
 * empty and the demo program is loaded. KICKREASM_E2E_EXE=<path to KickReasm Studio.exe> runs the
 * same tests against a packaged app (release/<version>/win-unpacked or an installed copy). */
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const appDir = resolve(__dirname, '..');
export const repoDir = resolve(appDir, '../..');
const mainEntry = join(appDir, 'out/main/index.js');
/** the `electron` package exports the path of its binary */
const electronPath = createRequire(join(appDir, 'package.json'))('electron') as string;
const packagedExe = process.env.KICKREASM_E2E_EXE ? resolve(process.env.KICKREASM_E2E_EXE) : null;

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), `kickreasm-e2e-${prefix}-`));

function removeDir(dir: string) {
  // Chromium helper processes can hold files for a moment after the app quits
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left for the OS temp cleanup */ }
}

interface Fixtures {
  /** an empty folder for files the test writes, removed afterwards */
  workDir: string;
  userData: string;
  app: ElectronApplication;
  page: Page;
}

export const test = base.extend<Fixtures>({
  workDir: async ({}, use) => {
    const dir = tempDir('files');
    await use(dir);
    removeDir(dir);
  },

  userData: async ({}, use) => {
    const dir = tempDir('profile');
    await use(dir);
    removeDir(dir);
  },

  app: async ({ userData }, use) => {
    if (packagedExe && !existsSync(packagedExe)) throw new Error(`KICKREASM_E2E_EXE: ${packagedExe} does not exist`);
    if (!packagedExe && !existsSync(mainEntry)) throw new Error(`${mainEntry} is missing: run \`electron-vite build\` first (the e2e script does).`);
    // load out/renderer/index.html, never a dev server
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== 'ELECTRON_RENDERER_URL' && e[1] !== undefined));
    const profile = `--user-data-dir=${userData}`;
    const app = await electron.launch(packagedExe
      ? { executablePath: packagedExe, args: [profile], env }
      : { executablePath: electronPath, args: [mainEntry, profile], cwd: appDir, env });
    await use(app);
    await app.close();
  },

  page: async ({ app }, use, testInfo) => {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e.stack ?? e)));
    await page.waitForLoadState('domcontentloaded');
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('window', { body: await page.screenshot(), contentType: 'image/png' }).catch(() => undefined);
    }
    expect(errors, 'uncaught exceptions in the renderer').toEqual([]);
  },
});

export { expect };
