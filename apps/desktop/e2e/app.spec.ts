/* End-to-end flows in the real Electron app (spec 16 "UI"): the demo listing, rename (N), mark as
 * bytes (D), verify (F7), undo/redo, selecting large ranges (G with a range, Shift+click on headers,
 * dragging) that merge the blocks inside, and open/save/export with Electron's file dialogs stubbed.
 * Build & Run (F5) is not covered: it starts VICE. */
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, repoDir, test } from './fixtures';
import { dialogOptions, goTo, headerRow, listing, listingRows, occurrences, statusBar, stubDialogs, toast, waitForListing, type ListingRow } from './helpers';

const OLD = 'var_092d';
const NEW = 'sine_pos';

test('shows the analysed demo listing', async ({ app, page }) => {
  expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged), 'packaged app').toBe(!!process.env.MIMIR_E2E_EXE);
  await expect(page).toHaveTitle('Mimir Studio');
  await waitForListing(page);
  await expect(page.locator('.welcome')).toContainText('raster-demo.prg is analysed');
  // the cursor starts on the entry point
  await expect(statusBar(page)).toContainText('$0810 · start · Code');
  await expect(statusBar(page)).toContainText('round-trip not verified');

  const rows = await listingRows(page);
  const text = rows.map(r => r.text).join('\n');
  expect(text).toContain('BasicUpstart2(start)');
  expect(text).toContain('jsr sub_0866');
  expect(text).toContain('.text "MIMIR STUDIO DEMO    "');
  expect(rows.filter(r => r.hdr).length).toBeGreaterThan(10);
});

test('rename, mark as bytes, verify, undo and redo', async ({ page }) => {
  await waitForListing(page);
  const refs = occurrences(await listingRows(page), OLD);
  // block header, label definition, `ldx var_092d` and `inc var_092d`
  expect(refs).toBeGreaterThanOrEqual(4);

  await test.step('N renames a label and every reference', async () => {
    await goTo(page, OLD);
    await expect(statusBar(page)).toContainText(`$092d · ${OLD}`);
    await page.keyboard.press('n');
    const input = page.getByLabel('Label at $092d');
    await expect(input).toHaveValue(OLD);
    await input.fill(NEW);
    await input.press('Enter');
    await expect(input).toBeHidden();
    await expect(toast(page, `Renamed to ${NEW}; all references updated`)).toBeVisible();
    await expect(statusBar(page)).toContainText(`$092d · ${NEW}`);

    const rows = await listingRows(page);
    expect(occurrences(rows, OLD)).toBe(0);
    expect(occurrences(rows, NEW)).toBe(refs);

    // X: the cross-reference panel lists the referencing instructions with the new name
    await page.keyboard.press('x');
    const xref = page.locator('.xref');
    await expect(xref.locator('.xref-head')).toContainText(`References to ${NEW}`);
    const instructions = xref.locator('tbody tr td:nth-child(3)');
    await expect(instructions).toHaveText([`ldx ${NEW}`, `inc ${NEW}`]);
  });

  await test.step('Shift+Down selects a range and D marks it as bytes', async () => {
    // fx_091e is a jump-table routine: lda SID_OSC3 / and #$0f / sta COLOR_RAM+999 / rts
    await goTo(page, 'fx_091e');
    expect(rowAt(await listingRows(page), '091e')?.text).toMatch(/^lda SID_OSC3/);
    for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowDown');
    await expect(statusBar(page)).toContainText('sel $091e–$0925 (8 B)');
    await page.keyboard.press('d');
    await expect(toast(page, '$091e–$0925 marked as Bytes (.byte)')).toBeVisible();
    await expect(userHeader(page, '091e')).toBeVisible();

    const rows = await listingRows(page);
    expect(headerAt(rows, '091e')).toMatchObject({ chip: 'Data', user: true });
    expect(rowAt(rows, '091e')?.text).toMatch(/^\.byte \$ad, \$1b, \$d4, \$29, \$0f/);
  });

  await test.step('F7 verifies the round-trip', async () => {
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
    await expect(toast(page, 'Round-trip verified')).toBeVisible();
    const build = page.locator('.bottom .build');
    await expect(build).toContainText('built-in verifier: byte-identical');
    await expect(build).toContainText('Round-trip OK: 12287 / 12287 bytes identical to raster-demo.prg');
    await expect(build).not.toContainText('FAILED');
    const withKick = (await statusBar(page).textContent())?.includes('with KickAss.jar');
    test.info().annotations.push({ type: 'verifier', description: withKick ? 'built-in assembler and KickAss.jar' : 'built-in assembler only (KickAss.jar not configured)' });
  });

  await test.step('Ctrl+Z undoes the mark, then the rename', async () => {
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    const redo = page.getByRole('button', { name: 'Redo', exact: true });
    const markLabel = 'Undo: Mark $091e-$0925 as Bytes (.byte) (Ctrl+Z)';
    await expect(undo).toHaveAttribute('title', markLabel);
    await expect(redo).toBeDisabled();

    await page.keyboard.press('Control+z');
    await expect(undo).toHaveAttribute('title', `Undo: Rename $092d to ${NEW} (Ctrl+Z)`);
    await expect(userHeader(page, '091e')).toHaveCount(0);
    // the verification belongs to the edited output, so it is stale now
    await expect(statusBar(page)).toContainText('round-trip not verified');

    await page.keyboard.press('Control+z');
    await expect(undo).toHaveAttribute('title', 'Nothing to undo');
    await expect(redo).toBeEnabled();
    let rows = await listingRows(page);
    expect(occurrences(rows, NEW)).toBe(0);
    expect(occurrences(rows, OLD)).toBe(refs);
    expect(headerAt(rows, '091e')).toMatchObject({ chip: 'Code', user: false });
    expect(rowAt(rows, '091e')?.text).toMatch(/^lda SID_OSC3/);

    await test.step('Ctrl+Y redoes both', async () => {
      await page.keyboard.press('Control+y');
      await expect(undo).toHaveAttribute('title', `Undo: Rename $092d to ${NEW} (Ctrl+Z)`);
      await page.keyboard.press('Control+y');
      await expect(undo).toHaveAttribute('title', markLabel);
      await expect(redo).toBeDisabled();
      rows = await listingRows(page);
      expect(occurrences(rows, OLD)).toBe(0);
      expect(occurrences(rows, NEW)).toBe(refs);
      expect(headerAt(rows, '091e')).toMatchObject({ chip: 'Data', user: true });
      // the output is the verified one again
      await expect(statusBar(page)).toContainText('✓ round-trip verified');
    });
  });
});

test('select large ranges and merge the blocks inside them into one', async ({ page }) => {
  await waitForListing(page);
  const headersIn = (rows: ListingRow[], from: number, to: number) => rows.filter(r => r.hdr && parseInt(r.adr, 16) >= from && parseInt(r.adr, 16) < to);

  await test.step('G with a range selects it, and marking merges the blocks inside', async () => {
    // two blocks whose type the user set, inside $0939-$0ab4
    await goTo(page, '$0949-$0950');
    await expect(statusBar(page)).toContainText('sel $0949–$0950 (8 B)');
    await page.keyboard.press('d');
    await expect(headerRow(page, '0949').locator('.hdr-user')).toBeVisible();
    await goTo(page, '$0960-$096f');
    await page.keyboard.press('w');
    await expect(headerRow(page, '0960').locator('.hdr-user')).toBeVisible();
    const before = headersIn(await listingRows(page), 0x0939, 0x0ab5);
    expect(before.length).toBeGreaterThan(4);

    await goTo(page, 'colors_0939-$0ab4');
    await expect(statusBar(page)).toContainText('sel $0939–$0ab4 (380 B)');
    await page.keyboard.press('d');
    await expect(toast(page, `$0939–$0ab4 marked as Bytes (.byte), merging ${before.length} blocks into one`)).toBeVisible();
    await expect(headerRow(page, '0960')).toHaveCount(0);
    const after = headersIn(await listingRows(page), 0x0939, 0x0ab5);
    expect(after).toEqual([expect.objectContaining({ adr: '0939', chip: 'Data', user: true })]);
    expect(after[0].text).toContain('$0939-$0ab4 (380 bytes)');

    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });

  await test.step('Shift+click on block headers selects whole blocks', async () => {
    await page.keyboard.press('Control+z');
    // the listing is virtualized: collapse the build panel so every header used below is on screen
    await page.keyboard.press('Control+j');
    await expect(page.locator('section.bottom')).toHaveClass(/collapsed/);
    await goTo(page, '$0951');
    await headerRow(page, '0949').click();
    await expect(statusBar(page)).toContainText('sel $0949–$0950 (8 B)');
    await headerRow(page, '0970').click({ modifiers: ['Shift'] });
    await expect(statusBar(page)).toContainText('sel $0949–$0984 (60 B)');
    for (const adr of ['0949', '0951', '0960', '0970']) await expect(headerRow(page, adr)).toHaveClass(/\bsel\b/);
  });

  await test.step('dragging from one block header to another selects both blocks and everything between', async () => {
    await headerRow(page, '0951').evaluate(el => el.scrollIntoView({ block: 'center' }));
    const from = (await headerRow(page, '0949').boundingBox())!, to = (await headerRow(page, '0960').boundingBox())!;
    await page.mouse.move(from.x + 60, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(statusBar(page)).toContainText('sel $0949–$096f (39 B)');
    await page.keyboard.press('t');
    await expect(toast(page, '$0949–$096f marked as Text (PETSCII), merging 3 blocks into one')).toBeVisible();
    expect(headersIn(await listingRows(page), 0x0949, 0x0970)).toEqual([expect.objectContaining({ adr: '0949', chip: 'Text', user: true })]);
  });

  await test.step('dragging past the bottom edge scrolls the listing and keeps extending the selection', async () => {
    const list = (await listing(page).boundingBox())!, from = (await headerRow(page, '0949').boundingBox())!;
    await page.mouse.move(from.x + 60, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, list.y + list.height + 12, { steps: 4 });
    // far below what was on screen: past $0a00
    await expect(statusBar(page)).toContainText(/sel \$0949–\$(0[a-f]|[1-9a-f][0-9a-f])[0-9a-f]{2}/);
    await page.mouse.up();
  });
});

test('a text block can be set to .byte with D or the inspector', async ({ page }) => {
  await waitForListing(page);
  const bodyRows = (rows: ListingRow[], from: number, to: number) => rows.filter(r => !r.hdr && r.adr && parseInt(r.adr, 16) >= from && parseInt(r.adr, 16) < to && !r.text.endsWith(':'));
  const expectBytes = async () => {
    const rows = await listingRows(page);
    expect(headerAt(rows, '0960')).toMatchObject({ chip: 'Data', user: true });
    const body = bodyRows(rows, 0x0960, 0x0985);
    expect(body.length).toBeGreaterThan(0);
    for (const r of body) expect(r.text).toMatch(/^\.byte \$/);
  };
  await goTo(page, 'txt_0960');
  const rows = await listingRows(page);
  expect(headerAt(rows, '0960')).toMatchObject({ chip: 'Text', user: false });
  expect(rowAt(rows, '0960')?.text).toMatch(/^\.text "/);

  await test.step('D', async () => {
    await page.keyboard.press('d');
    await expect(toast(page, '$0960–$0984 marked as Bytes (.byte)')).toBeVisible();
    await expectBytes();
  });

  await test.step('Type → Bytes (.byte) in the inspector', async () => {
    await page.keyboard.press('Control+z');
    await expect(userHeader(page, '0960')).toHaveCount(0);
    const type = page.locator('.inspector').getByLabel('Type');
    await expect(type).toHaveValue('text');
    await type.selectOption('bytes');
    await expect(userHeader(page, '0960')).toBeVisible();
    await expect(type).toHaveValue('bytes');
    await expectBytes();
  });
});

test('insert a comment line and a comment block, edit and remove them', async ({ page }) => {
  await waitForListing(page);
  /** the source text of the rows right before the row with text `before` */
  const above = async (before: string, n: number) => { const rows = await listingRows(page); const i = rows.findIndex(r => r.text === before); return rows.slice(Math.max(0, i - n), i).map(r => r.text); };
  const commentRow = (text: string) => listing(page).locator('.row.k-cmt', { hasText: text });

  await test.step('/ inserts a comment line above the cursor line and its label', async () => {
    await goTo(page, 'start');
    await page.keyboard.press('/');
    const input = page.getByLabel('Comment line above $0810');
    await input.fill('set up the raster IRQ');
    await input.press('Enter');
    await expect(input).toBeHidden();
    await expect(commentRow('// set up the raster IRQ')).toBeVisible();
    expect(await above('start:', 1)).toEqual(['// set up the raster IRQ']);
  });

  await test.step('* inserts a comment block', async () => {
    await goTo(page, 'sine_09b5');
    await page.keyboard.press('*');
    const area = page.getByLabel('Comment block above $09b5');
    await area.fill('curve for the\nsprite x position');
    await area.press('Control+Enter');
    await expect(area).toBeHidden();
    expect(await above('sine_09b5:', 4)).toEqual(['/*', 'curve for the', 'sprite x position', '*/']);
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });

  await test.step('double-click edits a comment line; emptying it removes it', async () => {
    // back to $0810 with the build panel closed (the listing is virtualized)
    await page.keyboard.press('Control+j');
    await goTo(page, 'start');
    await commentRow('// set up the raster IRQ').dblclick();
    const input = page.getByLabel('Comment line above $0810');
    await expect(input).toHaveValue('set up the raster IRQ');
    await input.fill('raster IRQ setup');
    await input.press('Enter');
    await expect(commentRow('// raster IRQ setup')).toBeVisible();
    await commentRow('// raster IRQ setup').dblclick();
    await page.getByLabel('Comment line above $0810').fill('');
    await page.getByLabel('Comment line above $0810').press('Enter');
    await expect(commentRow('raster IRQ setup')).toHaveCount(0);
    expect(await above('start:', 1)).not.toEqual(['// raster IRQ setup']);
  });

  await test.step('Ctrl+Z brings the comment line back', async () => {
    await page.keyboard.press('Control+z');
    await expect(commentRow('// raster IRQ setup')).toBeVisible();
  });

  await test.step('the context menu acts on the line it was opened on, not on the old cursor line', async () => {
    const row = listing(page).locator('.row.k-ins').nth(4);
    const adr = (await row.locator('.adr').textContent())!;
    expect(adr).not.toBe('0810');
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Insert comment block above…' }).click();
    const area = page.getByLabel(`Comment block above $${adr}`);
    await expect(area).toBeVisible();
    await area.press('Escape');
    await expect(area).toBeHidden();
  });
});

test('set the memory configuration ($01) code runs with', async ({ page }) => {
  await waitForListing(page);
  // the first border color write in the demo, which never writes $01 (so it runs with $37)
  const start = (await listingRows(page)).find(r => r.text.startsWith('sta VIC_BORDER_COLOR'))!;
  expect(start).toBeTruthy();
  await goTo(page, `$${start.adr}`);
  await expect(statusBar(page)).toContainText('$01 $37');
  const row = () => listing(page).locator('.row.k-ins', { has: page.locator('.adr', { hasText: new RegExp(`^${start.adr}$`) }) });

  await test.step('right-click → Memory configuration ($01) → $34 makes $d020 plain RAM', async () => {
    await row().click({ button: 'right' });
    await page.locator('.ctx-item.has-sub', { hasText: 'Memory configuration ($01)' }).hover();
    await page.getByRole('menuitem', { name: '$34 · RAM · RAM · RAM' }).click();
    await expect(toast(page, 'runs with $01 = $34 (RAM · RAM · RAM)')).toBeVisible();
    await expect(row()).toContainText('sta $d020');
    await expect(statusBar(page)).toContainText('$01 $34');
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });

  await test.step('the inspector sets $35 for the whole block: I/O is back', async () => {
    await page.keyboard.press('Control+j');
    const sel = page.locator('.inspector').getByLabel('Memory configuration ($01)');
    await sel.selectOption(String(0x35));
    await expect(row()).toContainText('sta VIC_BORDER_COLOR');
    await expect(statusBar(page)).toContainText('$01 $35');
    await expect(sel).toHaveValue(String(0x35));
  });

  await test.step('Ctrl+Z twice returns to the detected $37', async () => {
    await page.keyboard.press('Control+z');
    await expect(row()).toContainText('sta $d020');
    await page.keyboard.press('Control+z');
    await expect(statusBar(page)).toContainText('$01 $37');
    await expect(row()).toContainText('sta VIC_BORDER_COLOR');
  });
});

test('the listing shows memory addresses or line numbers', async ({ page }) => {
  await waitForListing(page);
  const gutter = page.getByRole('group', { name: 'Left column' });
  const startRow = (rows: ListingRow[]) => rows.find(r => r.text === 'start:')!;
  await expect(gutter.getByRole('button', { name: 'Address' })).toHaveAttribute('aria-pressed', 'true');
  expect(startRow(await listingRows(page)).adr).toBe('0810');

  const numbered = async () => {
    const rows = await listingRows(page);
    // numbered like the .asm file: 1, 2, 3 … without gaps (blank lines too); only the file bar has none
    const nums = rows.filter(r => r.adr !== '').map(r => Number(r.adr));
    expect(nums).toEqual(nums.map((_n, i) => i + 1));
    expect(rows.filter(r => r.adr === '').length).toBe(1);
    expect(Number(startRow(rows).adr)).toBeGreaterThan(1);
  };
  await gutter.getByRole('button', { name: 'Line' }).click();
  await expect(gutter.getByRole('button', { name: 'Line' })).toHaveAttribute('aria-pressed', 'true');
  await numbered();

  // the choice is kept
  await page.reload();
  await waitForListing(page);
  await expect(page.getByRole('group', { name: 'Left column' }).getByRole('button', { name: 'Line' })).toHaveAttribute('aria-pressed', 'true');
  await numbered();

  await page.getByRole('group', { name: 'Left column' }).getByRole('button', { name: 'Address' }).click();
  expect(startRow(await listingRows(page)).adr).toBe('0810');
});

test('set the program start by hand', async ({ page }) => {
  await waitForListing(page);
  const section = page.locator('.side-sec', { hasText: 'Program start' });
  const input = page.getByLabel('Program start address');
  const hasRow = async (text: string) => (await listingRows(page)).some(r => r.text.startsWith(text));
  await expect(section).toContainText('$0810');
  await expect(section).toContainText('BASIC SYS');
  await expect(section).toContainText('Build & Run: VICE starts it with RUN, no start address');
  await expect(section.getByRole('button', { name: 'Clear' })).toHaveCount(0);

  await test.step('typing a label in the Explorer moves `start` there', async () => {
    await input.fill('sub_0866');
    await input.press('Enter');
    await expect(toast(page, 'The program starts at $0866')).toBeVisible();
    await expect(section).toContainText('$0866');
    await expect(section).toContainText('set by you');
    await expect(section).toContainText('Build & Run: VICE loads it and types sys 2150');
    await expect(statusBar(page)).toContainText('$0866 · start');
    // the BASIC stub still SYSes $0810, which keeps its code under its own name
    expect(await hasRow('BasicUpstart2(entry_0810)')).toBe(true);
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });

  await test.step('an address outside the files is refused', async () => {
    await input.fill('$9000');
    await input.press('Enter');
    await expect(section).toContainText('$9000 is not part of any loaded file.');
  });

  await test.step('Clear goes back to RUN and the detected start, and the context menu sets and clears', async () => {
    await section.getByRole('button', { name: 'Clear' }).click();
    await expect(toast(page, 'Program start cleared: Build & Run starts the program with RUN')).toBeVisible();
    await expect(section).toContainText('BASIC SYS');
    await expect(section).toContainText('Build & Run: VICE starts it with RUN, no start address');
    await expect(section.getByRole('button', { name: 'Clear' })).toHaveCount(0);
    expect(await hasRow('BasicUpstart2(start)')).toBe(true);
    await page.keyboard.press('Control+j');
    await goTo(page, 'sub_0866');
    const row = listing(page).locator('.row.k-ins', { has: page.locator('.adr', { hasText: /^0866$/ }) });
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Set as program start' }).click();
    await expect(section).toContainText('set by you');
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Clear program start ($0866)' }).click();
    await expect(section).toContainText('BASIC SYS');
    await page.keyboard.press('Control+z');
    await expect(section).toContainText('set by you');
    await page.keyboard.press('Control+z');
    await expect(section).toContainText('BASIC SYS');
  });
});

test('show data as code to find code that is marked as data', async ({ page }) => {
  await waitForListing(page);
  const toggle = page.getByRole('button', { name: 'Data as code' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await goTo(page, 'colors_0939');
  expect(rowAt(await listingRows(page), '0939')?.text).toMatch(/^\.byte \$06, \$0e/);

  await test.step('the toggle shows the table bytes disassembled; the export is unchanged', async () => {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.preview-bar')).toBeVisible();
    await expect(headerRow(page, '0939').locator('.hdr-preview')).toBeVisible();
    // (the listing is much longer now: read the rows on screen instead of scrolling through all of them)
    await expect(listing(page).locator('.row.k-ins.preview', { has: page.locator('.adr', { hasText: /^0939$/ }) })).toContainText('asl $0e'); // $06 $0e
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });

  await test.step('C marks what looks like code as code', async () => {
    await page.keyboard.press('Control+j');
    await goTo(page, 'colors_0939');
    await page.keyboard.press('c');
    await expect(toast(page, '$0939–$0948 marked as Code')).toBeVisible();
    await expect(headerRow(page, '0939').locator('.hdr-user')).toBeVisible();
    await expect(headerRow(page, '0939').locator('.hdr-preview')).toHaveCount(0); // real code now
    await page.keyboard.press('Control+z');
    await expect(headerRow(page, '0939').locator('.hdr-preview')).toBeVisible();
  });

  await page.getByRole('button', { name: 'Show as classified' }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(rowAt(await listingRows(page), '0939')?.text).toMatch(/^\.byte \$06, \$0e/);
});

test('Data as code keeps the line in view where it is on screen, both ways', async ({ page }) => {
  await waitForListing(page);
  const toggle = page.getByRole('button', { name: 'Data as code' });
  const y = async (l: Locator) => Math.round((await l.boundingBox())?.y ?? -1);
  // the row that shows `adr` (the last one starting at or before it) and where it is on screen
  const rowOf = (adr: number) => listing(page).evaluate((el, a) => {
    const rows = [...el.querySelectorAll<HTMLElement>('.row:not(.hdr)')].filter(r => /^[0-9a-f]{4}$/.test(r.querySelector('.adr')?.textContent ?? '') && r.querySelector('.hex')?.textContent)
      .sort((p, q) => parseFloat(p.style.top) - parseFloat(q.style.top));
    const r = rows.filter(x => parseInt(x.querySelector('.adr')!.textContent!, 16) <= a).pop();
    return r ? { adr: r.querySelector('.adr')!.textContent, y: Math.round(r.getBoundingClientRect().y) } : null;
  }, adr);

  await test.step('the cursor\'s line stays put, with all the data above it turned into code', async () => {
    // $3000 is far below the tables and graphics that become many lines of code
    await goTo(page, '$3000');
    const cur = listing(page).locator('.row.cur');
    const y0 = await y(cur);
    await toggle.click();
    await expect(listing(page).locator('.row.preview').first()).toBeVisible();
    await expect.poll(() => y(cur)).toBe(y0);
    await expect(cur.locator('.adr')).toHaveText(/^(2f[0-9a-f]{2}|3000)$/);
    await page.getByRole('button', { name: 'Show as classified' }).click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => y(cur)).toBe(y0);
  });

  await test.step('without the cursor in view, the top line stays put', async () => {
    const top = await listing(page).evaluate(async el => {
      // scrolled, and drawn again for where it is now
      el.scrollTop -= 2000;
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50))));
      const box = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll<HTMLElement>('.row:not(.hdr)')].filter(r => r.getBoundingClientRect().y >= box.y && r.getBoundingClientRect().bottom <= box.bottom && /^[0-9a-f]{4}$/.test(r.querySelector('.adr')?.textContent ?? '') && r.querySelector('.hex')?.textContent)
        .sort((p, q) => parseFloat(p.style.top) - parseFloat(q.style.top));
      return { adr: parseInt(rows[0].querySelector('.adr')!.textContent!, 16), y: Math.round(rows[0].getBoundingClientRect().y) };
    });
    await toggle.click();
    await expect(listing(page).locator('.row.preview').first()).toBeVisible();
    await expect.poll(async () => (await rowOf(top.adr))?.y).toBe(top.y);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await rowOf(top.adr))?.y).toBe(top.y);
  });
});

