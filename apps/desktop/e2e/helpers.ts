/* Page helpers for the e2e tests. The app has no test ids; these use its roles, labels and the
 * class names of the listing, status bar and toasts. */
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect } from './fixtures';

export interface ListingRow {
  /** address column as shown (lower-case hex, '' for lines without bytes) */
  adr: string;
  /** source text; the block description for header rows */
  text: string;
  hdr: boolean;
  /** block type chip of a header row ('' for other rows) */
  chip: string;
  /** header of a block whose type was set by the user */
  user: boolean;
}

export const listing = (page: Page): Locator => page.getByLabel('Disassembly listing');
export const statusBar = (page: Page): Locator => page.locator('footer.statusbar');
export const toast = (page: Page, text: string | RegExp): Locator => page.locator('.toasts .toast', { hasText: text });

/** Wait until the analysis worker delivered the first listing. */
export async function waitForListing(page: Page): Promise<void> {
  await expect(listing(page).locator('.row').first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Every row of the virtualized listing: scrolls through it one screen at a time, collects the
 * rendered rows by position and restores the scroll position.
 */
export async function listingRows(page: Page): Promise<ListingRow[]> {
  return listing(page).evaluate(async (el: HTMLElement) => {
    const frames = (n: number) => new Promise<void>(done => { const step = () => (n-- > 0 ? requestAnimationFrame(step) : done()); step(); });
    const rows = new Map<number, { adr: string; text: string; hdr: boolean; chip: string; user: boolean }>();
    const start = el.scrollTop;
    for (let y = 0; ; y += Math.max(100, el.clientHeight - 40)) {
      el.scrollTop = y;
      await frames(3);
      for (const r of el.querySelectorAll<HTMLElement>('.row')) {
        const hdr = r.classList.contains('hdr');
        rows.set(parseFloat(r.style.top), {
          adr: r.querySelector('.adr')?.textContent ?? '',
          text: (hdr ? r.querySelector('.hdr-text') : r.querySelector('.src'))?.textContent ?? r.textContent ?? '',
          hdr,
          chip: r.querySelector('.hdr-chip')?.textContent ?? '',
          user: !!r.querySelector('.hdr-user'),
        });
      }
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) break;
    }
    el.scrollTop = start;
    await frames(2);
    return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  });
}

/** How often `name` appears as a whole identifier in the rows. */
export function occurrences(rows: ListingRow[], name: string): number {
  const re = new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'g');
  return rows.reduce((n, r) => n + (r.text.match(re)?.length ?? 0), 0);
}

/** G opens "Go to address, label or range"; Enter jumps there, or selects the range ("$2000-$27ff"). */
export async function goTo(page: Page, target: string): Promise<void> {
  await page.keyboard.press('g');
  const dialog = page.getByRole('dialog', { name: 'Go to address, label or range' });
  const input = dialog.getByLabel('Address (hex), label or range');
  await input.fill(target);
  await input.press('Enter');
  await expect(dialog).toBeHidden();
}

/** The header row of the block that starts at `adr` (lower-case hex, as the listing shows it). */
export const headerRow = (page: Page, adr: string): Locator => listing(page).locator('.row.hdr', { has: page.locator('.adr', { hasText: new RegExp(`^${adr}$`) }) });

/**
 * Replace Electron's file dialogs in the main process: `open` answers the next showOpenDialog
 * calls (files or a folder), `save` the next showSaveDialog calls.
 */
export async function stubDialogs(app: ElectronApplication, answers: { open?: string[]; save?: string }): Promise<void> {
  await app.evaluate(({ dialog }, a) => {
    const d = dialog as unknown as Record<string, unknown>;
    // every dialog's options (the last argument; the first is the window) are kept for dialogOptions()
    const g = globalThis as unknown as { dialogOptions?: { title?: string; defaultPath?: string }[] };
    const seen = (args: unknown[]) => { (g.dialogOptions ??= []).push(args[args.length - 1] as { title?: string; defaultPath?: string }); };
    if (a.open) d.showOpenDialog = async (...args: unknown[]) => { seen(args); return { canceled: false, filePaths: a.open }; };
    if (a.save) d.showSaveDialog = async (...args: unknown[]) => { seen(args); return { canceled: false, filePath: a.save }; };
  }, answers);
}

/** the title and start folder of every stubbed dialog so far */
export const dialogOptions = (app: ElectronApplication): Promise<{ title?: string; defaultPath?: string }[]> =>
  app.evaluate(() => ((globalThis as unknown as { dialogOptions?: { title?: string; defaultPath?: string }[] }).dialogOptions ?? []).map(o => ({ title: o.title, defaultPath: o.defaultPath })));
