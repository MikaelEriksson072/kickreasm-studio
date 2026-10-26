/* The memory graphics browser's geometry and drawing (src/lib/gfxview.ts). */
import { describe, expect, it } from 'vitest';
import { bitmapAround, builtinFont, byteAt, cellAt, cellOf, cellRange, charsetAround, drawMemory, fontRowsLayout, fontRowStarts, gfxImage, noFont, gfxLayout, rangeRects, rowAddr, screenPointer, spritePointer } from '../src/lib/gfxview';
import { C64, hexRgb } from '../src/lib/palette';

describe('memory graphics layout', () => {
  it('lays all 64 KB out as characters, sprites or 8 KB bitmaps', () => {
    expect(gfxLayout('chars', 32)).toMatchObject({ unit: 8, rows: 256, width: 256, height: 2048 });
    expect(gfxLayout('sprites', 8)).toMatchObject({ unit: 64, rows: 128, width: 8 * 26, height: 128 * 23 });
    expect(gfxLayout('bitmap', 1)).toMatchObject({ unit: 0x2000, cols: 1, rows: 8, width: 320, height: 8 * 208 });
    // the offset moves the grid by bytes, within one cell
    expect(gfxLayout('chars', 32, 3)).toMatchObject({ offset: 3, rows: 256 });
    expect(gfxLayout('chars', 32, -1).offset).toBe(7);
    expect(rowAddr(gfxLayout('chars', 32, 3), 2)).toBe(3 + 512);
  });

  it('finds the cell and the byte under a point, and back', () => {
    const L = gfxLayout('chars', 32);
    expect(cellAt(L, 0, 0)).toBe(0);
    expect(cellAt(L, 8 * 5 + 3, 8 * 2 + 7)).toBe(2 * 256 + 5 * 8);
    expect(byteAt(L, 8 * 5 + 3, 8 * 2 + 7)).toBe(2 * 256 + 5 * 8 + 7);
    expect(cellOf(L, 0x3008)).toEqual({ start: 0x3008, x: 8, y: 0x30 * 8, w: 8, h: 8 });
    const S = gfxLayout('sprites', 8);
    // a sprite's byte: three per line
    expect(byteAt(S, 26 + 17, 4)).toBe(64 + 4 * 3 + 2);
    // the gap between sprites is no cell
    expect(cellAt(S, 25, 0)).toBeNull();
    const B = gfxLayout('bitmap', 1);
    expect(cellAt(B, 10, 208 + 5)).toBe(0x2000);
    expect(byteAt(B, 8 * 3 + 1, 208 + 8 * 2 + 5)).toBe(0x2000 + (2 * 40 + 3) * 8 + 5);
    expect(cellAt(B, 10, 205)).toBeNull();
  });

  it('selects whole cells, either way round, and gives the rectangles per row', () => {
    const L = gfxLayout('chars', 32);
    expect(cellRange(L, 0x3013, 0x3001)).toEqual({ start: 0x3000, end: 0x3018 });
    expect(cellRange(gfxLayout('sprites', 8), 0x2005, 0x2005)).toEqual({ start: 0x2000, end: 0x2040 });
    expect(cellRange(gfxLayout('bitmap', 1), 0x2100, 0x2100)).toEqual({ start: 0x2000, end: 0x2000 + 8000 });
    // $30f0-$3110: the last two characters of one row, then three of the next
    expect(rangeRects(L, 0x30f0, 0x3118)).toEqual([{ x: 30 * 8, y: 0x30 * 8, w: 16, h: 8 }, { x: 0, y: 0x31 * 8, w: 24, h: 8 }]);
    expect(rangeRects(L, 0x3000, 0x3800)).toHaveLength(8);
  });

  it('knows charsets, bitmaps and sprite pointers the way the VIC sees them', () => {
    expect(charsetAround(0x3456)).toEqual({ start: 0x3000, end: 0x3800 });
    expect(bitmapAround(0x5123)).toEqual({ start: 0x4000, end: 0x4000 + 8000 });
    expect(spritePointer(0x2000)).toEqual({ pointer: 0x80, bank: 0 });
    expect(spritePointer(0x7fc0)).toEqual({ pointer: 0xff, bank: 1 });
  });
});