test('merge a block with the block before or after it', async ({ page }) => {
  await waitForListing(page);
  await goTo(page, 'txt_0960');

  await test.step('right-click → Merge with previous block', async () => {
    await headerRow(page, '0960').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Merge with previous block (Text) → Text' }).click();
    await expect(toast(page, '$0949–$0984 merged into one Text block')).toBeVisible();
    await expect(headerRow(page, '0960')).toHaveCount(0);
    await expect(headerRow(page, '0949')).toContainText('$0949-$0984');
  });

  await test.step('the inspector merges with the next block', async () => {
    await page.locator('.inspector').getByRole('button', { name: 'Merge with next', exact: true }).click();
    await expect(toast(page, '$0949–$09b4 merged into one Text block')).toBeVisible();
    await expect(headerRow(page, '0949')).toContainText('$0949-$09b4');
    await expect(headerRow(page, '0949').locator('.hdr-user')).toBeVisible();
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });

  await test.step('Ctrl+Z twice gives the three blocks back', async () => {
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+j');
    await goTo(page, 'txt_0960');
    await expect(headerRow(page, '0960')).toBeVisible();
    await expect(headerRow(page, '0949').locator('.hdr-user')).toHaveCount(0);
  });
});

test('fold and unfold blocks', async ({ page }) => {
  await waitForListing(page);
  const shown = async (adr: string) => (await listingRows(page)).some(r => !r.hdr && r.adr === adr);
  const folded = () => headerRow(page, '09b5').locator('.hdr-folded');
  await goTo(page, 'sine_09b5');
  expect(await shown('09bd')).toBe(true); // the sine table's second .byte row

  await test.step('the button on the header folds and unfolds', async () => {
    await headerRow(page, '09b5').getByRole('button', { name: 'Fold block' }).click();
    await expect(folded()).toContainText('lines folded');
    expect(await shown('09bd')).toBe(false);
    await headerRow(page, '09b5').getByRole('button', { name: 'Unfold block' }).click();
    await expect(folded()).toHaveCount(0);
    expect(await shown('09bd')).toBe(true);
  });

  await test.step('F folds the block at the cursor; going to an address inside unfolds it', async () => {
    await goTo(page, '$09c5');
    await page.keyboard.press('f');
    await expect(folded()).toBeVisible();
    await expect(statusBar(page)).toContainText('$09b5 · sine_09b5');
    // the arrow keys stop on the folded header
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    await expect(statusBar(page)).toContainText('$09b5 · sine_09b5');
    await goTo(page, '$09c5');
    await expect(folded()).toHaveCount(0);
    await expect(statusBar(page)).toContainText('$09c5');
  });

  await test.step('the command palette folds every block that is not code, and unfolds all', async () => {
    const palette = async (cmd: string) => { await page.keyboard.press('Control+Shift+P'); const q = page.getByRole('textbox', { name: 'Command' }); await q.fill(cmd); await q.press('Enter'); };
    await palette('Fold every block that is not code');
    expect(await shown('09bd')).toBe(false);
    expect((await listingRows(page)).some(r => r.text === 'start:')).toBe(true);
    await palette('Unfold all blocks');
    expect(await shown('09bd')).toBe(true);
  });
});

test('exclude a block from the build', async ({ page }) => {
  await waitForListing(page);
  await goTo(page, 'sine_09b5');

  await test.step('right-click → Exclude block from the build', async () => {
    await headerRow(page, '09b5').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Exclude block from the build' }).click();
    await expect(toast(page, '$09b5–$0ab4 is left out of the build')).toBeVisible();
    await expect(headerRow(page, '09b5').locator('.hdr-excluded')).toBeVisible();
    const text = (await listingRows(page)).map(r => r.text);
    expect(text).toContain('#if INCLUDE_sine_09b5');
    expect(text).toContain('.label sine_09b5 = $09b5');
    expect(text).toContain('#endif');
    expect(text).toContain('// #define INCLUDE_sine_09b5');
  });

  await test.step('F7 verifies the rest and says what was left out', async () => {
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
    await expect(page.locator('.bottom .build')).toContainText('(256 bytes left out of the build)');
  });

  await test.step('the inspector puts it back', async () => {
    await page.keyboard.press('Control+j');
    await goTo(page, 'sine_09b5');
    const box = page.locator('.inspector').getByLabel('Include in the build');
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(headerRow(page, '09b5').locator('.hdr-excluded')).toHaveCount(0);
    await expect(box).toBeChecked();
  });
});

test('text in mixed case', async ({ page }) => {
  await waitForListing(page);
  await goTo(page, 'txt_0985'); // screen codes, upper case set
  const rows = async () => (await listingRows(page)).map(r => r.text);
  expect(await rows()).toContain('.text "HELLO FROM THE MIMIR STUDIO DEMO!       ENJOY!!"');
  const type = page.locator('.inspector').getByLabel('Type');
  await expect(type).toHaveValue('textsc');
  await type.selectOption('textscmix');
  await expect(type).toHaveValue('textscmix');
  await expect(headerRow(page, '0985')).toContainText('Text (screen codes, mixed case)');
  const text = await rows();
  expect(text).toContain('.encoding "screencode_mixed"');
  expect(text).toContain('.text "hello from the mimir studio demo!       enjoy!!"');
  await expect(page.locator('.inspector .text-prev')).toContainText('hello from the mimir studio demo');
  await page.keyboard.press('F7');
  await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
});

const rowAt = (rows: ListingRow[], adr: string) => rows.find(r => !r.hdr && r.adr === adr && r.text && !r.text.endsWith(':'));
const headerAt = (rows: ListingRow[], adr: string) => rows.find(r => r.hdr && r.adr === adr);
const userHeader = (page: Page, adr: string) => listing(page).locator('.row.hdr', { has: page.locator('.adr', { hasText: adr }) }).locator('.hdr-user');

test('open a PRG, save and export through stubbed file dialogs', async ({ workDir: work, app, page }) => {
  await waitForListing(page);
  const prg = join(repoDir, 'fixtures/prg/raster-demo.prg');

  await test.step('Ctrl+O opens a PRG', async () => {
    await stubDialogs(app, { open: [prg] });
    await page.keyboard.press('Control+o');
    await expect(toast(page, 'Loaded raster-demo.prg at $0801')).toBeVisible();
    await expect(statusBar(page)).toContainText('$0810 · start');
  });

  await test.step('rename, then Ctrl+S saves the project', async () => {
    await goTo(page, OLD);
    await page.keyboard.press('n');
    await page.getByLabel('Label at $092d').fill(NEW);
    await page.getByLabel('Label at $092d').press('Enter');
    await expect(statusBar(page)).toContainText(`$092d · ${NEW}`);

    const file = join(work, 'demo.mimir.json');
    await stubDialogs(app, { save: file });
    await page.keyboard.press('Control+s');
    await expect(toast(page, `Project saved to ${file}`)).toBeVisible();
    expect(readFileSync(file, 'utf8')).toContain(NEW);
  });

  await test.step('Ctrl+E verifies and exports the Kick Assembler project', async () => {
    const out = join(work, 'export');
    await stubDialogs(app, { open: [out] });
    await page.keyboard.press('Control+e');
    await expect(toast(page, `Exported verified Kick Assembler project to ${out}`)).toBeVisible({ timeout: 90_000 });
    expect(readdirSync(out)).toEqual(expect.arrayContaining(['raster-demo.asm', 'raster-demo.mimir.json', 'build.bat', 'build.sh', 'include', 'original']));
    const asm = readFileSync(join(out, 'raster-demo.asm'), 'utf8');
    expect(asm).toContain(`ldx ${NEW}`);
    expect(asm).not.toContain(OLD);
    expect(existsSync(join(out, 'original', 'raster-demo.prg'))).toBe(true);
    // nothing to put in it: no bookmarks, no comments
    expect(existsSync(join(out, 'NOTES.html'))).toBe(false);
  });
});

test('mount a .d64 and open its PRG files', async ({ app, page }) => {
  // fixtures/d64/mimir-demo.d64 (written with makeD64): "RASTER DEMO" (the demo), "SPRITE" at $c000, "NOTES" (SEQ)
  await waitForListing(page);
  const files = page.getByRole('list', { name: 'Files on mimir-demo.d64' });

  await test.step('Mount D64… lists the directory', async () => {
    await stubDialogs(app, { open: [join(repoDir, 'fixtures/d64/mimir-demo.d64')] });
    await page.getByRole('button', { name: 'Mount D64…' }).click();
    await expect(toast(page, 'Mounted mimir-demo.d64: "MIMIR DEMO", 3 files')).toBeVisible();
    await expect(page.locator('.disk-head')).toContainText('"MIMIR DEMO"');
    await expect(files.getByRole('listitem')).toHaveText([/49\s*"RASTER DEMO"\s*PRG/, /1\s*"SPRITE"\s*PRG/, /1\s*"NOTES"\s*SEQ/]);
    await expect(files.getByRole('listitem').nth(2)).toHaveClass(/off/);
    await expect(page.locator('.side-inner')).toContainText('613 blocks free');
    // the disk comes right under Files, next to the button that mounted it, and the VICE quicksave under the disk
    await expect.poll(() => page.locator('.side-sec').evaluateAll(s => s.map(e => e.getAttribute('aria-label'))))
      .toEqual(['Files', 'Disk', 'VICE quicksave', 'Loaders', 'Program start', 'Memory map']);
  });

  await test.step('a click opens a PRG, + adds one to the project', async () => {
    await files.getByRole('listitem').filter({ hasText: 'RASTER DEMO' }).click();
    await expect(toast(page, 'Loaded RASTER DEMO.prg at $0801')).toBeVisible();
    await page.getByRole('button', { name: 'Add SPRITE to this project' }).click();
    await expect(toast(page, 'Loaded SPRITE.prg at $c000')).toBeVisible();
    await expect(page.locator('.file-name')).toHaveText(['RASTER DEMO.prg', 'SPRITE.prg']);
    // a SEQ file is listed but not opened
    await files.getByRole('listitem').filter({ hasText: 'NOTES' }).click();
    await expect(page.locator('.file-name')).toHaveCount(2);
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });

  await test.step('eject', async () => {
    await page.getByRole('button', { name: 'Eject disk' }).click();
    await expect(files).toHaveCount(0);
    await expect(page.locator('.file-name')).toHaveText(['RASTER DEMO.prg', 'SPRITE.prg']);
  });
});

test('the Terminal button opens a terminal in the project folder', async ({ workDir: work, app, page }) => {
  await waitForListing(page);
  // record what the main process starts instead of opening a real terminal window
  await app.evaluate(() => {
    const req = (process as unknown as { mainModule: { require: (m: string) => any } }).mainModule.require; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cp = req('node:child_process'), { EventEmitter } = req('node:events');
    const g = globalThis as unknown as { spawned: { file: string; args: string[]; cwd: string; jar?: string }[] };
    g.spawned = [];
    const real = cp.spawn;
    cp.spawn = (file: string, args: string[], o: { cwd: string; env: Record<string, string> }) => {
      // Kick Assembler (verify, export) still runs for real; Windows opens the terminal with `cmd /c start`
      const terminal = file === 'cmd.exe' ? /^\/d \/c start /.test(args[0] ?? '') : ['open', 'x-terminal-emulator'].includes(file);
      if (!terminal) return real(file, args, o);
      g.spawned.push({ file, args, cwd: o.cwd, jar: o.env.KICKASS_JAR });
      const child = Object.assign(new EventEmitter(), { pid: 4242, unref: () => {} });
      setImmediate(() => child.emit('spawn'));
      return child;
    };
  });
  const spawned = () => app.evaluate(() => (globalThis as unknown as { spawned: { file: string; args: string[]; cwd: string }[] }).spawned);
  const home = await app.evaluate(() => (process as unknown as { mainModule: { require: (m: string) => { homedir: () => string } } }).mainModule.require('node:os').homedir());

  await test.step('with no folder opened yet it starts in the home folder', async () => {
    await page.getByRole('button', { name: 'Terminal' }).click();
    await expect(toast(page, `Terminal opened in ${home}`)).toBeVisible();
    expect((await spawned())[0]).toMatchObject({ file: process.platform === 'win32' ? 'cmd.exe' : expect.any(String), cwd: home });
    if (process.platform === 'win32') expect((await spawned())[0].args[0]).toMatch(/start "Mimir Studio" \/D .* powershell\.exe -NoLogo -NoExit -Command /);
  });

  await test.step('after an export it starts in the exported folder', async () => {
    const out = join(work, 'export');
    await stubDialogs(app, { open: [out] });
    await page.keyboard.press('Control+e');
    await expect(toast(page, `Exported verified Kick Assembler project to ${out}`)).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Terminal' }).click();
    await expect(toast(page, `Terminal opened in ${out}`)).toBeVisible();
    expect((await spawned())[1].cwd).toBe(out);
  });
});

test('a packed PRG is reported and unpacked with an external unpacker', async ({ app, page }) => {
  // fixtures/prg/packed-demo.prg: the demo behind a decruncher stub, packed so fake-unp64.cjs (a stand-in for unp64,
  // run with this Node) unpacks it to `<name>.0810` the way unp64 names its files
  const fake = join(repoDir, 'packages/core/test/helpers/fake-unp64.cjs');
  await waitForListing(page);
  const bar = page.locator('.pack-bar');

  await test.step('opening it shows the packed notice, the Explorer badge and a problem', async () => {
    await stubDialogs(app, { open: [join(repoDir, 'fixtures/prg/packed-demo.prg')] });
    await page.keyboard.press('Control+o');
    await expect(toast(page, 'Loaded packed-demo.prg at $0801')).toBeVisible();
    await expect(bar).toContainText('packed-demo.prg is packed.');
    await expect(bar).toContainText('The listing shows the decruncher at $080d and the packed data, not the program.');
    await expect(page.locator('.file-row', { hasText: 'packed-demo.prg' }).locator('.pill.pack')).toHaveText('packed');
    await page.keyboard.press('Control+j');
    await page.getByRole('tab', { name: /Problems/ }).click();
    await expect(page.locator('.loglist')).toContainText('packed-demo.prg is packed');
  });

  await test.step('without an unpacker the button opens the settings', async () => {
    // an installed unp64 is found by default: clear it first, so the test runs the same everywhere
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('#set-unpackerPath').fill('');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
    await bar.getByRole('button', { name: 'Set up an unpacker…' }).click();
    await page.locator('#set-unpackerPath').fill(process.execPath);
    await page.locator('#set-unpackerArgs').fill(`"${fake}" {in}`);
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
  });

  await test.step('Unpack replaces it with the program and sets its start', async () => {
    await bar.getByRole('button', { name: /^Unpack with / }).click();
    await expect(toast(page, 'Unpacked packed-demo.prg: 12287 bytes at $0801-$37ff')).toBeVisible({ timeout: 30_000 });
    const done = page.locator('.unpack-bar');
    await expect(done).toContainText('packed-demo-unpacked.prg, $0801-$37ff, starting at $0810 (set as the program start).');
    await done.locator('summary').click();
    await expect(done).toContainText('Unpacked packed-demo.prg with node (FakePack)');
    await expect(done.locator('.unpack-log')).toContainText('return to mem: $0810');
    await expect(done.locator('.unpack-log')).toContainText('saved $0801-$37ff as packed-demo.prg.0810');
    await expect(bar).toHaveCount(0);
    await expect(page.locator('.file-name')).toHaveText(['packed-demo-unpacked.prg']);
    await expect(page.locator('.side-sec', { hasText: 'Program start' })).toContainText('set by you');
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });
});

test('file dialogs open in the folder they were last used in', async ({ app, page, userData }) => {
  await waitForListing(page);
  const prgDir = join(repoDir, 'fixtures', 'prg'), diskDir = join(repoDir, 'fixtures', 'd64');

  await stubDialogs(app, { open: [join(prgDir, 'packed-demo.prg')] });
  await page.keyboard.press('Control+o');
  await expect(toast(page, 'Loaded packed-demo.prg at $0801')).toBeVisible();
  // the disk dialog has no folder of its own yet: it starts where the PRG came from
  await stubDialogs(app, { open: [join(diskDir, 'mimir-demo.d64')] });
  await page.getByRole('button', { name: 'Mount D64…' }).click();
  await expect(toast(page, 'Mounted mimir-demo.d64')).toBeVisible();
  await stubDialogs(app, { open: [join(prgDir, 'raster-demo.prg')] });
  await page.keyboard.press('Control+o');
  await expect(toast(page, 'Loaded raster-demo.prg at $0801')).toBeVisible();
  await stubDialogs(app, { open: [join(diskDir, 'mimir-demo.d64')] });
  await page.getByRole('button', { name: 'Mount D64…' }).click();
  await expect(toast(page, 'Mounted mimir-demo.d64')).toHaveCount(2);

  expect(await dialogOptions(app)).toEqual([
    { title: 'Open PRG files', defaultPath: undefined },
    { title: 'Mount D64 disk image', defaultPath: prgDir },
    { title: 'Open PRG files', defaultPath: prgDir },
    { title: 'Mount D64 disk image', defaultPath: diskDir },
  ]);
  // kept for the next start of the app
  expect(JSON.parse(readFileSync(join(userData, 'recent-folders.json'), 'utf8'))).toEqual({ prg: prgDir, disk: diskDir, last: diskDir });
});