describe('memory graphics drawing', () => {
  it('draws set bits in the foreground, and bytes that are not loaded in a colour of their own', () => {
    const L = gfxLayout('chars', 1), mem = new Uint8Array(0x10000);
    mem[0] = 0b10000001;
    const px = new Uint8ClampedArray(L.width * L.height * 4);
    drawMemory(px, L, mem, a => a < 8, false, { bg: 0, fg: 1, mc1: 15, mc2: 12 });
    const at = (x: number, y: number) => [...px.subarray((y * L.width + x) * 4, (y * L.width + x) * 4 + 3)];
    expect([at(0, 0), at(1, 0), at(7, 0)]).toEqual([[255, 255, 255], [0, 0, 0], [255, 255, 255]]);
    // the next character is not loaded: not black although its bytes are 0
    expect(at(0, 8)).not.toEqual([0, 0, 0]);
    // multicolor: bit pairs, two pixels wide (%10 is mc2, grey $0c)
    mem[0] = 0b10000000;
    drawMemory(px, L, mem, () => true, true, { bg: 0, fg: 1, mc1: 15, mc2: 12 });
    expect([at(0, 0), at(1, 0), at(2, 0)]).toEqual([[0x6c, 0x6c, 0x6c], [0x6c, 0x6c, 0x6c], [0, 0, 0]]);
  });
});

describe('the image of a selection (Save → .png)', () => {
  const colors = { bg: 0, fg: 1, mc1: 2, mc2: 5 };
  const rgb = (img: { width: number; rgba: Uint8ClampedArray }, x: number, y: number) => { const o = (y * img.width + x) * 4; return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2], img.rgba[o + 3]]; };
  const of = (i: number) => [...hexRgb(C64[i]), 255];
  const mem = new Uint8Array(0x10000);
  mem[0x3000] = 0b10000001; mem[0x3008] = 0xff;
  mem[0x2000] = 0b01_10_11_00;

  it('draws characters 16 to a row without gaps, the rest transparent', () => {
    const img = gfxImage('chars', mem, 0x3000, 0x3010, false, colors);
    expect([img.width, img.height]).toEqual([16, 8]);
    expect(rgb(img, 0, 0)).toEqual(of(1));
    expect(rgb(img, 1, 0)).toEqual(of(0));
    expect(rgb(img, 7, 0)).toEqual(of(1));
    expect(rgb(img, 8, 0)).toEqual(of(1));
    const many = gfxImage('chars', mem, 0x3000, 0x3000 + 17 * 8, false, colors);
    expect([many.width, many.height]).toEqual([128, 16]);
    expect(rgb(many, 127, 15)[3]).toBe(0);
  });

  it('draws sprites 8 to a row and bitmaps as 320 x 200, multicolour pixels two wide', () => {
    const img = gfxImage('sprites', mem, 0x2000, 0x2080, true, colors);
    expect([img.width, img.height]).toEqual([48, 21]);
    expect([0, 2, 4, 6].map(x => rgb(img, x, 0))).toEqual([of(2), of(5), of(1), of(0)]);
    expect(rgb(img, 1, 0)).toEqual(of(2));
    const bm = gfxImage('bitmap', mem, 0x2000, 0x2000 + 8000, true, colors);
    expect([bm.width, bm.height]).toEqual([320, 200]);
    expect(rgb(bm, 0, 0)).toEqual(of(2));
  });
});