test('merge a range into one block after confirming it', async ({ page }) => {
  await waitForListing(page);
  const headersIn = (rows: ListingRow[], from: number, to: number) => rows.filter(r => r.hdr && parseInt(r.adr, 16) >= from && parseInt(r.adr, 16) < to);
  const dialog = page.getByRole('dialog', { name: 'Merge range into one block' });
  const before = headersIn(await listingRows(page), 0x0939, 0x0ab5);
  expect(before.length).toBeGreaterThan(3);

  await test.step('in a block only the end is needed: the start and the type come from the block', async () => {
    await goTo(page, 'colors_0939');
    await page.keyboard.press('m');
    await expect(dialog).toContainText('The cursor is in the Table block at $0939 (colors_0939): the range starts there and the type is taken from it.');
    await expect(dialog.locator('#merge-start')).toHaveAttribute('placeholder', '$0939 (this block)');
    await expect(dialog.locator('#merge-type')).toHaveValue('table');
    await expect(dialog.getByRole('button', { name: 'Merge…' })).toBeDisabled();
    await dialog.locator('#merge-end').fill('$0ab4');
    await expect(dialog).toContainText(`${before.length} blocks become one Table (curve/values) block $0939–$0ab4 (380 bytes).`);
    await dialog.locator('#merge-type').selectOption('bytes');
    await expect(dialog).toContainText('one Bytes (.byte) block $0939–$0ab4');
  });

  await test.step('nothing changes before the summary is confirmed', async () => {
    await dialog.getByRole('button', { name: 'Merge…' }).click();
    await expect(dialog).toContainText('Merge $0939–$0ab4 into one Bytes (.byte) block?');
    await expect(dialog).toContainText(`This replaces ${before.length} blocks:`);
    await expect(dialog.locator('.merge-list li')).toHaveCount(before.length);
    await dialog.getByRole('button', { name: 'Back' }).click();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(headersIn(await listingRows(page), 0x0939, 0x0ab5)).toHaveLength(before.length);
  });

  await test.step('confirming replaces every block in the range with one', async () => {
    await page.keyboard.press('m');
    await dialog.locator('#merge-end').fill('$0ab4');
    await dialog.locator('#merge-type').selectOption('bytes');
    await dialog.locator('#merge-end').press('Enter');
    await dialog.getByRole('button', { name: `Merge ${before.length} blocks` }).click();
    await expect(toast(page, `Merged ${before.length} blocks into one Bytes (.byte) block $0939–$0ab4`)).toBeVisible();
    const after = headersIn(await listingRows(page), 0x0939, 0x0ab5);
    expect(after).toEqual([expect.objectContaining({ adr: '0939', chip: 'Data', user: true })]);
    expect(after[0].text).toContain('$0939-$0ab4 (380 bytes)');
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
    await page.keyboard.press('Control+z');
    await expect.poll(async () => headersIn(await listingRows(page), 0x0939, 0x0ab5).length).toBe(before.length);
  });

  await test.step('a range that cuts a block says so, and one outside the file is refused', async () => {
    await goTo(page, 'txt_0949');
    await page.keyboard.press('m');
    await dialog.locator('#merge-end').fill('$096f');
    await expect(dialog.locator('.merge-list.cut')).toContainText('is cut: $0970–$0984 keeps its type');
    await dialog.locator('#merge-end').fill('$3900');
    await expect(dialog).toContainText('runs past the end of the file at $3800');
    await expect(dialog.getByRole('button', { name: 'Merge…' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});

test('real addresses instead of the hardware include file', async ({ page }) => {
  await waitForListing(page);
  const rows = async () => (await listingRows(page)).map(r => r.text.trimStart());
  const has = async (text: string) => (await rows()).some(t => t.startsWith(text));
  const choose = async (value: 'import' | 'none') => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Kick Assembler output' }).click();
    await page.locator('#set-hwInclude').selectOption(value);
    await page.getByRole('button', { name: 'Save settings' }).click();
    // keys reach the listing once the dialog is gone (an earlier "Settings saved" toast may still be showing)
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
  };
  await goTo(page, '$0801');
  expect(await has('#import "include/c64-hardware.asm"')).toBe(true);
  await goTo(page, 'sub_0866');
  expect(await has('sta VIC_BORDER_COLOR')).toBe(true);

  await test.step('Settings → Real addresses writes $d020, keeps the comment and drops the #import', async () => {
    await choose('none');
    await goTo(page, 'sub_0866');
    await expect.poll(() => has('sta $d020')).toBe(true);
    const row = listing(page).locator('.row', { hasText: 'sta $d020' }).first();
    await expect(row).toContainText('Border color');
    await expect(row.locator('.link', { hasText: '$d020' })).toHaveAttribute('title', /VIC_BORDER_COLOR — Border color/);
    await goTo(page, '$0801');
    expect(await has('#import')).toBe(false);
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });

  await test.step('the names come back with the include file', async () => {
    await choose('import');
    await goTo(page, 'sub_0866');
    await expect.poll(() => has('sta VIC_BORDER_COLOR')).toBe(true);
  });
});

test('save a block as a binary file loaded with .import binary', async ({ workDir: work, app, page }) => {
  await waitForListing(page);
  const rows = async () => (await listingRows(page)).map(r => r.text.trimStart());
  const box = page.locator('.inspector').getByLabel('Save as a binary file');

  await test.step('the inspector saves the block as data/<label>.bin', async () => {
    await page.keyboard.press('Control+j');
    await goTo(page, 'sine_09b5');
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(toast(page, '$09b5–$0ab4 is saved as data/sine_09b5.bin and loaded with .import binary')).toBeVisible();
    await expect(headerRow(page, '09b5').locator('.hdr-binary')).toHaveText(/binary/i);
    await expect(headerRow(page, '09b5')).toContainText('data/sine_09b5.bin');
    await expect.poll(async () => (await rows()).some(t => t.startsWith('.import binary "data/sine_09b5.bin"'))).toBe(true);
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });

  await test.step('the export writes the file next to the source', async () => {
    const out = join(work, 'export');
    await stubDialogs(app, { open: [out] });
    await page.getByRole('button', { name: 'Export' }).click();
    await expect(toast(page, `Exported verified Kick Assembler project to ${out}`)).toBeVisible({ timeout: 90_000 });
    const bin = readFileSync(join(out, 'data', 'sine_09b5.bin'));
    const prg = readFileSync(join(repoDir, 'fixtures/prg/raster-demo.prg'));
    expect(bin.length).toBe(256);
    expect(bin.equals(prg.subarray(2 + 0x09b5 - 0x0801, 2 + 0x0ab5 - 0x0801))).toBe(true);
    expect(readFileSync(join(out, 'raster-demo.asm'), 'utf8')).toContain('.import binary "data/sine_09b5.bin"');
  });

  await test.step('unticking writes it in the source again', async () => {
    await box.uncheck();
    await expect(headerRow(page, '09b5').locator('.hdr-binary')).toHaveCount(0);
    await expect.poll(async () => (await rows()).some(t => t.startsWith('.import binary "data/sine_09b5.bin"'))).toBe(false);
  });
});

test('F7 right after an edit verifies that edit', async ({ page }) => {
  await waitForListing(page);
  // no waiting between the edit and F7: verification waits for the analysis of the edit itself
  for (const [range, key] of [['$091e-$0925', 'd'], ['$0960-$096f', 'w'], ['$0949-$0950', 't']] as const) {
    await goTo(page, range);
    await page.keyboard.press(key);
    await page.keyboard.press('F7');
    // the status must say so for this edit (a result for the state before it would show as stale: "not verified")
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
    await expect(headerRow(page, range.slice(1, 5)).locator('.hdr-user')).toBeVisible();
  }
});

test('rename a zero-page variable from its .label line', async ({ page }) => {
  await waitForListing(page);
  const rows = async () => (await listingRows(page)).map(r => r.text.trimStart());
  const has = async (text: string) => (await rows()).some(t => t.startsWith(text));
  const zpRow = (name: string) => listing(page).locator('.row', { hasText: `.label ${name} = $fb` });
  const editor = page.locator('.edit-pop');

  await test.step('the .label line is marked as zero page, and a double-click opens a marked editor', async () => {
    await goTo(page, '$0801');
    await expect(zpRow('ptr_fb').locator('.zp-tag')).toHaveText(/zero page/i);
    await zpRow('ptr_fb').dblclick();
    await expect(editor).toHaveClass(/zp/);
    await expect(editor.locator('label')).toContainText('Zero-page variable at $fb');
    await expect(editor.locator('.zp-tag')).toBeVisible();
    await expect(editor.locator('input')).toHaveValue('ptr_fb');
  });

  await test.step('a name in use is refused, a new one renames every access', async () => {
    await editor.locator('input').fill('start');
    await editor.locator('input').press('Enter');
    await expect(editor).toContainText('"start" is already used at $0810.');
    await editor.locator('input').fill('fx_ptr');
    await editor.locator('input').press('Enter');
    await expect(toast(page, 'Zero-page variable $fb renamed to fx_ptr; all references updated')).toBeVisible();
    await expect(zpRow('fx_ptr')).toHaveCount(1);
    await goTo(page, '$0905');
    await expect.poll(() => has('sta fx_ptr+1')).toBe(true);
    expect((await rows()).some(t => t.includes('ptr_fb'))).toBe(false);
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });

  await test.step('N and the context menu rename it too', async () => {
    await goTo(page, '$0801');
    await zpRow('fx_ptr').click();
    await page.keyboard.press('n');
    await expect(editor.locator('input')).toHaveValue('fx_ptr');
    await editor.locator('input').press('Escape');
    await zpRow('fx_ptr').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename zero-page variable…' }).click();
    await editor.locator('input').fill('');
    await editor.locator('input').press('Enter');
    await expect(toast(page, 'Zero-page variable $fb: automatic name restored')).toBeVisible();
    await expect(zpRow('ptr_fb')).toHaveCount(1);
  });
});

test('click the +offset after a label to go to label + offset', async ({ page }) => {
  await waitForListing(page);
  await page.keyboard.press('Control+j');
  await goTo(page, 'smc_08ef');
  const row = () => listing(page).locator('.row', { hasText: 'inc smc_08ef+1' });
  await expect(row().locator('.link.offset')).toHaveAttribute('title', 'Go to $08f0 (smc_08ef+1)');
  // the label still goes to the label, the offset to the byte it names
  await row().locator('.link', { hasText: /^smc_08ef$/ }).click();
  await expect(statusBar(page)).toContainText('$08ef · smc_08ef');
  await row().locator('.link.offset').click();
  await expect(statusBar(page)).toContainText('$08f0 · smc_08ef+1');
});

test('bookmarks: notes on addresses, listed by address, a click shows the note and a double-click goes there', async ({ page }) => {
  await waitForListing(page);
  await page.keyboard.press('Control+j');
  const at = (adr: string) => listing(page).locator('.row', { has: page.locator('.adr', { hasText: new RegExp(`^${adr}$`) }) });
  const mark = (adr: string) => at(adr).locator('.bm-mark');
  const list = page.getByRole('list', { name: 'Bookmarks' });
  const item = (title: string) => list.locator('.bm-row', { hasText: title });

  await test.step('B opens the editor in the sidebar, beside the code, titled after the label', async () => {
    await goTo(page, 'start');
    await page.keyboard.press('b');
    const dialog = page.locator('aside.sidebar').getByRole('form', { name: 'Add bookmark' });
    await expect(dialog.getByLabel('Address', { exact: true })).toHaveValue('$0810');
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('start');
    await expect(dialog.getByLabel('Title', { exact: true })).toBeFocused();
    // the code stays in view: the bookmarked line and the editor do not overlap
    const code = listing(page).locator('.row', { hasText: 'jsr CLRSCR' });
    await expect(code).toBeVisible();
    const [box, line] = [await dialog.boundingBox(), await code.boundingBox()];
    expect(box!.x + box!.width).toBeLessThanOrEqual(line!.x);
    // a click in the listing and Cursor line take another place; Esc closes the editor without saving
    await listing(page).locator('.row', { hasText: 'jsr sub_0866' }).click();
    await dialog.getByRole('button', { name: 'Cursor line' }).click();
    await expect(dialog.getByLabel('Address', { exact: true })).toHaveValue('$0813');
    await dialog.getByLabel('Title', { exact: true }).press('Escape');
    await expect(dialog).toBeHidden();
    await expect(mark('0813')).toHaveCount(0);
    await goTo(page, 'start');
    await page.keyboard.press('b');
    // a bookmark marks a place in the code
    await dialog.getByLabel('Address', { exact: true }).fill('$0001');
    await expect(dialog.getByText('No loaded byte at $0001')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    await dialog.getByLabel('Address', { exact: true }).fill('$0810');
    await dialog.getByLabel('Title', { exact: true }).fill('Set up');
    await dialog.getByLabel('Note', { exact: true }).fill('clears the screen\nand starts the raster IRQ');
    await dialog.getByLabel('Note', { exact: true }).press('Control+Enter');
    await expect(dialog).toBeHidden();
    await expect(mark('0810')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Bookmarks', exact: true })).toContainText('1');
  });

  await test.step('right-click → Add bookmark… on another line', async () => {
    await goTo(page, 'sine_09b5');
    await listing(page).locator('.row.k-dat', { has: page.locator('.adr', { hasText: /^09b5$/ }) }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add bookmark…' }).click();
    const dialog = page.getByRole('form', { name: 'Add bookmark' });
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('sine_09b5');
    await dialog.getByLabel('Title', { exact: true }).press('Enter');
    await expect(dialog).toBeHidden();
    await expect(mark('09b5')).toHaveCount(1);
  });

  await test.step('Ctrl+B lists them by address; a click shows the whole note, another click hides it', async () => {
    await listing(page).focus();
    await page.keyboard.press('Control+b');
    await expect(list.locator('.bm-row')).toHaveText(['$0810Set up', '$09b5sine_09b5']);
    await expect(list.locator('.bm-text')).toHaveCount(0);
    await item('Set up').click();
    await expect(list.locator('.bm-text')).toContainText('clears the screen');
    await expect(list.locator('.bm-text')).toContainText('and starts the raster IRQ');
    await item('Set up').click();
    await expect(list.locator('.bm-text')).toHaveCount(0);
  });

  await test.step('a double-click goes there in the code', async () => {
    await goTo(page, 'start');
    await expect(statusBar(page)).toContainText('$0810');
    await item('sine_09b5').dblclick();
    await expect(statusBar(page)).toContainText('$09b5 · sine_09b5');
    await expect(list.locator('.bm-item.open')).toContainText('No note');
  });

  await test.step('F2 and Shift+F2 go to the next and the previous bookmark', async () => {
    await page.keyboard.press('F2');
    await expect(statusBar(page)).toContainText('$0810 · start');
    await page.keyboard.press('F2');
    await expect(statusBar(page)).toContainText('$09b5 · sine_09b5');
    await page.keyboard.press('Shift+F2');
    await expect(statusBar(page)).toContainText('$0810 · start');
  });

  await test.step('the mark in the margin opens the note in the list', async () => {
    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await expect(list).toBeHidden();
    await mark('0810').click();
    await expect(list.locator('.bm-item.open')).toContainText('clears the screen');
  });

  await test.step('B on a bookmarked line edits it; Delete removes it and Ctrl+Z brings it back', async () => {
    await goTo(page, 'start');
    await page.keyboard.press('b');
    const dialog = page.getByRole('form', { name: 'Edit bookmark' });
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Set up');
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(dialog).toBeHidden();
    await expect(mark('0810')).toHaveCount(0);
    await expect(list.locator('.bm-row')).toHaveText(['$09b5sine_09b5']);
    await page.keyboard.press('Control+z');
    await expect(mark('0810')).toHaveCount(1);
    await expect(list.locator('.bm-row')).toHaveCount(2);
  });
});

test('the export writes NOTES.html, or NOTES.txt when set, with the bookmarks and comments', async ({ workDir: work, app, page }) => {
  await waitForListing(page);
  await page.keyboard.press('Control+j');
  await goTo(page, 'start');
  await page.keyboard.press('b');
  await page.locator('#bm-title').fill('Set up');
  await page.locator('#bm-text').fill('clears the screen\nand starts the <raster> IRQ');
  await page.locator('#bm-text').press('Control+Enter');
  await page.keyboard.press('/');
  await page.getByLabel('Comment line above $0810').fill('entry from the BASIC stub');
  await page.getByLabel('Comment line above $0810').press('Enter');

  const out = join(work, 'export');
  await stubDialogs(app, { open: [out] });
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(toast(page, `Exported verified Kick Assembler project to ${out}`)).toBeVisible({ timeout: 90_000 });
  const doc = readFileSync(join(out, 'NOTES.html'), 'utf8');
  const src = readFileSync(join(out, 'raster-demo.asm'), 'utf8');
  const line = src.split('\n').findIndex(l => l.trimStart().startsWith('jsr CLRSCR')) + 1;
  expect(doc).toContain('<h3>Set up</h3>');
  expect(doc).toContain('clears the screen\nand starts the &lt;raster&gt; IRQ');
  expect(doc).toContain(`raster-demo.asm, line ${line}`);
  expect(doc).toMatch(/<dt>Exported<\/dt><dd>\d{4}-\d\d-\d\d \d\d:\d\d<\/dd>/);
  expect(doc).toContain('<span class="tag">Comment line</span>');
  expect(doc).toContain('entry from the BASIC stub');
  // the bookmark is not in the source, the comment is
  expect(src).not.toContain('Set up');
  expect(src).toContain('// entry from the BASIC stub');
  expect(readFileSync(join(out, 'README.md'), 'utf8')).toContain('NOTES.html');

  await test.step('Settings → NOTES.txt writes the plain-text document instead', async () => {
    await page.keyboard.press('Control+,');
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: 'Kick Assembler output' }).click();
    await dialog.getByLabel('Bookmarks and comments in the export').selectOption('txt');
    await dialog.getByRole('button', { name: 'Save settings' }).click();
    await expect(dialog).toBeHidden();
    const out2 = join(work, 'export-txt');
    await stubDialogs(app, { open: [out2] });
    await page.getByRole('button', { name: 'Export' }).click();
    await expect(toast(page, `Exported verified Kick Assembler project to ${out2}`)).toBeVisible({ timeout: 90_000 });
    expect(existsSync(join(out2, 'NOTES.html'))).toBe(false);
    const txt = readFileSync(join(out2, 'NOTES.txt'), 'utf8');
    expect(txt.startsWith('raster-demo: bookmarks and comments\n')).toBe(true);
    expect(txt).toContain(`$0810  Set up\n  start · Code · start · $0810-$0865 (86 bytes) · raster-demo.asm, line ${line}`);
    expect(txt).toContain('  clears the screen\n  and starts the <raster> IRQ');
    expect(txt).toMatch(new RegExp(`^  > +${line}  0810  20 44 e5 +jsr CLRSCR`, 'm'));
    expect(txt).toContain('Comment line');
    expect(readFileSync(join(out2, 'README.md'), 'utf8')).toContain('NOTES.txt');
  });
});

test('the installed app comes with unp64, and the unpacker setting points to it', async ({ app, page }) => {
  // only an installed (packaged) app has resources\unp64: run with MIMIR_E2E_EXE
  const installed = process.env.MIMIR_E2E_EXE;
  test.skip(!installed, 'needs the installed app (MIMIR_E2E_EXE)');
  const exe = join(dirname(installed!), 'resources', 'unp64', 'unp64.exe');
  expect(existsSync(exe)).toBe(true);
  expect(existsSync(join(dirname(exe), 'unp64.txt'))).toBe(true);
  await waitForListing(page);

  await test.step('a fresh profile uses the bundled unp64', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('#set-unpackerPath')).toHaveValue(exe);
    await expect(page.locator('#set-unpackerArgs')).toHaveValue('{in}');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await test.step('it unpacks the packed demo', async () => {
    await stubDialogs(app, { open: [join(repoDir, 'fixtures/prg/packed-demo.prg')] });
    await page.keyboard.press('Control+o');
    const bar = page.locator('.pack-bar');
    await bar.getByRole('button', { name: 'Unpack with unp64' }).click();
    await expect(toast(page, /^Unpacked packed-demo\.prg: \d+ bytes at \$0[0-9a-f]{3}-\$[0-9a-f]{4}/)).toBeVisible({ timeout: 30_000 });
    const done = page.locator('.unpack-bar');
    await expect(done).toContainText('starting at $0810 (set as the program start).');
    await expect(done.locator('.unpack-log')).toContainText('return to mem: $0810');
    await expect(page.locator('.file-name')).toHaveText(['packed-demo-unpacked.prg']);
  });
});

test('timing code: a delay a timer sets the branch into is marked, and what it reads gets no label', async ({ workDir: work, app, page }) => {
  // 10 SYS2061, then lda $dc06 / eor #$07 / sta smc+1 / smc: bpl * / lda #$a9 / lda #$a9 / lda $eaa5 / rts, loaded
  // up to $eaff so that $eaa5 is part of the program
  const prg = new Uint8Array(2 + 0xeb00 - 0x0801);
  prg.set([0x01, 0x08]);
  prg.set([0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00], 2);
  prg.set([0xad, 0x06, 0xdc, 0x49, 0x07, 0x8d, 0x16, 0x08, 0x10, 0x00, 0xa9, 0xa9, 0xa9, 0xa9, 0xad, 0xa5, 0xea, 0x60], 2 + 0x080d - 0x0801);
  const file = join(work, 'stable.prg');
  writeFileSync(file, prg);
  await waitForListing(page);
  await stubDialogs(app, { open: [file] });
  await page.keyboard.press('Control+o');
  await expect(toast(page, 'Loaded stable.prg at $0801')).toBeVisible();
  await goTo(page, '$0815');
  const rows = listing(page);
  await expect(rows.locator('.row', { hasText: 'bpl delay_0817' })).toContainText('0-7 bytes into the delay, by CIA1_TB_LO ($dc06)');
  await expect(rows.locator('.row.k-cmt', { hasText: 'delay: the bpl at $0815 goes 0-7 bytes into it by CIA1_TB_LO ($dc06), so it takes 8 down to 0 cycles' })).toBeVisible();
  await expect(rows.locator('.row.delay')).toHaveCount(3);
  await expect(rows.locator('.row.delay .delay-tag')).toHaveCount(3);
  await expect(rows.locator('.row.delay', { hasText: 'lda $eaa5' })).toBeVisible();
  await expect(rows.locator('.row', { hasText: 'data_eaa5' })).toHaveCount(0);
  await page.keyboard.press('F7');
  await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
});

test('Problems warns when bank tracking is off and I/O is written as labels, and turns it on', async ({ workDir: work, app, page }) => {
  // a memory dump from $0801 over $d000-$d02f: 10 SYS2061, then lda #$00 / sta $d020 / sta $d021 / rts
  const prg = new Uint8Array(2 + 0xd030 - 0x0801);
  prg.set([0x01, 0x08]);
  prg.set([0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00], 2);
  prg.set([0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x8d, 0x21, 0xd0, 0x60], 2 + 0x080d - 0x0801);
  const file = join(work, 'dump.prg');
  writeFileSync(file, prg);
  await waitForListing(page);
  await stubDialogs(app, { open: [file] });
  await page.keyboard.press('Control+o');
  await expect(toast(page, 'Loaded dump.prg at $0801')).toBeVisible();
  const border = listing(page).locator('.row', { hasText: /sta (VIC_BORDER_COLOR|\S+_d020)\b/ });

  await test.step('with bank tracking off the registers become labels, and Problems says why', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('tab', { name: 'Analysis', exact: true }).click();
    await page.getByLabel('Follow the memory configuration ($01) and VIC bank').uncheck();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
    await goTo(page, '$080d');
    await expect(border).toContainText(/sta \w+_d020/);
    await page.getByRole('tab', { name: /Problems/ }).click();
    const row = page.locator('.loglist .logrow', { hasText: 'Bank tracking is off' });
    await expect(row).toContainText('accesses to 2 I/O addresses inside the loaded bytes are written as labels');
    await expect(row.locator('.addr-link')).toHaveText('$d020');
  });

  await test.step('Turn on names them as registers again, and Ctrl+Z undoes it', async () => {
    const row = page.locator('.loglist .logrow', { hasText: 'Bank tracking is off' });
    await row.getByRole('button', { name: 'Turn on' }).click();
    await expect(toast(page, 'Following the memory configuration ($01) and VIC bank')).toBeVisible();
    await expect(row).toHaveCount(0);
    await expect(border).toContainText('sta VIC_BORDER_COLOR');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('tab', { name: 'Analysis', exact: true }).click();
    await expect(page.getByLabel('Follow the memory configuration ($01) and VIC bank')).toBeChecked();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.keyboard.press('Control+z');
    await expect(page.locator('.loglist .logrow', { hasText: 'Bank tracking is off' })).toHaveCount(1);
  });
});

test('cycle counting: cycles per line, a block\'s total, and branches taken or not', async ({ page }) => {
  await waitForListing(page);
  await page.keyboard.press('Control+j');
  const toggle = page.getByRole('button', { name: 'Cycles' });
  const row = (text: string) => listing(page).locator('.row', { hasText: text });
  const section = page.getByRole('region', { name: 'Cycles' });

  await test.step('the Cycles button shows the cycles of every instruction', async () => {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await goTo(page, 'irq_08b7');
    await expect(row('inc VIC_IRQ_STATUS').locator('.cy-n')).toHaveText('6');
    await expect(row('lda colors_0939,y').locator('.cy-n')).toHaveText('4+');
    await expect(row('beq loop_08c2').locator('.cy-br')).toHaveText('2/3');
  });

  await test.step('a block header counts the block; a taken forward branch skips lines and changes the total', async () => {
    await goTo(page, 'sub_0866');
    await headerRow(page, '0866').click();
    await expect(section).toContainText('$0866–$08ad');
    await expect(section.locator('.cyc-total b')).toHaveText('104');
    await expect(statusBar(page)).toContainText('104 cycles');
    const beq = row('beq skip_0895').locator('.cy-br');
    await expect(beq).toHaveAttribute('aria-pressed', 'false');
    await expect(section).toContainText('taken: 95');
    await beq.click();
    await expect(beq).toHaveAttribute('aria-pressed', 'true');
    await expect(section.locator('.cyc-total b')).toHaveText('95');
    await expect(section).toContainText('104 with no branch taken');
    await expect(statusBar(page)).toContainText('95 cycles');
    await expect(section.getByLabel('Branch at $088d taken')).toBeChecked();
    // the lines the branch jumps over are not counted
    await expect(listing(page).locator('.row.cy-skip').first()).toBeVisible();
    // the box in the inspector does the same: back to not taken
    await section.getByLabel('Branch at $088d taken').uncheck();
    await expect(section.locator('.cyc-total b')).toHaveText('104');
    await expect(listing(page).locator('.row.cy-skip')).toHaveCount(0);
  });

  await test.step('turned off, the column and the section go away', async () => {
    await toggle.click();
    await expect(listing(page).locator('.cyc')).toHaveCount(0);
    await expect(section).toHaveCount(0);
  });
});

test('open a VICE snapshot like a PRG', async ({ app, page }) => {
  // fixtures/vsf/raster-demo.vsf: x64sc 3.10 stopped in the demo's raster IRQ ($08c7)
  await waitForListing(page);
  await stubDialogs(app, { open: [join(repoDir, 'fixtures/vsf/raster-demo.vsf')] });
  await page.getByRole('button', { name: 'Open PRG…' }).click();
  await expect(toast(page, 'Loaded raster-demo.prg at $0200 from a VICE 3.10 snapshot of a C64SC, PC $08c7, $01 = $37; traced from $08c7, $08b7; program start $0810')).toBeVisible();
  await expect(page.locator('.file-row', { hasText: 'raster-demo.prg' })).toContainText('$0200–$ffff');
  // the BASIC stub inside the RAM is the program start the analysis traces from; Build & Run restarts the snapshot
  const start = page.locator('.side-sec', { hasText: 'Program start' });
  await expect(start).toContainText(/\$0810\s*start/);
  await expect(start).toContainText('set by you');
  await expect(start).toContainText('VICE restarts the snapshot as it was taken (PC $08c7, $01 = $37); the start is for the analysis');
  await goTo(page, 'irq_08b7');
  await expect(statusBar(page)).toContainText('$08b7 · irq_08b7');
  await page.keyboard.press('F7');
  await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });

  await test.step('with the setting, the zero page and the stack come along: from $0002', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('tab', { name: 'Analysis', exact: true }).click();
    await settings.getByLabel('VICE snapshots: include the zero page and the stack').check();
    await settings.getByRole('button', { name: 'Save settings' }).click();
    await expect(settings).toBeHidden();
    await stubDialogs(app, { open: [join(repoDir, 'fixtures/vsf/raster-demo.vsf')] });
    await page.getByRole('button', { name: 'Open PRG…' }).click();
    await expect(toast(page, 'Loaded raster-demo.prg at $0002 from a VICE 3.10 snapshot')).toBeVisible();
    await expect(page.locator('.file-row', { hasText: 'raster-demo.prg' })).toContainText('$0002–$ffff');
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });
});

test('deep analysis from the Problems tab: a snapshot\'s ROM calls are not traced into the RAM below', async ({ app, page }) => {
  // the snapshot's RAM covers the KERNAL and BASIC ROM: the normal analysis traces their calls into it
  await waitForListing(page);
  await stubDialogs(app, { open: [join(repoDir, 'fixtures/vsf/raster-demo.vsf')] });
  await page.getByRole('button', { name: 'Open PRG…' }).click();
  await expect(toast(page, 'Loaded raster-demo.prg at $0200')).toBeVisible();
  const tab = page.getByRole('tab', { name: /Problems/ });
  await tab.click();
  await expect(tab.locator('.count')).toHaveText('4');
  await expect(page.locator('.loglist .logrow', { hasText: 'BRK at $ffd2 ends the code path' })).toBeVisible();
  const result = page.getByRole('status', { name: 'Deep analysis result' });
  await expect(result).toContainText('analyses again until the problems are at a minimum');

  await page.getByRole('checkbox', { name: 'Deep analysis' }).check();
  await expect(result).toHaveText(/^4 → 0 problems in 3 rounds, \d+\.\d s · the Log tells what it left out$/, { timeout: 30_000 });
  await expect(tab.locator('.count')).toHaveText('0');
  await expect(page.locator('.bottom-body')).toContainText('No problems found.');
  await page.getByRole('tab', { name: /Analysis log/ }).click();
  await expect(page.locator('.loglist .logrow', { hasText: 'The JSR at $088f to $ffd2 reaches the KERNAL ROM there, so the RAM below it is not traced' })).toBeVisible();
  await page.keyboard.press('F7');
  await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });

  // the setting is the project's, in Settings too; off again, the problems are back
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Analysis', exact: true }).click();
  await expect(settings.getByLabel('Deep analysis (slower)')).toBeChecked();
  await settings.getByLabel('Deep analysis (slower)').uncheck();
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(tab.locator('.count')).toHaveText('4');
});

test('the Graphics tab keeps the address you scrolled to at the top when the view changes', async ({ page }) => {
  await waitForListing(page);
  await page.getByRole('tab', { name: 'Graphics' }).click();
  const view = page.getByLabel('Memory as graphics'), scroller = view.locator('.gfxv-scroll');
  // the address of the gutter row at the top of the picture
  const top = () => scroller.evaluate(el => {
    const rows = [...el.querySelectorAll<HTMLElement>('.gfxv-row')];
    return rows.find(r => r.offsetTop <= el.scrollTop + 1 && r.offsetTop + r.offsetHeight > el.scrollTop + 1)?.dataset.addr ?? null;
  });
  const mode = (name: string) => view.getByRole('button', { name, exact: true }).click();

  // 40 characters of 8 bytes at zoom 2: a row is 320 bytes and 16 pixels, so 1600 pixels down is $7d00
  await scroller.evaluate(el => { el.scrollTop = 1600; });
  await expect.poll(top).toBe('7d00');
  await mode('Sprites');
  await expect.poll(async () => { const a = parseInt((await top()) ?? '-1', 16); return a <= 0x7d00 && a > 0x7d00 - 0x800; }).toBe(true);
  await mode('Bitmaps');
  await expect.poll(top).toBe('6000');
  await mode('Screens');
  await expect.poll(top).toBe('7c00');
  // back from them all, at the same row as before
  await mode('Characters');
  await expect.poll(top).toBe('7d00');
  await view.getByLabel('Cells per row').selectOption('16');
  await expect.poll(top).toBe('7d00');
  // scrolling sets a new one: 16 characters a row are 128 bytes
  await scroller.evaluate(el => { el.scrollTop = 160; });
  await expect.poll(top).toBe('0500');
  await mode('Sprites');
  await mode('Characters');
  await expect.poll(top).toBe('0500');
});