describe('screens', () => {
  const colors = { bg: 6, fg: 14, mc1: 2, mc2: 5 };
  const font = new Uint8Array(0x800);
  font[1 * 8] = 0b11000000; // code 1, its top row
  font[2 * 8 + 7] = 0xff; // code 2, its bottom row

  it('lays memory out as a screen per 1 KB, 40 x 25 screen codes of which a point is one', () => {
    const L = gfxLayout('screens', 2);
    expect(L).toMatchObject({ unit: 0x400, cols: 2, rows: 32, width: 2 * 328, height: 32 * 208 });
    expect(cellAt(L, 328 + 5, 208 + 5)).toBe(0x0c00);
    expect(byteAt(L, 8 * 3 + 1, 208 + 8 * 2 + 7)).toBe(0x0800 + 2 * 40 + 3);
    // the gap, and the rows below the 25th, are no screen
    expect(cellAt(L, 322, 0)).toBeNull();
    expect(cellRange(L, 0x0410, 0x0410)).toEqual({ start: 0x0400, end: 0x0400 + 1000 });
    expect(cellRange(gfxLayout('screens', 1, 0x345), 0x2345, 0x2345)).toEqual({ start: 0x2345, end: 0x2345 + 1000 });
    expect(screenPointer(0x0400)).toEqual({ d018: 1, bank: 0 });
    expect(screenPointer(0x6c00)).toEqual({ d018: 0xb, bank: 1 });
    expect(screenPointer(0x2345)).toBeNull();
  });

  it('draws each screen code with the charset, dark where nothing is loaded', () => {
    const L = gfxLayout('screens', 1), mem = new Uint8Array(0x10000);
    mem[0x0400] = 1; mem[0x0401] = 2; mem[0x0428] = 1;
    const px = new Uint8ClampedArray(L.width * L.height * 4);
    drawMemory(px, L, mem, a => a >= 0x0400 && a < 0x0800, false, colors, font);
    const at = (x: number, y: number) => [...px.subarray((y * L.width + x) * 4, (y * L.width + x) * 4 + 3)];
    const fg = hexRgb(C64[14]), bg = hexRgb(C64[6]), y0 = 208;
    expect([at(0, y0), at(1, y0), at(2, y0)]).toEqual([fg, fg, bg]);
    expect([at(8, y0 + 7), at(15, y0 + 7), at(8, y0)]).toEqual([fg, fg, bg]);
    // the next row of the screen starts 40 codes later
    expect(at(0, y0 + 8)).toEqual(fg);
    // the screen at $0000 is not loaded
    expect(at(2, 0)).not.toEqual(bg);
  });

  it('draws the built-in letters when there is no charset, and saves a screen as a 320 x 200 image', () => {
    const f = builtinFont();
    expect(f.length).toBe(0x800);
    // A is screen code 1, 0 is 48, and 129 is A reversed
    expect([...f.subarray(8, 16)]).toEqual([0x7c, 0xc6, 0xc6, 0xfe, 0xc6, 0xc6, 0xc6, 0x00]);
    expect(f[48 * 8]).toBe(0x7c);
    expect([...f.subarray(129 * 8, 129 * 8 + 2)]).toEqual([0x83, 0x39]);
    const mem = new Uint8Array(0x10000);
    mem[0x6000] = 2;
    const img = gfxImage('screens', mem, 0x6000, 0x6000 + 1000, false, colors, { font });
    expect([img.width, img.height]).toEqual([320, 200]);
    const px = (x: number, y: number) => [...img.rgba.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4)];
    expect([px(0, 7), px(0, 0)]).toEqual([[...hexRgb(C64[14]), 255], [...hexRgb(C64[6]), 255]]);
    // two screens of a 2 KB selection, one under the other
    expect(gfxImage('screens', mem, 0x6000, 0x6800, false, colors, { font }).height).toBe(400);
  });
});