test('the Graphics tab shows memory as characters, sprites or bitmaps, and marks what it finds', async ({ page }) => {
  await waitForListing(page);
  await page.keyboard.press('Control+j');
  await page.getByRole('tab', { name: 'Graphics' }).click();
  const view = page.getByLabel('Memory as graphics');
  const go = async (to: string) => { await view.getByLabel('Go to address, label or range').fill(to); await view.getByLabel('Go to address, label or range').press('Enter'); };
  const sel = view.getByRole('status');
  const canvas = view.locator('.gfxv-canvas');

  await test.step('characters: go to $3000, take the whole 2 KB charset and mark it', async () => {
    await expect(view.getByRole('button', { name: 'Characters' })).toHaveAttribute('aria-pressed', 'true');
    // 40 characters a row (a screen's width) by default
    await expect(view.getByLabel('Cells per row')).toHaveValue('40');
    await go('$3000');
    await expect(sel).toContainText('$3000–$3007 (8 bytes) · Charset charset_3000');
    await view.getByRole('button', { name: 'Whole charset (2 KB)' }).click();
    await expect(sel).toContainText('$3000–$37ff (2048 bytes)');
    // character 1536 is column 16 of a row: 24, 5 rows of 40 and 32 characters
    await expect(canvas.locator('.gfxv-selrect')).toHaveCount(7);
    await view.getByRole('button', { name: 'Mark as Charset' }).click();
    await expect(toast(page, '$3000–$37ff marked as Charset')).toBeVisible();
  });

  await test.step('characters per row: 16, 32, 40 or 64, or any count typed in after Other…', async () => {
    const picture = canvas.locator('canvas');
    await expect(picture).toHaveCSS('width', `${40 * 8 * 2}px`);
    await view.getByLabel('Cells per row').selectOption('other');
    const count = view.getByLabel('Characters per row');
    await count.fill('48');
    await count.press('Enter');
    await expect(picture).toHaveCSS('width', `${48 * 8 * 2}px`);
    await count.press('ArrowDown');
    await expect(picture).toHaveCSS('width', `${47 * 8 * 2}px`);
    // a count outside 1-128 is not taken
    await count.fill('500');
    await count.press('Enter');
    await expect(count).toHaveClass(/bad/);
    await expect(picture).toHaveCSS('width', `${47 * 8 * 2}px`);
    await view.getByLabel('Cells per row').selectOption('16');
    await expect(count).toBeHidden();
    await expect(picture).toHaveCSS('width', `${16 * 8 * 2}px`);
    await view.getByLabel('Cells per row').selectOption('40');
  });

  await test.step('sprites: a click selects a sprite, Shift+click more; hovering names its sprite pointer', async () => {
    await view.getByRole('button', { name: 'Sprites', exact: true }).click();
    await go('$2000');
    const box = (await canvas.boundingBox())!;
    // 8 sprites per row at zoom 2: $2000 is row 16, column 0; $2040 column 1
    const at = (col: number, row: number) => ({ x: box.x + (col * 26 + 12) * 2, y: box.y + (row * 23 + 10) * 2 });
    await page.mouse.move(at(0, 16).x, at(0, 16).y);
    await expect(view.locator('.gfxv-info')).toContainText('sprite pointer $80 in VIC bank 0 · Sprites spr_2000');
    await page.mouse.click(at(0, 16).x, at(0, 16).y);
    await expect(sel).toContainText('$2000–$203f (64 bytes)');
    await page.keyboard.down('Shift');
    await page.mouse.click(at(1, 16).x, at(1, 16).y);
    await page.keyboard.up('Shift');
    await expect(sel).toContainText('$2000–$207f (128 bytes)');
    await view.getByRole('button', { name: 'Mark as Sprite data' }).click();
    await expect(toast(page, '$2000–$207f marked as Sprite data')).toBeVisible();
  });

  await test.step('bitmaps: 8 KB frames; Show in listing goes there, and the marks verify', async () => {
    await view.getByRole('button', { name: 'Bitmaps' }).click();
    await go('$2000');
    await expect(sel).toContainText('$2000–$3f3f (8000 bytes)');
    await view.getByRole('button', { name: 'Show in listing' }).click();
    await expect(page.getByRole('tab', { name: 'Listing' })).toHaveAttribute('aria-selected', 'true');
    await expect(headerRow(page, '2000').locator('.hdr-user')).toBeVisible();
    await expect(headerRow(page, '2000')).toContainText('Sprite');
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });
});

test('edit build.bat in the source view: the export writes it, Restore generated takes it back', async ({ workDir: work, app, page }) => {
  await waitForListing(page);
  await page.getByRole('tab', { name: 'raster-demo.asm' }).click();
  const file = page.getByLabel('File', { exact: true });
  const note = page.locator('.source .tb-note');
  const editor = page.locator('.mon-host .view-lines');
  await expect(editor).toBeVisible();
  await expect(note).toContainText('read-only');

  await test.step('build.bat can be edited, and the edit is kept in the project', async () => {
    await file.selectOption('build.bat');
    await expect(note).toContainText('Editable');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('rem my own step');
    await expect(note).toContainText('Edited by you');
    await expect(page.getByRole('button', { name: 'Restore generated' })).toBeVisible();
  });

  await test.step('the export writes it; build.sh stays generated', async () => {
    const out = join(work, 'export');
    await stubDialogs(app, { open: [out] });
    await page.getByRole('button', { name: 'Export…', exact: true }).click();
    await expect(toast(page, `Exported verified Kick Assembler project to ${out}`)).toBeVisible({ timeout: 90_000 });
    expect(readFileSync(join(out, 'build.bat'), 'utf8')).toMatch(/\r?\nrem my own step$/);
    expect(readFileSync(join(out, 'build.sh'), 'utf8')).toContain('# Build script generated by Mimir Studio');
    expect(readFileSync(join(out, 'raster-demo.mimir.json'), 'utf8')).toContain('rem my own step');
  });

  await test.step('the source stays read-only; Restore generated brings the generated script back', async () => {
    await file.selectOption('raster-demo.asm');
    await expect(note).toContainText('read-only');
    await file.selectOption('build.bat');
    await page.getByRole('button', { name: 'Restore generated' }).click();
    await expect(toast(page, 'build.bat is generated again from the toolchain settings')).toBeVisible();
    await expect(editor).not.toContainText('rem my own step');
    await expect(note).toContainText('Editable');
  });
});

test('pack with Exomizer: the whole build or chosen blocks, checked with desfx, saved with a dialog', async ({ workDir: work, app, page }) => {
  await waitForListing(page);
  const view = page.locator('.pack-view');
  const cmd = view.getByLabel('Exomizer command');
  const card = view.getByRole('status', { name: 'Packed file' });

  await test.step('Settings points at an Exomizer (the installed app at its own)', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const installed = process.env.MIMIR_E2E_EXE;
    if (installed) await expect(page.locator('#set-exomizerPath')).toHaveValue(join(dirname(installed), 'resources', 'exomizer', 'exomizer.exe'));
    else await expect(page.locator('#set-exomizerPath')).toHaveValue(/exomizer(\.exe)?$/i);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  await test.step('the whole build: the Pack view shows the command, Pack builds, packs and checks it', async () => {
    await page.locator('nav.activity').getByRole('button', { name: 'Pack' }).click();
    await expect(cmd).toHaveText(/^exomizer(\.exe)? sfx sys -o raster-demo-exo\.prg raster-demo\.prg$/);
    await view.getByRole('button', { name: 'Pack', exact: true }).click();
    await expect(card).toContainText('raster-demo-exo.prg', { timeout: 90_000 });
    await expect(card).toContainText(/Decrunched by desfx: \$0801–\$[0-9a-f]{4} has the same \d+ bytes, and it starts at \$0810/);
    await expect(card).toContainText('Decrunched data');
    await expect(toast(page, /^Packed \d+ bytes into raster-demo-exo\.prg \(\d+ bytes\), decrunch verified/)).toBeVisible();
    await page.getByRole('tab', { name: 'Build output' }).click();
    await expect(page.locator('.build-log')).toContainText(/> "?[^\n]*exomizer(\.exe)?"? sfx sys -o raster-demo-exo\.prg raster-demo\.prg/i);
  });

  await test.step('Save as… writes the packed PRG', async () => {
    const saved = join(work, 'release.prg');
    await stubDialogs(app, { save: saved });
    await card.getByRole('button', { name: 'Save as…' }).click();
    await expect(toast(page, `Saved ${saved}`)).toBeVisible();
    const b = readFileSync(saved);
    expect([b[0], b[1]]).toEqual([0x01, 0x08]);
    expect((await dialogOptions(app)).pop()).toMatchObject({ title: 'Save the packed file', defaultPath: expect.stringMatching(/raster-demo-exo\.prg$/) });
  });

  await test.step('chosen blocks: from the listing, a selection and ticks, jumping to the code, packed again', async () => {
    const ranges = view.getByRole('list', { name: 'Ranges to pack' });
    await view.getByRole('tab', { name: 'Chosen blocks' }).click();
    await expect(view).toContainText('Nothing chosen yet');
    await expect(view.getByRole('button', { name: 'Pack', exact: true })).toBeDisabled();
    await expect(card).toContainText('Out of date');
    // the code block at $0810 from the listing's menu
    await headerRow(page, '0810').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pack block with Exomizer' }).click();
    await expect(toast(page, /is packed with the chosen blocks/)).toBeVisible();
    await expect(ranges).toHaveText('$0810–$0865');
    // without the BASIC line there is no SYS to start from
    await expect(view.getByText(/The chosen blocks leave out the BASIC line/)).toBeVisible();
    // the rest of the program as a selection in the listing
    await goTo(page, '$0810-$37ff');
    await view.getByRole('button', { name: /^Selection \$0810–\$37ff$/ }).click();
    await expect(ranges).toHaveText('$0810–$37ff');
    // a block unticked and ticked again
    await view.getByRole('checkbox', { name: 'Pack $0810-$0865' }).uncheck();
    await expect(ranges).toHaveText('$0866–$37ff');
    await view.getByRole('checkbox', { name: 'Pack $0810-$0865' }).check();
    await expect(ranges).toHaveText('$0810–$37ff');
    await view.getByLabel('Start after decrunching').selectOption('jmp');
    await expect(view.getByLabel('Jump to')).toHaveValue('$0810');
    await view.getByLabel('Effect while decrunching').selectOption('none');
    await expect(cmd).toHaveText(/ sfx \$0810 -n -o raster-demo-exo\.prg raster-demo\.prg,\$0810,15,12272$/);
    await view.getByRole('button', { name: 'Pack', exact: true }).click();
    await expect(card).toContainText('Decrunched by desfx: $0810–$37ff has the same 12272 bytes, and it starts at $0810', { timeout: 90_000 });
    await expect(card).not.toContainText('Out of date');
  });

  await test.step('the pack settings are undoable and kept in the project', async () => {
    await listing(page).click();
    await page.keyboard.press('Control+z');
    await expect(cmd).toHaveText(/ sfx \$0810 -o /);
    const out = join(work, 'packed.mimir.json');
    await stubDialogs(app, { save: out });
    await page.keyboard.press('Control+s');
    await expect(toast(page, `Project saved to ${out}`)).toBeVisible();
    expect(JSON.parse(readFileSync(out, 'utf8')).pack).toMatchObject({ mode: 'sfx', start: 'jmp', jmp: 0x0810, effect: 'default' });
  });
});

test('comment a zero-page variable on its .label line, with the keys, the menu and the inspector', async ({ page }) => {
  await waitForListing(page);
  const zpRow = () => listing(page).locator('.row', { hasText: '.label ptr_fb = $fb' });
  const editor = page.locator('.edit-pop');
  const insp = page.getByRole('region', { name: 'Zero-page variable' });
  const rowsAbove = async () => {
    const all = (await listingRows(page)).map(r => r.text.trim());
    const i = all.findIndex(t => t.startsWith('.label ptr_fb = $fb'));
    return { line: all[i], above: all.slice(Math.max(0, i - 3), i) };
  };

  await test.step('; comments the end of the .label line', async () => {
    await goTo(page, '$0801');
    await zpRow().click();
    await expect(insp).toBeVisible();
    await expect(insp).toContainText('$fb');
    await page.keyboard.press(';');
    await expect(editor).toHaveClass(/zp/);
    await expect(editor.locator('label')).toContainText('Comment at $fb');
    await editor.locator('input').fill('screen pointer');
    await editor.locator('input').press('Enter');
    await expect(zpRow().locator('.cmt.user')).toHaveText('// screen pointer');
  });

  await test.step('/ adds a comment line above it, and the inspector shows both', async () => {
    await zpRow().click();
    await page.keyboard.press('/');
    await expect(editor.locator('label')).toContainText('Comment line above $fb');
    await editor.locator('input').fill('set by the raster irq');
    await editor.locator('input').press('Enter');
    await expect.poll(async () => (await rowsAbove()).above.at(-1)).toBe('// set by the raster irq');
    await zpRow().click();
    await expect(insp.getByLabel('Comment above the .label line')).toHaveValue('set by the raster irq');
    await expect(insp.getByLabel('Comment at the end of the .label line')).toHaveValue('screen pointer');
  });

  await test.step('the inspector edits them like a block comment', async () => {
    await insp.getByLabel('Comment above the .label line').fill('set by the raster irq\nread by the scroller');
    await insp.getByLabel('Comment at the end of the .label line').click();
    await expect.poll(async () => (await rowsAbove()).above.slice(-2)).toEqual(['// set by the raster irq', '// read by the scroller']);
    await insp.getByLabel('Comment at the end of the .label line').fill('points at the screen');
    await insp.getByLabel('Comment at the end of the .label line').press('Enter');
    await expect(zpRow().locator('.cmt.user')).toHaveText('// points at the screen');
  });

  await test.step('the menu on the .label line edits the comment block, and the export verifies', async () => {
    await zpRow().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Insert comment block above the .label line…' }).click();
    await expect(editor.locator('label')).toContainText('Comment block above $fb');
    await expect(editor.locator('textarea')).toHaveValue('set by the raster irq\nread by the scroller');
    await editor.locator('textarea').press('Escape');
    await page.getByRole('tab', { name: 'raster-demo.asm' }).click();
    await expect(page.locator('.mon-host .view-lines')).toContainText('.label ptr_fb = $fb');
    await page.getByRole('tab', { name: 'Listing' }).click();
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });

  await test.step('Ctrl+Z takes the comments back one by one', async () => {
    await listing(page).click();
    await page.keyboard.press('Control+z');
    await expect(zpRow().locator('.cmt.user')).toHaveText('// screen pointer');
  });
});

test('Ctrl+C copies the selected lines of the listing as source, and the line at the cursor without one', async ({ app, page }) => {
  await waitForListing(page);
  const clipboard = async () => (await app.evaluate(({ clipboard: c }) => c.readText())).replace(/\r\n/g, '\n');
  // fx_091e is a jump-table routine: lda SID_OSC3 / and #$0f / sta COLOR_RAM+24*40+39 / rts
  await goTo(page, 'fx_091e');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowDown');
  await expect(statusBar(page)).toContainText('sel $091e–$0926 (9 B)');
  await page.keyboard.press('Control+c');
  // the whole block is selected, so its header comes along
  await expect(toast(page, 'Copied 6 lines to the clipboard')).toBeVisible();
  const lines = (await clipboard()).split('\n');
  expect(lines).toHaveLength(6);
  expect(lines[0]).toMatch(/^\/\/ ---- Code · fx_091e · \$091e-\$0926 \(9 bytes\) -+$/);
  expect(lines[1]).toBe('fx_091e:');
  expect(lines[2]).toMatch(/^ {8}lda SID_OSC3 +\/\/ Voice 3 oscillator output/);
  expect(lines[3]).toBe('        and #$0f');
  expect(lines[4]).toMatch(/^ {8}sta COLOR_RAM\+24\*40\+39\b/);
  expect(lines[5]).toBe('        rts');

  // the context menu inside the selection offers the same
  await listing(page).locator('.row', { has: page.locator('.adr', { hasText: /^0921$/ }) }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Copy 6 selected lines/ }).click();
  await expect(toast(page, 'Copied 6 lines to the clipboard')).toHaveCount(2);

  // without a selection, the line at the cursor
  await goTo(page, '$0923');
  await page.keyboard.press('Control+c');
  await expect(toast(page, 'Copied to clipboard')).toBeVisible();
  expect(await clipboard()).toMatch(/^sta COLOR_RAM\+24\*40\+39\b/);
});

test('the Memory tab shows the program as the VICE monitor does: m, i and ii', async ({ app, page }) => {
  await waitForListing(page);
  const dump = page.getByLabel('Memory dump');
  const row = (a: string) => dump.locator('.mon-row', { has: page.locator('.mon-adr', { hasText: new RegExp(`C:${a}`) }) });
  const info = page.locator('.monv .gfxv-info');
  const bar = page.locator('.monv .gfxv-sel[role="status"]');
  const command = async (c: string) => { await page.getByLabel('Monitor command').fill(c); await page.getByLabel('Monitor command').press('Enter'); };

  await test.step('m: a row is the address, 16 bytes in groups of four and the same bytes as text', async () => {
    await page.getByRole('tab', { name: 'Memory' }).click();
    expect(await row('0801').textContent()).toBe('>C:0801  0b 08 0a 00  9e 32 30 36  34 00 00 00  00 00 00 20   .....2064...... ');
    // further down, past what the window shows
    await dump.evaluate(el => { el.scrollTop = 200; });
    await expect(row('0941')).toContainText('MIMIR ST');
    await dump.evaluate(el => { el.scrollTop = 0; });
  });

  await test.step('a click puts the cursor on a byte, the arrow keys move it, Shift selects', async () => {
    await row('0801').locator('[data-a="2064"].mon-b').click();
    await expect(info).toContainText('$0810 = $20 · 32 · %00100000');
    await expect(statusBar(page)).toContainText('$0810');
    await page.keyboard.press('ArrowRight');
    await expect(info).toContainText('$0811 = $44');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(bar).toContainText('$0811–$0821 (17 bytes)');
    await page.keyboard.press('Escape');
    await expect(bar).not.toContainText('$0811–');
  });

  await test.step('a VICE command selects a range, and Copy writes the rows as VICE does', async () => {
    await command('m 0985 09a4');
    await expect(bar).toContainText('$0985–$09a4 (32 bytes) · Text txt_0985');
    await page.getByRole('button', { name: 'Copy selection' }).click();
    await expect(toast(page, 'Copied to clipboard')).toBeVisible();
    // (the Windows clipboard has \r\n line ends)
    const copied = (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n');
    expect(copied.split('\n')).toEqual([
      '>C:0985  08 05 0c 0c  0f 20 06 12  0f 0d 20 14  08 05 20 0d   ..... .... ... .',
      expect.stringMatching(/^>C:0995 {2}([0-9a-f]{2} ){3}[0-9a-f]{2} {2}/),
    ]);
  });

  await test.step('ii shows screen codes, in the lower case set too; i shows PETSCII 40 to a row', async () => {
    await command('ii 0985');
    await expect(page.getByRole('button', { name: 'Screen codes (ii)' })).toHaveAttribute('aria-pressed', 'true');
    await expect(row('0985')).toHaveText(/^\*C:0985 {2}HELLO FROM THE MIMIR STUDIO DEMO/);
    await page.getByText('Lower case', { exact: true }).click();
    await expect(row('0985')).toHaveText(/^\*C:0985 {2}hello from the mimir studio demo/);
    await page.getByText('Lower case', { exact: true }).click();
    await command('i 0801');
    await expect(row('0801')).toHaveText(/^>C:0801 {2}\.{5}2064/);
    await expect(row('0829')).toBeVisible();
    await command('m nowhere');
    await expect(page.locator('.monv [role="alert"]')).toContainText('neither a hex address nor a label');
  });

  await test.step('a selection is marked from here, and a double-click shows the byte in the listing', async () => {
    await command('m 3000 3007');
    await page.getByRole('button', { name: 'Mark as Bytes' }).click();
    await expect(toast(page, '$3000–$3007 marked as Bytes')).toBeVisible();
    await page.keyboard.press('Control+z');
    // m 0810 starts the rows at $0810, as in VICE
    await command('m 0810');
    await expect(row('0810')).toHaveText(/^>C:0810 {2}20 44 e5 20/);
    await row('0810').locator('[data-a="2064"].mon-b').dblclick();
    await expect(page.getByRole('tab', { name: 'Listing' })).toHaveAttribute('aria-selected', 'true');
    await expect(statusBar(page)).toContainText('$0810');
  });
});

test('the Demo button opens the showcase: every block type and a guided tour in the Bookmarks view', async ({ page }) => {
  await waitForListing(page);
  await page.getByRole('button', { name: 'Demo', exact: true }).click();
  await expect(toast(page, 'Showcase loaded: the Bookmarks view is a tour of it, F2 goes to the next stop')).toBeVisible();
  await waitForListing(page);

  await test.step('the tour is in the Bookmarks view, and F2 goes from stop to stop', async () => {
    const list = page.getByRole('list', { name: 'Bookmarks' });
    await expect(list.getByRole('listitem')).toHaveCount(15);
    await expect(list.getByRole('listitem').first()).toContainText('Welcome to the showcase');
    await listing(page).click();
    await page.keyboard.press('F2');
    await expect(toast(page, /^Bookmark \$[0-9a-f]{4}: /)).toBeVisible();
  });

  await test.step('the Blocks view has one block of every type', async () => {
    await page.locator('nav.activity').getByRole('button', { name: 'Blocks' }).click();
    const types = await page.locator('.blk-list .blk-type').allTextContents();
    for (const t of ['BASIC', 'Code', 'Text', 'Data', 'Word table', 'Table', 'Lo/Hi table', 'Sprites', 'Charset', 'Bitmap', 'Screen matrix', 'Music (SID)', 'Fill'])
      expect(types.map(x => x.trim()), t).toContain(t);
  });

  await test.step('it verifies byte for byte', async () => {
    await listing(page).click();
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
    await page.locator('nav.activity').getByRole('button', { name: 'Explorer' }).click();
    await expect(page.locator('.file-name')).toHaveText(['mimir-showcase.prg']);
  });
});

test('a VICE quicksave (Alt+F11 in VICE) opens by itself, F9 opens it again, Ctrl+Z goes back; the newest are kept, named, saved and made favourites', async ({ workDir: work, app, page }) => {
  await waitForListing(page);
  // a file of its own instead of VICE's settings folder: the user's quicksaves are never touched
  const qs = join(work, 'C64SC.vsf'), snapshot = join(repoDir, 'fixtures/vsf/raster-demo.vsf');
  const files = page.locator('.file-name');
  const section = page.getByRole('region', { name: 'VICE quicksave' });
  const status = section.getByRole('status', { name: 'Latest VICE quicksave' });
  const open = section.getByRole('button', { name: /Open the latest quicksave/ });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#set-viceQuicksave').fill(qs);
  await page.getByRole('button', { name: 'Save settings' }).click();

  await test.step('the Explorer says how to make one in VICE, and that there is none yet', async () => {
    await expect(section).toContainText('In VICE press Alt+F11 (Snapshot → Quicksave snapshot): the snapshot opens here by itself');
    await expect(status).toContainText('None yet. VICE writes it as C64SC.vsf in its settings folder.');
    await expect(open).toBeDisabled();
  });

  await test.step('F9 before VICE has saved one says where it will be', async () => {
    await listing(page).click();
    await page.keyboard.press('F9');
    await expect(toast(page, `No VICE quicksave yet: in VICE, Snapshot → Quicksave snapshot (Alt+F11) writes ${qs}`)).toBeVisible();
  });

  await test.step('VICE writing a quicksave opens it', async () => {
    // as VICE does: a new file, saved now
    writeFileSync(qs, readFileSync(snapshot));
    await expect(toast(page, /^Opened the VICE quicksave from .+: VICE 3\.10 snapshot of a C64SC.*, traced from \$08c7, \$08b7\. Ctrl\+Z goes back to the project before$/)).toBeVisible({ timeout: 15_000 });
    await expect(files).toHaveText(['quicksave.prg']);
    await expect(status).toContainText(/^Latest: today \d{1,2}[:.]\d{2}[:.]\d{2}.* C64SC\.vsf$/);
    await expect(open).toBeEnabled();
  });

  await test.step('Ctrl+Z brings the project before back, Ctrl+Y the quicksave', async () => {
    await listing(page).click();
    await page.keyboard.press('Control+z');
    await expect(files).toHaveText(['raster-demo.prg']);
    await page.keyboard.press('Control+y');
    await expect(files).toHaveText(['quicksave.prg']);
  });

  await test.step('with following off a new quicksave is only announced, and F9 opens it', async () => {
    await page.getByLabel('Open each new VICE quicksave').uncheck();
    await expect(section).toContainText('the snapshot opens here with F9');
    writeFileSync(qs, readFileSync(snapshot));
    utimesSync(qs, new Date(), new Date(Date.now() + 5000));
    await expect(toast(page, 'VICE saved a new quicksave: F9 opens it')).toBeVisible({ timeout: 15_000 });
    await open.click();
    // (the toast of the first one may still be there)
    await expect(toast(page, /^Opened the VICE quicksave from /).last()).toBeVisible();
    await page.getByLabel('Open each new VICE quicksave').check();
  });

  await test.step('both quicksaves are kept, the newest first; one is named, saved in a folder, and the other opened', async () => {
    const kept = section.getByRole('list', { name: 'Kept VICE quicksaves' }).getByRole('listitem');
    const stamp = /^quicksave \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;
    await expect(kept).toHaveCount(2);
    await expect(kept.locator('.qs-name-text')).toHaveText([stamp, stamp]);
    const [newest, older] = await kept.locator('.qs-name-text').allTextContents();
    await section.getByRole('button', { name: `Rename the quicksave ${newest}` }).click();
    const input = section.getByLabel(`Name of the quicksave ${newest}`);
    await expect(input).toBeFocused();
    await input.fill('intro');
    await input.press('Enter');
    await expect(kept.locator('.qs-name-text')).toHaveText(['intro', older]);
    const file = join(work, 'saved', 'intro.vsf');
    mkdirSync(join(work, 'saved'), { recursive: true });
    await stubDialogs(app, { save: file });
    await section.getByRole('button', { name: 'Save the quicksave intro' }).click();
    await expect(toast(page, `The quicksave "intro" saved to ${file}`)).toBeVisible();
    expect(readFileSync(file)).toEqual(readFileSync(snapshot));
    expect((await dialogOptions(app)).pop()).toMatchObject({ title: 'Save the quicksave "intro"', defaultPath: expect.stringMatching(/intro\.vsf$/) });
    await kept.nth(1).getByRole('button', { name: new RegExp(`^${older.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click();
    await expect(toast(page, `Opened the quicksave "${older}": VICE 3.10 snapshot of a C64SC`)).toBeVisible();
    await expect(files).toHaveText([`${older.replace(/:/g, '-')}.prg`]);
  });

  await test.step('the star makes one a favourite, in a list of its own above the newest, and takes it back', async () => {
    const lists = section.getByRole('list');
    const favourites = section.getByRole('list', { name: 'Favourite VICE quicksaves' }).getByRole('listitem');
    const kept = section.getByRole('list', { name: 'Kept VICE quicksaves' }).getByRole('listitem');
    const older = await kept.nth(1).locator('.qs-name-text').textContent() ?? '';
    await expect(favourites).toHaveCount(0);
    const star = section.getByRole('button', { name: 'Add the quicksave intro to the favourites' });
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    await expect(toast(page, '"intro" is a favourite: it stays when VICE saves new quicksaves')).toBeVisible();
    await expect(favourites.locator('.qs-name-text')).toHaveText(['intro']);
    await expect(kept.locator('.qs-name-text')).toHaveText([older]);
    expect(await lists.evaluateAll(l => l.map(e => e.getAttribute('aria-label')))).toEqual(['Favourite VICE quicksaves', 'Kept VICE quicksaves']);
    await expect(section).toContainText('Favourites, always kept');
    // it opens, is named and saved there as well
    await favourites.getByRole('button', { name: /^intro/ }).click();
    await expect(toast(page, 'Opened the quicksave "intro": VICE 3.10 snapshot of a C64SC')).toBeVisible();
    await expect(files).toHaveText(['intro.prg']);
    const off = section.getByRole('button', { name: 'Remove the quicksave intro from the favourites' });
    await expect(off).toHaveAttribute('aria-pressed', 'true');
    await off.click();
    await expect(toast(page, '"intro" is no favourite now: it goes when VICE saves a new quicksave, unless it is among the newest 5')).toBeVisible();
    await expect(favourites).toHaveCount(0);
    await expect(kept.locator('.qs-name-text')).toHaveText(['intro', older]);
  });
});

test('the Graphics tab saves its selection: bytes, with a load address, a Koala picture, a PNG image and .byte source', async ({ workDir: work, app, page }) => {
  await waitForListing(page);
  await page.getByRole('tab', { name: 'Graphics' }).click();
  const view = page.getByLabel('Memory as graphics');
  const go = async (to: string) => { await view.getByLabel('Go to address, label or range').fill(to); await view.getByLabel('Go to address, label or range').press('Enter'); };
  const demo = readFileSync(join(repoDir, 'fixtures/prg/raster-demo.prg'));
  const at = (a: number, n: number) => demo.subarray(2 + a - 0x0801, 2 + a - 0x0801 + n);
  /** Save… → `item`, the save dialog answering `file`; returns what was written */
  const saveAs = async (item: string | RegExp, file: string) => {
    await stubDialogs(app, { save: join(work, file) });
    await view.getByRole('button', { name: 'Save…' }).click();
    await view.getByRole('menu', { name: 'Save the selection as' }).getByRole('menuitem', { name: item }).click();
    await expect(toast(page, `Saved ${join(work, file)}`)).toBeVisible();
    return readFileSync(join(work, file));
  };

  await test.step('the whole charset: the menu, raw bytes, .64c and .byte source', async () => {
    await go('$3000');
    await view.getByRole('button', { name: 'Whole charset (2 KB)' }).click();
    await view.getByRole('button', { name: 'Save…' }).click();
    await expect(view.getByRole('menu', { name: 'Save the selection as' }).getByRole('menuitem')).toHaveText([
      'Raw bytes (.bin)', 'Charset with its load address (.64c)', 'Image as shown here (.png)', 'Kick Assembler source, .byte rows (.asm)',
    ]);
    await page.keyboard.press('Escape');
    expect((await dialogOptions(app)).length).toBe(0);
    expect(await saveAs('Raw bytes (.bin)', 'font.bin')).toEqual(at(0x3000, 2048));
    expect((await dialogOptions(app)).pop()).toMatchObject({ title: 'Save graphics', defaultPath: expect.stringMatching(/charset_3000\.bin$/) });
    const c64 = await saveAs(/\.64c/, 'font.64c');
    expect([c64[0], c64[1]]).toEqual([0x00, 0x30]);
    expect(c64.subarray(2)).toEqual(at(0x3000, 2048));
    const asm = (await saveAs(/\.asm/, 'font.asm')).toString('utf8');
    expect(asm).toMatch(/^\/\/ charset_3000: \$3000-\$37ff, 2048 bytes \(256 characters\), saved by Mimir Studio/);
    expect(asm).toMatch(/charset_3000:\n {8}\/\/ char 0 at \$3000\n {8}\.byte %[01]{8}\n/);
  });

  await test.step('a sprite as an image', async () => {
    await view.getByRole('button', { name: 'Sprites', exact: true }).click();
    await go('$2000');
    const png = await saveAs(/\.png/, 'ball.png');
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR: 24 x 21
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([24, 21]);
  });

  await test.step('a bitmap as a Koala Painter picture with the colours shown', async () => {
    await view.getByRole('button', { name: 'Bitmaps' }).click();
    await view.getByLabel('Multicolor').check();
    await go('$2000');
    const kla = await saveAs(/Koala Painter/, 'pic.kla');
    expect(kla.length).toBe(10003);
    expect([kla[0], kla[1]]).toEqual([0x00, 0x60]);
    // the demo ends at $37ff: the rest of the 8000 bytes is memory that is not loaded (zeros)
    expect(kla.subarray(2, 2 + 0x1800)).toEqual(at(0x2000, 0x1800));
    expect(kla.subarray(2 + 0x1800, 2 + 8000).every(b => b === 0)).toBe(true);
    // the tab's colours: MC1 light grey (15) and MC2 grey (12) in the screen matrix, white (1) in colour RAM, black
    expect([kla[8002], kla[9002], kla[10002]]).toEqual([0xfc, 0x01, 0x00]);
  });
});

test('a byte in the wrong block is dragged by its address into the block next to it', async ({ page }) => {
  await waitForListing(page);
  await page.keyboard.press('Control+j');
  await expect(page.locator('section.bottom')).toHaveClass(/collapsed/);
  await goTo(page, '$0951');
  /** the data line at `adr` (not its label line) */
  const line = (adr: string) => listing(page).locator('.row.k-dat', { has: page.locator('.adr', { hasText: new RegExp(`^${adr}$`) }) });
  const chip = listing(page).locator('.move-chip');
  /** press on `part` of line `from`, move onto row `to`, then (after `hold`) let go */
  const drag = async (from: Locator, to: Locator, part = '.adr', hold?: () => Promise<void>) => {
    const a = (await from.locator(part).boundingBox())!, b = (await to.boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 300, b.y + b.height / 2, { steps: 8 });
    if (hold) await hold();
    await page.mouse.up();
  };

  await test.step('lines at a block edge can be dragged, the others not', async () => {
    await expect(line('0960')).toHaveClass(/\bmovable\b/);
    await expect(line('0960').locator('.adr')).toHaveAttribute('title', 'Drag the address or the bytes into the block next to it:\n↑ $0960 into the Text block above');
    await expect(line('09bd')).toHaveCount(1);
    await expect(line('09bd')).not.toHaveClass(/\bmovable\b/);
  });

  await test.step('while dragging, the block it goes into is marked; Esc cancels', async () => {
    await drag(line('0960'), headerRow(page, '0949'), '.adr', async () => {
      await expect(chip).toHaveText('↑ Move $0960 into the Text block above');
      await expect(headerRow(page, '0949')).toHaveClass(/\bdrop-into\b/);
      await expect(line('0960')).toHaveClass(/\bmoving-src\b/);
      await page.keyboard.press('Escape');
      await expect(chip).toHaveCount(0);
    });
    await expect(headerRow(page, '0949')).toContainText('$0949-$095f (23 bytes)');
  });

  await test.step('dropped in the block above, the first byte joins it', async () => {
    await drag(line('0960'), headerRow(page, '0949'));
    await expect(toast(page, '$0960 moved into the Text block, now $0949–$0960')).toBeVisible();
    await expect(headerRow(page, '0949')).toContainText('$0949-$0960 (24 bytes)');
    await expect(headerRow(page, '0961')).toContainText('$0961-$0984 (36 bytes)');
  });

  await test.step('dragged by its bytes into the block below, the last byte of the table joins the text', async () => {
    await drag(line('0941'), headerRow(page, '0949'), '.hex');
    await expect(toast(page, '$0948 moved into the Text block, now $0948–$0960')).toBeVisible();
    await expect(headerRow(page, '0939')).toContainText('Color table');
    await expect(headerRow(page, '0939')).toContainText('$0939-$0947 (15 bytes)');
    await expect(headerRow(page, '0948')).toContainText('$0948-$0960 (25 bytes)');
  });

  await test.step('dropped anywhere else nothing moves; dragging the source text still selects', async () => {
    await drag(line('0939'), headerRow(page, '0985'));
    await expect(headerRow(page, '0939')).toContainText('$0939-$0947 (15 bytes)');
    await drag(line('0939'), headerRow(page, '0948'), '.src');
    await expect(statusBar(page)).toContainText('sel $0939–$0960 (40 B)');
    await expect(headerRow(page, '0939')).toContainText('$0939-$0947 (15 bytes)');
  });

  await test.step('the context menu does the same, and Ctrl+Z undoes it', async () => {
    await line('0961').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move $0961 into the previous block (Text)' }).click();
    await expect(toast(page, '$0961 moved into the Text block, now $0948–$0961')).toBeVisible();
    await expect(headerRow(page, '0962')).toContainText('$0962-$0984 (35 bytes)');
    for (const head of ['$0948-$0960 (25 bytes)', '$0949-$0960 (24 bytes)', '$0949-$095f (23 bytes)']) {
      await page.keyboard.press('Control+z');
      await expect(listing(page).locator('.row.hdr', { hasText: head })).toHaveCount(1);
    }
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });
});

test('the Graphics tab finds screens: drawn with a charset, the grid starting where it goes to, and saved like the other graphics', async ({ workDir: work, app, page }) => {
  await waitForListing(page);
  await page.keyboard.press('Control+j');
  await page.getByRole('tab', { name: 'Graphics' }).click();
  const view = page.getByLabel('Memory as graphics');
  const go = async (to: string) => { await view.getByLabel('Go to address, label or range').fill(to); await view.getByLabel('Go to address, label or range').press('Enter'); };
  const sel = view.getByRole('status');
  const charset = view.getByLabel('Draw screens with');
  const demo = readFileSync(join(repoDir, 'fixtures/prg/raster-demo.prg'));
  const at = (a: number, n: number) => demo.subarray(2 + a - 0x0801, 2 + a - 0x0801 + n);
  const saveAs = async (item: string | RegExp, file: string) => {
    await stubDialogs(app, { save: join(work, file) });
    await view.getByRole('button', { name: 'Save…' }).click();
    await view.getByRole('menu', { name: 'Save the selection as' }).getByRole('menuitem', { name: item }).click();
    await expect(toast(page, `Saved ${join(work, file)}`)).toBeVisible();
    return readFileSync(join(work, file));
  };

  await test.step('Screens: a screen per 1 KB, drawn with the C64 ROM, the built-in letters or a charset in memory', async () => {
    await view.getByRole('button', { name: 'Screens', exact: true }).click();
    await expect(view.getByRole('button', { name: 'Screens', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(view.getByLabel('Memory as screens')).toBeVisible();
    await expect(charset.locator('option')).toContainText(['C64 ROM, upper case', 'C64 ROM, lower case', 'Built-in letters and digits', '$3000 charset_3000', '$0000']);
    await charset.selectOption({ label: 'Built-in letters and digits' });
    await expect(charset).toHaveValue('builtin');
    await charset.selectOption('$3000');
    await expect(charset).toHaveValue('$3000');
  });

  await test.step('going to the text at $0985 moves the grid so that a screen starts there; hovering names the row and column', async () => {
    await go('txt_0985');
    await expect(sel).toContainText('$0985–$0d6c (1000 bytes) · Text txt_0985');
    await expect(view.getByText('Offset')).toBeVisible();
    await expect(view.locator('.gfxv-field .mono')).toHaveText(String(0x0985 % 0x400));
    const r = (await view.locator('.gfxv-selrect').first().boundingBox())!;
    // zoom 2: the third code of the first row
    await page.mouse.move(r.x + 2 * 8 * 2 + 4, r.y + 4);
    await expect(view.locator('.gfxv-info')).toContainText(`$0987 = $${at(0x0987, 1)[0].toString(16).padStart(2, '0')} · row 0, column 2 of the screen at $0985 · Text txt_0985`);
    await go('$0400');
    await page.mouse.move(r.x + 4, r.y + 4);
    await expect(view.locator('.gfxv-info')).toContainText('of the screen at $0400 ($d018 = $1x in VIC bank 0)');
  });

  await test.step('saved as bytes, with its load address, as an image and as .byte rows of 40', async () => {
    await go('txt_0985');
    await view.getByRole('button', { name: 'Save…' }).click();
    await expect(view.getByRole('menu', { name: 'Save the selection as' }).getByRole('menuitem')).toHaveText([
      'Raw bytes (.bin)', 'With its load address (.prg)', 'Image as shown here (.png)', 'Kick Assembler source, .byte rows (.asm)',
    ]);
    await page.keyboard.press('Escape');
    expect(await saveAs('Raw bytes (.bin)', 'screen.bin')).toEqual(at(0x0985, 1000));
    expect((await dialogOptions(app)).pop()).toMatchObject({ defaultPath: expect.stringMatching(/txt_0985\.bin$/) });
    const prg = await saveAs(/\.prg/, 'screen.prg');
    expect([prg[0], prg[1], prg.length]).toEqual([0x85, 0x09, 1002]);
    const png = await saveAs(/\.png/, 'screen.png');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([320, 200]);
    const asm = (await saveAs(/\.asm/, 'screen.asm')).toString('utf8');
    expect(asm).toMatch(/^\/\/ txt_0985: \$0985-\$0d6c, 1000 bytes \(1 screen\), saved by Mimir Studio/);
    expect(asm.split('\n').filter(l => l.includes('.byte'))).toHaveLength(25);
    await view.getByRole('button', { name: 'With the sprite pointers (1 KB)' }).click();
    await expect(sel).toContainText('$0985–$0d84 (1024 bytes)');
    await expect(view.getByRole('button', { name: 'Mark as Screen matrix' })).toBeVisible();
  });
});

test('the Graphics tab draws a font per row: the same 40 screen codes, each character row with the next font', async ({ workDir: work, app, page }) => {
  await waitForListing(page);
  await page.keyboard.press('Control+j');
  await page.getByRole('tab', { name: 'Graphics' }).click();
  const view = page.getByLabel('Memory as graphics');
  const sel = view.getByRole('status');
  const picture = view.getByLabel('A font per row');
  const demo = readFileSync(join(repoDir, 'fixtures/prg/raster-demo.prg'));
  const at = (a: number) => demo[2 + a - 0x0801];
  const field = async (label: string, to: string) => { await view.getByLabel(label).fill(to); await view.getByLabel(label).press('Enter'); };

  await test.step('the codes come from the first row of the screen (0-39 when it is not loaded), the fonts 2 KB apart', async () => {
    await view.getByRole('button', { name: 'Font per row' }).click();
    await expect(picture).toBeVisible();
    await expect(view.getByText('not loaded: 0–39')).toBeVisible();
    // the codes are picked from the blocks the analysis knows (or typed)
    const pick = view.getByLabel('Screen codes from a block');
    await expect(pick).toHaveValue(String(0x0400));
    await expect(pick.locator('optgroup').first()).toHaveAttribute('label', 'Text');
    await expect(pick.locator('optgroup').last()).toHaveAttribute('label', 'Code');
    await pick.selectOption({ label: '$0985 txt_0985 · 48 bytes' });
    await expect(view.getByLabel('First row of the screen')).toHaveValue('$0985');
    // the arrows and the mouse wheel step through the list: $0400, then the texts $0949, $0960, $0985, then the data …
    const codesAt = view.getByLabel('First row of the screen');
    for (const a of ['$0960', '$0949', '$0400']) { await view.getByRole('button', { name: 'Previous block' }).click(); await expect(codesAt).toHaveValue(a); }
    await expect(view.getByRole('button', { name: 'Previous block' })).toBeDisabled();
    await view.getByRole('button', { name: 'Next block' }).click();
    await expect(codesAt).toHaveValue('$0949');
    const p = (await pick.boundingBox())!;
    await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
    await page.mouse.wheel(0, 100);
    await expect(codesAt).toHaveValue('$0960');
    await page.waitForTimeout(100);
    await page.mouse.wheel(0, -100);
    await expect(codesAt).toHaveValue('$0949');
    await field('First row of the screen', '$0990');
    await expect(pick).toHaveValue('');
    await field('First row of the screen', 'txt_0985');
    await expect(pick).toHaveValue(String(0x0985));
    await view.getByRole('button', { name: 'Next block' }).click();
    await expect(codesAt).toHaveValue('$092d');
    await field('First row of the screen', 'txt_0985');
    await expect(view.getByText('not loaded: 0–39')).toHaveCount(0);
    await field('Font of the first row', '$3000');
    // 25 rows asked for, 22 fit before $ffff: $9000, $9800, $d000 and $d800 are passed over
    await expect(picture).toHaveAttribute('height', String(22 * 8));
    await expect(view.getByText('skipped $9000, $9800, $d000, $d800')).toBeVisible();
    await view.getByLabel('Rows').selectOption('4');
    await expect(picture).toHaveAttribute('height', String(4 * 8));
    await expect(view.locator('.gfxv-row span')).toHaveText(['$3000', '$3800', '$4000', '$4800']);
  });

  await test.step('hovering names the character and its font; a click selects the row font', async () => {
    // the picture moves when the selection bar grows: where it is now, at zoom 2
    const point = async (x: number, y: number) => { const b = (await picture.boundingBox())!; return [b.x + x * 2, b.y + y * 2] as const; };
    // column 0, the second line of row 0 is 'H' (screen code 8) of the font at $3000
    await page.mouse.move(...await point(2, 1.5));
    await expect(view.locator('.gfxv-info')).toContainText(`$3041 = $${at(0x3041).toString(16).padStart(2, '0')} · row 0, column 0: char $08 of the font at $3000 · Charset charset_3000`);
    await page.mouse.click(...await point(50, 8 + 2));
    await expect(sel).toContainText('$3800–$3fff (2048 bytes) · not loaded');
    await page.mouse.click(...await point(50, 2));
    await expect(sel).toContainText('$3000–$37ff (2048 bytes) · Charset charset_3000');
    await view.getByRole('button', { name: 'All 4 rows' }).click();
    await expect(sel).toContainText('$3000–$4fff (8192 bytes)');
  });

  await test.step('saved as the fonts or as the picture', async () => {
    const b = (await picture.boundingBox())!;
    await page.mouse.click(b.x + 100, b.y + 4);
    await expect(sel).toContainText('$3000–$37ff (2048 bytes)');
    await view.getByRole('button', { name: 'Save…' }).click();
    await expect(view.getByRole('menu', { name: 'Save the selection as' }).getByRole('menuitem')).toHaveText([
      'Raw bytes (.bin)', 'With its load address (.prg)', 'Image as shown here (.png)', 'Kick Assembler source, .byte rows (.asm)',
    ]);
    await stubDialogs(app, { save: join(work, 'row.png') });
    await view.getByRole('menu', { name: 'Save the selection as' }).getByRole('menuitem', { name: /\.png/ }).click();
    await expect(toast(page, `Saved ${join(work, 'row.png')}`)).toBeVisible();
    const png = readFileSync(join(work, 'row.png'));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([320, 8]);
    expect((await dialogOptions(app)).pop()).toMatchObject({ defaultPath: expect.stringMatching(/charset_3000\.png$/) });
  });

  await test.step('rows pass over memory where no font can be (the VIC sees the character ROM at $1000-$1fff), unless told not to', async () => {
    const field = view.getByLabel('Font of the first row');
    await field.fill('$0800'); await field.press('Enter');
    await expect(view.locator('.gfxv-row span')).toHaveText(['$0800', '$2000', '$2800', '$3000']);
    await expect(view.getByText('skipped $1000, $1800')).toBeVisible();
    await view.getByLabel('Skip where no font can be').uncheck();
    await expect(view.locator('.gfxv-row span')).toHaveText(['$0800', '$1000', '$1800', '$2000']);
    await expect(view.getByText(/^skipped/)).toHaveCount(0);
    await view.getByLabel('Skip where no font can be').check();
    await field.fill('$1000'); await field.press('Enter');
    // a first font where none can be: the picture starts at the next one
    await expect(view.locator('.gfxv-row span').first()).toHaveText('$2000');
  });
});

test('Build & Run restarts a VICE snapshot as it was taken, with the built program in its RAM', async ({ app, page }) => {
  // VICE itself is not started here: a Windows program that ends at once stands in for it (the real VICE restarting
  // a snapshot is tested in packages/core/test/vice.integration.test.ts)
  const standIn = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
  test.skip(!existsSync(standIn), 'needs where.exe');
  await waitForListing(page);
  const vsf = join(repoDir, 'fixtures/vsf/raster-demo.vsf');
  await page.evaluate(v => (window as unknown as { kr: { setSettings(p: object): Promise<unknown> } }).kr.setSettings({ vicePath: v }), standIn);
  const build = page.getByRole('button', { name: 'Build & Run' });
  await expect(build).toHaveAttribute('title', 'Build with KickAss.jar and run in VICE (F5)');
  await stubDialogs(app, { open: [vsf] });
  await page.getByRole('button', { name: 'Open PRG…' }).click();
  await expect(toast(page, 'Loaded raster-demo.prg at $0200 from a VICE 3.10 snapshot')).toBeVisible();
  await expect(build).toHaveAttribute('title', /restart the snapshot in VICE as it was taken/);
  await page.keyboard.press('F5');
  await expect(toast(page, 'VICE restarted the snapshot as it was taken (PC $08c7, $01 = $37), with the built program in its RAM')).toBeVisible({ timeout: 120_000 });
  await page.getByRole('tab', { name: 'Build output' }).click();
  const log = await page.locator('.build-log').innerText();
  const started = /> VICE started \(pid -?\d+\): (.+?\.vsf)(?: with labels|,)/.exec(log);
  expect(started, log.slice(-600)).toBeTruthy();
  expect(log).toContain('the snapshot restarted as it was taken (PC $08c7, $01 = $37), the built program in its RAM');
  // the program is byte-identical, so the snapshot VICE gets is the one that was opened
  expect(readFileSync(started![1])).toEqual(readFileSync(vsf));
});

test('the Explorer\'s sections say what they hold and fold up, and stay folded', async ({ page }) => {
  await waitForListing(page);
  const loaders = page.getByRole('region', { name: 'Loaders' });
  const toggle = loaders.getByRole('button', { name: 'Loaders' });
  await expect(page.getByRole('region', { name: 'Files' }).locator('.sec-sum')).toHaveText('1 file');
  await expect(loaders.locator('.sec-sum')).toHaveText('none found');
  await expect(page.getByRole('region', { name: 'Program start' }).locator('.sec-sum')).toHaveText('$0810');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(loaders).not.toContainText('No fast, IRQ or tape loader found');
  await expect(loaders.locator('.sec-sum')).toHaveText('none found');
  // another view and back: still folded (the choice is kept with the user's other preferences)
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Blocks' }).click();
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Explorer' }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(loaders).toContainText('No fast, IRQ or tape loader found, and no KERNAL LOAD.');
});

test('loaders: the Explorer names the loader and lists its parts, which the listing and the source mark', async ({ app, page }) => {
  await waitForListing(page);
  const section = page.getByRole('region', { name: 'Loaders' });
  await expect(section).toContainText('No fast, IRQ or tape loader found, and no KERNAL LOAD.');

  // fixtures/prg/loader-demo.prg (packages/core/test/loaders.test.ts): an installer that sends drive code with M-W and
  // starts it with M-E, the drive code, and a Spindle 3 resident page at $0c00 that the program calls
  await stubDialogs(app, { open: [join(repoDir, 'fixtures/prg/loader-demo.prg')] });
  await page.getByRole('button', { name: 'Open PRG…' }).click();
  await expect(toast(page, 'Loaded loader-demo.prg at $0801')).toBeVisible();
  const spindle = section.getByLabel('Spindle (lft)');
  await expect(spindle).toContainText('2-bit + ATN, synchronous; one resident page that the program calls with jsr, the VIC bank set through $dd02');
  await expect(spindle.locator('li')).toHaveText([/installer$/, /drive command$/, /drive command$/, /^\$0c00–\$0cff\s*on the C64$/, /^\$3000–\$302[0-9a-f]\s*drive code$/]);
  await expect(spindle.getByRole('button', { name: '$0c00–$0cff' })).toHaveAttribute('title', 'resident page (jsr here to load the next part)\nClick to go there');

  await test.step('a part goes to the listing, where it is marked', async () => {
    await spindle.getByRole('button', { name: '$0c00–$0cff' }).click();
    await expect(statusBar(page)).toContainText('$0c00');
    await expect(listing(page).locator('.row .syn-comment.mark', { hasText: '// ==== Spindle (lft): resident page (jsr here to load the next part) ====' })).toBeVisible();
    await expect(listing(page).locator('.row.hdr .hdr-loader').first()).toHaveText('Spindle');
    await spindle.getByRole('button', { name: /^\$3000–/ }).click();
    await expect(listing(page).locator('.row .syn-comment.mark', { hasText: '// ==== Spindle (lft): code for the 1541' })).toBeVisible();
  });

  await test.step('the analysis log says it too, and the build still verifies', async () => {
    await page.getByRole('tab', { name: 'Analysis log' }).click();
    await expect(page.locator('.loglist .logrow', { hasText: 'Loader: Spindle (lft): 2-bit + ATN' })).toBeVisible();
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });
});

test('the Spindle script: a tab when Pefchain drivers are in memory, a row per script line that goes to its driver', async ({ app, page }) => {
  await waitForListing(page);
  await expect(page.getByRole('tab', { name: /Spindle script/ })).toHaveCount(0);

  // fixtures/prg/spindle-demo.prg (packages/core/test/spindle.test.ts): the drivers pefchain 3.1 built for five small
  // parts, `space`, `f0 = 05`, `| f0 = 20`, `-`, `@` and its blank part that stays
  await stubDialogs(app, { open: [join(repoDir, 'fixtures/prg/spindle-demo.prg')] });
  await page.getByRole('button', { name: 'Open PRG…' }).click();
  await expect(toast(page, 'Loaded spindle-demo.prg at $0400')).toBeVisible();
  await page.getByRole('tab', { name: /Spindle script/ }).click();
  await expect(page.getByRole('tab', { name: /Spindle script/ })).toContainText('6');
  const table = page.getByRole('table', { name: 'Spindle script' });
  await expect(table.locator('tbody td.script-line')).toHaveText(['part1.pef space', 'part2.pef f0 = 05', '| f0 = 20', 'part3.pef -', 'part4.pef @', '- stay']);
  await expect(table.locator('tbody tr').nth(1).locator('td').last()).toHaveText('its | line');
  await expect(table.locator('tbody tr').last().locator('td').last()).toHaveText('the end of the demo');

  await test.step('a row goes to its driver, marked in the listing; a routine goes to the routine', async () => {
    await table.locator('tbody tr').nth(3).locator('td').first().click();
    await expect(statusBar(page)).toContainText('$1201 · part3_driver');
    await expect(listing(page).locator('.row .syn-comment.mark', { hasText: '// ==== Spindle part 3: its driver (script line "part3.pef -") ====' })).toBeVisible();
    await table.locator('tbody tr').nth(4).getByRole('button', { name: 'part4_fadeout' }).click();
    await expect(statusBar(page)).toContainText('$1314 · part4_fadeout');
  });

  await test.step('it copies the script as Pefchain reads it, and the build still verifies', async () => {
    await page.getByRole('button', { name: 'Copy script' }).click();
    await expect(toast(page, 'Copied the Spindle script')).toBeVisible();
    const text = (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n');
    expect(text.split('\n').slice(2, 4)).toEqual([
      'part1.pef     space      # driver $108c: prepare $1000, setup $1001, irq $1006, fadeout $1013, cleanup $1015; loads',
      'part2.pef     f0 = 05    # driver $1115: setup $1100, irq $1105, main $1112',
    ]);
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });

  await test.step('a program without drivers has no such tab, and the panel goes back to the log', async () => {
    await page.getByRole('tab', { name: /Spindle script/ }).click();
    await page.getByRole('button', { name: 'Demo', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Spindle script/ })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Analysis log/ })).toHaveAttribute('aria-selected', 'true');
  });
});

test('a mounted Spindle 3 disk: its load script in the Spindle script tab, each chunk opened as a PRG', async ({ app, page }) => {
  // fixtures/d64/spindle-demo.d64 (packages/core/test/spindle-disk.test.ts): 4 jobs, labels 01, 02 and 1f, a jump after
  // the last one, and the boot program going to $0800
  await waitForListing(page);
  await stubDialogs(app, { open: [join(repoDir, 'fixtures/d64/spindle-demo.d64')] });
  await page.getByRole('button', { name: 'Mount D64…' }).click();
  await expect(toast(page, 'Mounted spindle-demo.d64: "SPINDLE DEMO", 1 file, a Spindle 3 disk with 4 jobs')).toBeVisible();
  await expect(page.locator('.disk-spindle')).toContainText('Spindle 3 disk: 4 jobs the loader reads, not files');

  await test.step('the Explorer opens the load script, a row per chunk', async () => {
    await page.locator('.disk-spindle').getByRole('button', { name: 'Load script' }).click();
    await expect(page.getByRole('tab', { name: /Spindle script/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.spindle-head').first()).toContainText('Load script of spindle-demo.d64 (Spin, Spindle 3): 4 jobs, 6 chunks');
    const table = page.getByRole('table', { name: 'Spindle load script' });
    await expect(table.locator('tbody tr td:nth-child(4)')).toHaveText(['job01_0800.bin', 'job01_1000.bin', 'job02_4000.bin', 'job02_6000.bin', 'job03_2000.bin', 'job04_cf00.bin']);
    await expect(table.locator('tbody tr').nth(4).locator('td').first()).toHaveText('302:1f:');
    await expect(table.locator('tbody tr').nth(5).locator('td').nth(4)).toHaveText('then jumps to $307a · loads under I/O');
  });

  await test.step('a row opens its chunk as a PRG, + adds one', async () => {
    const table = page.getByRole('table', { name: 'Spindle load script' });
    await table.getByRole('row', { name: /job01_0800/ }).click();
    await expect(toast(page, 'Loaded job01_0800.prg at $0800')).toBeVisible();
    await table.getByRole('button', { name: 'Add job02_4000.bin to this project' }).click();
    await expect(page.locator('.file-name')).toHaveText(['job01_0800.prg', 'job02_4000.prg']);
    await expect(listing(page).locator('.row', { hasText: 'sta VIC_BORDER_COLOR' }).first()).toBeVisible();
  });

  await test.step('it copies the script as Spin reads it', async () => {
    await page.getByRole('button', { name: 'Copy script' }).click();
    await expect(toast(page, 'Copied the load script')).toBeVisible();
    const text = (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n');
    expect(text.split('\n').slice(2, 6)).toEqual(['# spin -e 0800', '', 'job01_0800.bin     0800    # $0800-$080a, 11 bytes', 'job01_1000.bin     1000    # $1000-$1257, 600 bytes']);
  });

  await test.step('ejecting the disk takes the tab away', async () => {
    await page.getByRole('button', { name: 'Eject disk' }).click();
    await expect(page.getByRole('tab', { name: /Spindle script/ })).toHaveCount(0);
  });
});

test('the tab row fits a small window: the listing tools lose their labels, then move into the ⋯ menu', async ({ app, page }) => {
  await waitForListing(page);
  const row = page.locator('main.main > .tabs');
  const fits = () => row.evaluate(el => el.scrollWidth <= el.clientWidth);
  const size = (w: number) => app.evaluate(({ BrowserWindow }, width) => { BrowserWindow.getAllWindows()[0].setSize(width, 860); }, w);
  const more = page.getByRole('button', { name: 'Listing tools' });

  await test.step('the default window: every tool in the row, with its name for the screen reader and the tooltip', async () => {
    expect(await fits()).toBe(true);
    await expect(page.getByRole('button', { name: 'Cycles' })).toBeVisible();
    await expect(more).toBeHidden();
  });

  await test.step('a 1366 px laptop screen: the tools are in the ⋯ menu, every tab keeps its name', async () => {
    await size(1366);
    await expect(more).toBeVisible();
    expect(await fits()).toBe(true);
    await expect(page.getByRole('button', { name: 'Cycles' })).toBeHidden();
    await more.click();
    await page.getByRole('menuitemcheckbox', { name: 'Cycles' }).click();
    await more.click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Cycles' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('menuitemcheckbox', { name: 'Left column: address' })).toHaveAttribute('aria-checked', 'true');
    // the ⋯ button closes its menu again
    await more.click();
    await expect(page.getByRole('menu')).toBeHidden();
  });

  await test.step('narrower: the other tabs show only their icons and still open by name', async () => {
    await size(1100);
    expect(await fits()).toBe(true);
    await page.getByRole('tab', { name: 'Graphics' }).click();
    await expect(page.getByRole('tab', { name: 'Graphics' })).toHaveAttribute('aria-selected', 'true');
  });
});

test('the Raster IRQs panel lists every IRQ handler with its $d012 and $d011 and goes to it', async ({ page }) => {
  await waitForListing(page);
  await page.getByRole('tab', { name: /Raster IRQs/ }).click();
  const table = page.getByRole('table', { name: 'Raster IRQs' });
  await expect(page.locator('.raster .xref-head')).toContainText('1 raster interrupt, 1 handler');
  const row = table.locator('tbody tr').first();
  await expect(row.locator('td')).toHaveText(['98 ($062)', '$62', '$1b', 'irq_08b7', '$0836', 'main code via $0314']);
  await row.getByRole('button', { name: 'irq_08b7' }).click();
  await expect(statusBar(page)).toContainText('$08b7 · irq_08b7');
  await row.getByRole('button', { name: '$0836' }).click();
  await expect(statusBar(page)).toContainText('$0836');
});

test('the inspector writes a table in binary or decimal and words as numbers, several a row', async ({ page }) => {
  await waitForListing(page);
  const format = page.getByRole('group', { name: 'Number format' });
  await goTo(page, 'colors_0939');
  await expect(format.getByRole('button', { name: 'Hex' })).toHaveAttribute('aria-pressed', 'true');

  await test.step('a table: binary, then 4 bytes a row', async () => {
    await format.getByRole('button', { name: 'Bin' }).click();
    await expect(format.getByRole('button', { name: 'Bin' })).toHaveAttribute('aria-pressed', 'true');
    expect(rowAt(await listingRows(page), '0939')?.text).toMatch(/^\.byte %00000110, %00001110, %00000011/);
    await page.getByLabel('Bytes per row').fill('4');
    await page.getByLabel('Bytes per row').press('Enter');
    expect(rowAt(await listingRows(page), '0939')?.text).toBe('.byte %00000110, %00001110, %00000011, %00000001');
    expect(rowAt(await listingRows(page), '093d')?.text).toMatch(/^\.byte %00000011/);
  });

  await test.step('the same bytes as words: addresses by default, then decimal, 4 a row; F7 verifies', async () => {
    await listing(page).focus();
    await page.keyboard.press('w');
    await expect(format.getByRole('button', { name: 'Addr' })).toHaveAttribute('aria-pressed', 'true');
    expect(rowAt(await listingRows(page), '0939')?.text).toBe('.word $0e06');
    await format.getByRole('button', { name: 'Dec' }).click();
    await page.getByLabel('Words per row').fill('4');
    await page.getByLabel('Words per row').press('Enter');
    expect(rowAt(await listingRows(page), '0939')?.text).toBe('.word 3590, 259, 3587, 6');
    await listing(page).focus();
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
    // Ctrl+Z goes back to addresses
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect(rowAt(await listingRows(page), '0939')?.text).toBe('.word $0e06');
  });
});

test('the Memory tab finds text as PETSCII and as screen codes, and bytes, and steps through the hits', async ({ page }) => {
  await waitForListing(page);
  await page.getByRole('tab', { name: 'Memory' }).click();
  const q = page.getByLabel('Find in memory'), status = page.getByLabel('Find result');
  const bar = page.getByLabel('Memory as the VICE monitor shows it').locator('.gfxv-sel');

  await test.step('text: the title in PETSCII and the greeting in screen codes, Enter and Shift+Enter step', async () => {
    await q.fill('mimir');
    await expect(status).toHaveText('2 matches');
    await q.press('Enter');
    await expect(status).toHaveText('1 of 2 matches · PETSCII');
    await expect(bar).toContainText('$0949–$094d');
    await q.press('Enter');
    await expect(status).toHaveText('2 of 2 matches · screen codes');
    await expect(bar).toContainText('$0994–$0998');
    await q.press('Shift+Enter');
    await expect(status).toHaveText('1 of 2 matches · PETSCII');
    await expect(page.locator('.mon-b.hit, .mon-b.hit-cur')).toHaveCount(10);
  });

  await test.step('bytes: hex pairs with ?? for any byte, and an error for what is no byte', async () => {
    await page.getByRole('group', { name: 'Find as' }).getByRole('button', { name: 'Bytes' }).click();
    await q.fill('8d ?? d0');
    await expect(status).toContainText('matches');
    await page.getByRole('button', { name: 'Next match' }).click();
    await expect(status).toContainText('1 of');
    await q.fill('8d 2');
    await expect(status).toContainText('is not a byte');
    await expect(q).toHaveClass(/bad/);
    await q.press('Escape');
    await expect(q).toHaveValue('');
  });
});

test('patch: new code over the selected lines, marked as patched, saved as a PRG, exported, removed', async ({ workDir: work, app, page }) => {
  await waitForListing(page);
  await stubDialogs(app, { open: [join(repoDir, 'fixtures/prg/raster-demo.prg')] });
  await page.keyboard.press('Control+o');
  await expect(toast(page, 'Loaded raster-demo.prg at $0801')).toBeVisible();
  const dialog = page.getByRole('dialog');
  const code = dialog.locator('#patch-code');
  const patchedRow = (adr: string) => listing(page).locator('.row.patched', { has: page.locator('.adr', { hasText: adr }) });

  await test.step('P on a selection opens the patch dialog with the lines\' code', async () => {
    // fx_091e: lda SID_OSC3 / and #$0f / sta COLOR_RAM+999 (8 bytes), then rts
    await goTo(page, 'fx_091e');
    for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowDown');
    await expect(statusBar(page)).toContainText('sel $091e–$0925 (8 B)');
    await page.keyboard.press('p');
    await expect(dialog).toHaveAccessibleName('Patch $091e–$0925');
    await expect(code).toHaveValue(/^fx_091e:\n\s*lda SID_OSC3 .*\n\s*and #\$0f\n\s*sta COLOR_RAM\+24\*40\+39 /);
    await expect(dialog.getByRole('status')).toContainText('8 of 8 bytes');
    // each line's address and bytes beside it, as in an assembler listing
    await expect(dialog.locator('.pe-gl')).toHaveText([/^091e$/, /^091e\s*ad 1b d4$/, /^0921\s*29 0f$/, /^0923\s*8d e7 db$/]);
  });

  await test.step('the cursor starts on the first instruction; Tab goes to the next, Shift+Tab back, Enter keeps the indent', async () => {
    const caret = () => code.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionStart + 3));
    await expect(code).toBeFocused();
    expect(await caret()).toBe('lda');
    await expect(dialog.locator('.pe-gl.cur')).toHaveText(/^091e\s*ad 1b d4$/);
    await page.keyboard.press('Tab');
    expect(await caret()).toBe('and');
    await page.keyboard.press('Tab');
    expect(await caret()).toBe('sta');
    await page.keyboard.press('Tab');
    expect(await caret()).toBe('lda');
    await page.keyboard.press('Shift+Tab');
    expect(await caret()).toBe('sta');
    await expect(code).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('nop');
    await expect(code).toHaveValue(/\n        nop$/);
    // one byte too many: the line past the range is marked
    await expect(dialog.locator('.pe-gl').last()).toHaveText(/^0926\s*ea$/);
    await expect(dialog.locator('.pe-gl.past')).toHaveCount(1);
  });

  await test.step('writing over an original instruction moves it to the Original column, out of the code', async () => {
    const original = dialog.getByLabel('Original instructions written over');
    await expect(original).toHaveCount(0);
    // Tab from the new last line goes round to the first instruction: typing there writes over all of `lda SID_OSC3`
    await page.keyboard.press('Tab');
    await page.keyboard.type('lda #$02');
    await expect(original.locator('.pe-wl')).toHaveText(['', 'lda SID_OSC3', '', '', '']);
    // editing inside a line changes just that, and the original moves over too
    await page.keyboard.press('Tab');
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('1');
    await expect(code).toHaveValue(/^fx_091e:\n        lda #\$02\n        and #\$01\n        sta COLOR_RAM\+24\*40\+39 .*\n        nop$/);
    await expect(original.locator('.pe-wl')).toHaveText(['', 'lda SID_OSC3', 'and #$0f', '', '']);
    await expect(dialog.locator('.pe-gl').nth(1)).toHaveText(/^091e\s*a9 02$/);
    await expect(dialog.getByRole('status').first()).toContainText('8 of 8 bytes');
  });

  await test.step('keeping the cycle count: the cycles of each line, how many are left at the bottom, fixed times only', async () => {
    // the original: lda SID_OSC3 (4) / and #$0f (2) / sta COLOR_RAM+999 (4) = 10 cycles
    const bar = dialog.getByRole('status', { name: 'Cycles' });
    await expect(bar).toHaveCount(0);
    await dialog.locator('#patch-cycles').check();
    // lda #$02 (2) / and #$01 (2) / sta (4) / nop (2): the same
    await expect(bar).toContainText('Cycles 10 of 10');
    await expect(bar).toContainText('the same as the original');
    await expect(dialog.locator('.pe-gl .pe-cy')).toHaveText(['', '2', '2', '4', '2']);
    await expect(dialog.getByRole('button', { name: 'Apply patch' })).toBeEnabled();
    // 2 + 4, and 3 NOPs of fill
    await code.fill('  lda #$02\n  sta $d020');
    await expect(bar).toContainText('Cycles 12 of 10');
    await expect(bar).toContainText('2 too many');
    await expect(dialog.getByRole('alert')).toHaveText('The patch takes 12 cycles, 2 more than the 10 of the original.');
    await code.fill('  lda #0\n  lda #0\n  lda #0\n  lda #0');
    await expect(bar).toContainText('2 left to use');
    // a branch takes 2 or 3
    await code.fill('  bne *+2\n  sta $d020\n  lda #0');
    await expect(dialog.locator('.pe-gl .pe-cy.varies')).toHaveText(['2/3']);
    await expect(dialog.getByRole('alert')).toHaveText(/^Line 1: bne \*\+2 takes 2 or 3 cycles \(a branch, not taken or taken\), and the original has none\./);
    await expect(dialog.getByRole('button', { name: 'Apply patch' })).toBeDisabled();
    await dialog.locator('#patch-cycles').uncheck();
    await expect(bar).toHaveCount(0);
  });

  await test.step('longer code needs "Overwrite past the range"; shorter code is filled with NOPs', async () => {
    await code.fill('  lda #$02\n  sta $d020\n  sta $d021\n  nop');
    await expect(dialog.getByRole('alert')).toHaveText('The code is 9 bytes, 1 more than the 8 of the original. Tick "Overwrite past the range" to write over the bytes after it.');
    await expect(dialog.getByRole('button', { name: 'Apply patch' })).toBeDisabled();
    await dialog.locator('#patch-over').check();
    await expect(dialog.getByRole('status')).toContainText('9 of 8 bytes; 1 byte past the range, over $0926.');
    await dialog.locator('#patch-over').uncheck();
    await code.fill('  lda #$02\n  sta $d020');
    await expect(dialog.getByRole('status')).toContainText('5 of 8 bytes; the other 3 become NOP ($ea).');
    await expect(dialog.getByRole('status')).toContainText('a9 02 8d 20 d0 ea ea ea');
    await dialog.locator('#patch-name').fill('red border');
    await dialog.getByRole('button', { name: 'Apply patch' }).click();
    await expect(dialog).toBeHidden();
    await expect(toast(page, 'Patch "red border" written over $091e–$0925 (8 bytes)')).toBeVisible();
  });

  await test.step('the listing marks the patched bytes, the Explorer lists the patch, F7 verifies', async () => {
    const rows = await listingRows(page);
    expect(rowAt(rows, '091e')?.text).toMatch(/^lda #\$02/);
    expect(rowAt(rows, '0923')?.text).toBe('nop');
    expect(rows.some(r => r.text === '// ==== patch "red border": $091e-$0925, 8 bytes written over the original ====')).toBe(true);
    await expect(patchedRow('091e')).toContainText('patch red border');
    await expect(listing(page).locator('.row.patched')).toHaveCount(5);
    const list = page.getByRole('list', { name: 'Patches' });
    await expect(list.getByRole('listitem')).toHaveText([/red border\s*\$091e–\$0925$/]);
    await page.keyboard.press('F7');
    await expect(statusBar(page)).toContainText('✓ round-trip verified', { timeout: 90_000 });
  });

  await test.step('P on a patched line edits the patch', async () => {
    await goTo(page, '$091e');
    await page.keyboard.press('p');
    await expect(dialog).toHaveAccessibleName('Edit patch "red border"');
    await expect(code).toHaveValue('  lda #$02\n  sta $d020');
    await code.fill('  inc $d020');
    await dialog.getByRole('button', { name: 'Save patch' }).click();
    await expect(dialog).toBeHidden();
    expect(rowAt(await listingRows(page), '091e')?.text).toMatch(/^inc /);
    await expect(listing(page).locator('.row.patched')).toHaveCount(6);
  });

  await test.step('the switch in the Explorer turns the patch off (the original bytes) and on again', async () => {
    const sw = page.getByRole('switch', { name: 'Patch red border on' });
    const section = page.locator('.side-sec', { hasText: 'Patches' });
    await expect(sw).toBeChecked();
    await sw.uncheck();
    await expect(toast(page, 'Patch "red border" is off: $091e–$0925 has its original bytes')).toBeVisible();
    await expect(listing(page).locator('.row.patched')).toHaveCount(0);
    expect(rowAt(await listingRows(page), '091e')?.text).toMatch(/^lda SID_OSC3/);
    await expect(section.locator('.sec-sum')).toHaveText('0 of 1 on');
    await sw.check();
    await expect(listing(page).locator('.row.patched')).toHaveCount(6);
    expect(rowAt(await listingRows(page), '091e')?.text).toMatch(/^inc /);
    await expect(section.locator('.sec-sum')).toHaveText('1 on');
  });

  await test.step('saved as a PRG, and exported to patches/ as a source of its own, with the original files kept', async () => {
    const want = [0x1e, 0x09, 0xee, 0x20, 0xd0, 0xea, 0xea, 0xea, 0xea, 0xea];
    const file = join(work, 'red_border.prg');
    await stubDialogs(app, { save: file });
    await page.getByRole('button', { name: 'Save patch red border as PRG' }).click();
    await expect(toast(page, `Patch "red border" saved to ${file} (loads at $091e)`)).toBeVisible();
    expect([...readFileSync(file)]).toEqual(want);
    const out = join(work, 'export');
    await stubDialogs(app, { open: [out] });
    await page.keyboard.press('Control+e');
    await expect(toast(page, `Exported verified Kick Assembler project to ${out}`)).toBeVisible({ timeout: 90_000 });
    expect(readdirSync(join(out, 'patches'))).toEqual(['red_border.asm']);
    expect(readFileSync(join(out, 'patches', 'red_border.asm'), 'utf8')).toContain('.pc = $091e "red border"\n  inc $d020\n  .fill 5, $ea');
    expect(readFileSync(join(out, 'original', 'raster-demo.prg'))).toEqual(readFileSync(join(repoDir, 'fixtures/prg/raster-demo.prg')));
    expect(readFileSync(join(out, 'raster-demo.asm'), 'utf8')).toContain('// ==== patch "red border": $091e-$0925, 8 bytes written over the original ====');
    expect(readFileSync(join(out, 'README.md'), 'utf8')).toContain('`patches/red_border.asm`');
  });

  await test.step('removed from the Explorer: the original bytes are back; Ctrl+Z brings the patch back', async () => {
    await page.getByRole('button', { name: 'Remove patch red border' }).click();
    await expect(toast(page, 'Patch "red border" removed: $091e–$0925 has its bytes back')).toBeVisible();
    expect(rowAt(await listingRows(page), '091e')?.text).toMatch(/^lda SID_OSC3/);
    await expect(listing(page).locator('.row.patched')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Patches' })).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(listing(page).locator('.row.patched')).toHaveCount(6);
  });
});

test('patch with the cycle count kept, where the original has a branch: the code must have the same branch', async ({ page }) => {
  await waitForListing(page);
  const dialog = page.getByRole('dialog');
  const bar = dialog.getByRole('status', { name: 'Cycles' });
  // the first `inx` / `bne` loop of the program (it colours the screen)
  const rows = await listingRows(page);
  const i = rows.findIndex((r, k) => /^inx\b/.test(r.text) && /^bne\b/.test(rows[k + 1]?.text ?? ''));
  expect(i).toBeGreaterThan(0);
  const from = parseInt(rows[i].adr, 16);
  await goTo(page, `$${from.toString(16)}-$${(from + 2).toString(16)}`);
  await page.keyboard.press('p');
  await expect(dialog).toHaveAccessibleName(/^Patch \$/);
  await dialog.locator('#patch-cycles').check();
  await expect(bar).toContainText('the same as the original');
  await expect(bar).toContainText(/varies as the original: bne \(2\/[34]\)/);
  // back in the code (the cursor is still on the first instruction): inx written over with iny, the branch is still there
  await dialog.locator('#patch-code').focus();
  await page.keyboard.type('iny');
  await expect(dialog.locator('#patch-code')).toHaveValue(/^\s*iny\n\s*bne /);
  await expect(bar).toContainText('the same as the original');
  await expect(dialog.getByRole('button', { name: 'Apply patch' })).toBeEnabled();
  // the branch written over with a nop: it is missing
  await page.keyboard.press('Tab');
  await page.keyboard.type('nop');
  await expect(dialog.locator('#patch-code')).toHaveValue(/^\s*iny\n\s*nop$/);
  await expect(bar).toContainText(/the code needs bne \(2\/[34]\), as the original has/);
  await expect(dialog.getByRole('alert')).toHaveText(/^The original has bne \(2\/[34]\), whose time varies: keeping the cycle count, the code must have the same\. It has no bne/);
  await expect(dialog.getByRole('button', { name: 'Apply patch' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});