describe('a font per row', () => {
  const colors = { bg: 0, fg: 1, mc1: 2, mc2: 5 };
  const codes = Uint8Array.from({ length: 40 }, (_, i) => (i === 1 ? 7 : i));
  const starts = (first: number, rows: number, skip = true) => fontRowStarts(first, rows, skip).starts;

  it('takes a font every 2 KB, passing over memory where no font can be, at most 25 and not past $ffff', () => {
    expect(starts(0x2000, 4)).toEqual([0x2000, 0x2800, 0x3000, 0x3800]);
    // the VIC sees the character ROM at $1000-$1fff (and $9000-$9fff); $0000 holds the zero page, stack and screen
    expect(starts(0x0000, 4)).toEqual([0x0800, 0x2000, 0x2800, 0x3000]);
    expect(fontRowStarts(0x0800, 3).skipped).toEqual([{ at: 0x1000, why: 'the VIC sees the character ROM there' }, { at: 0x1800, why: 'the VIC sees the character ROM there' }]);
    expect(starts(0x8800, 3)).toEqual([0x8800, 0xa000, 0xa800]);
    // I/O and colour RAM; the RAM under the BASIC and Kernal ROMs is fine, the VIC reads RAM there
    expect(starts(0xc000, 25)).toEqual([0xc000, 0xc800, 0xe000, 0xe800, 0xf000, 0xf800]);
    // without skipping every 2 KB counts, and a font that is not on a 2 KB boundary is passed over where it touches such memory
    expect(starts(0x0800, 3, false)).toEqual([0x0800, 0x1000, 0x1800]);
    expect(noFont(0x0f00)?.why).toBe('the VIC sees the character ROM there');
    expect(noFont(0x2700)).toBeNull();
    expect(starts(0x2000, 40, false)).toHaveLength(25);
    // from $2000 only 24 fonts fit before $ffff once $9000, $9800, $d000 and $d800 are passed over
    expect(starts(0x2000, 25).slice(-1)).toEqual([0xf800]);
    expect(starts(0x2000, 25)).toHaveLength(24);
  });

  it('lays out a row per font; a click on a row is its font, memory it skips is none', () => {
    const L = fontRowsLayout(starts(0x0800, 4), codes);
    expect(L).toMatchObject({ kind: 'fontrows', unit: 0x800, rows: 4, width: 320, height: 32, offset: 0x0800 });
    expect([0, 1, 2, 3, 4].map(r => rowAddr(L, r))).toEqual([0x0800, 0x2000, 0x2800, 0x3000, 0x3800]);
    // a row is a cell: its font; the character's line comes from the code in its column
    expect(cellAt(L, 100, 8 + 2)).toBe(0x2000);
    expect(byteAt(L, 8 + 4, 3 * 8 + 2)).toBe(0x3000 + 7 * 8 + 2);
    expect(cellOf(L, 0x2900)).toMatchObject({ start: 0x2800, y: 16 });
    expect(cellOf(L, 0x1400)).toBeNull();
    expect(cellRange(L, 0x2900, 0x3000)).toEqual({ start: 0x2800, end: 0x3800 });
    expect(rangeRects(L, 0x0800, 0x2800)).toEqual([{ x: 0, y: 0, w: 320, h: 8 }, { x: 0, y: 8, w: 320, h: 8 }]);
  });

  it('draws each row with its own font and the same codes, also as an image of the rows selected', () => {
    const mem = new Uint8Array(0x10000);
    mem[0x0800 + 7 * 8] = 0x80; // row 0's font, char 7, top line: the first pixel of column 1
    mem[0x2000 + 7 * 8 + 1] = 0x01; // row 1's font ($1000 and $1800 skipped), second line: the last pixel of column 1
    const rows = starts(0x0800, 2), L = fontRowsLayout(rows, codes), px = new Uint8ClampedArray(L.width * L.height * 4);
    drawMemory(px, L, mem, () => true, false, colors);
    const at = (x: number, y: number) => [...px.subarray((y * L.width + x) * 4, (y * L.width + x) * 4 + 3)];
    const fg = hexRgb(C64[1]), bg = hexRgb(C64[0]);
    expect([at(8, 0), at(9, 0), at(15, 9), at(8, 9)]).toEqual([fg, bg, fg, bg]);
    const img = gfxImage('fontrows', mem, 0x0800, 0x2800, false, colors, { codes, rows });
    expect([img.width, img.height]).toEqual([320, 16]);
    expect([...img.rgba.subarray((9 * 320 + 15) * 4, (9 * 320 + 15) * 4 + 3)]).toEqual(fg);
  });
});
