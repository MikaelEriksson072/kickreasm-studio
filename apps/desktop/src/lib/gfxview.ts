/* The memory graphics browser (spec 14.5): all 64 KB drawn as characters, sprites, bitmaps or screens, ICU64-style,
 * and pictures made of a font per character row. Pure geometry and drawing, so the view and the tests share them. */
import { DEMO_FONT, type Addr } from '@mimir/core';
import { C64, hexRgb } from './palette';

/** `fontrows`: a picture of up to 25 character rows, each drawn with its own font (2 KB, the one after the font of the row
 *  above) and the same 40 screen codes (the first row of the screen) */
export type GfxKind = 'chars' | 'sprites' | 'bitmap' | 'screens' | 'fontrows';

export interface GfxLayout {
  kind: GfxKind;
  /** bytes per cell: a character (8), a sprite (64), a bitmap frame (8192: one per 8 KB, of which 8000 are shown), a
   *  screen (1024: one per 1 KB, as the VIC places them, of which 1000 are shown) */
  unit: number;
  cols: number;
  /** cell size and the gap after it, in pixels at zoom 1 */
  cellW: number; cellH: number; gapX: number; gapY: number;
  /** the first cell starts here (0..unit-1): moves the grid by bytes to find data that is not aligned; a font per row:
   *  the first font */
  offset: number;
  rows: number;
  width: number; height: number;
  /** a font per row: the 40 screen codes every row shows, and the font of each row (2 KB apart, where a font can be) */
  codes?: Uint8Array;
  rowStarts?: Addr[];
}

/** bytes a bitmap frame shows: 40 x 25 cells of 8 bytes */
export const BITMAP_BYTES = 8000;
/** bytes a screen shows: 40 x 25 screen codes */
export const SCREEN_BYTES = 1000;

export function gfxLayout(kind: GfxKind, cols: number, offset = 0): GfxLayout {
  const g = kind === 'chars' ? { unit: 8, cellW: 8, cellH: 8, gapX: 0, gapY: 0, cols }
    : kind === 'sprites' ? { unit: 64, cellW: 24, cellH: 21, gapX: 2, gapY: 2, cols }
      : kind === 'screens' ? { unit: 0x400, cellW: 320, cellH: 200, gapX: 8, gapY: 8, cols }
        : { unit: 0x2000, cellW: 320, cellH: 200, gapX: 0, gapY: 8, cols: 1 };
  const off = ((offset % g.unit) + g.unit) % g.unit;
  const rows = Math.ceil((0x10000 - off) / (g.unit * g.cols));
  return { kind, ...g, offset: off, rows, width: g.cols * (g.cellW + g.gapX), height: rows * (g.cellH + g.gapY) };
}

/** the most character rows a font-per-row picture has: a screen's */
export const FONT_ROWS = 25;

/** Memory a font (2 KB) cannot be in, as the VIC and the system see it. */
export const NO_FONT: { start: Addr; end: Addr; why: string }[] = [
  { start: 0x0000, end: 0x0800, why: 'zero page, stack and screen' },
  { start: 0x1000, end: 0x2000, why: 'the VIC sees the character ROM there' },
  { start: 0x9000, end: 0xa000, why: 'the VIC sees the character ROM there' },
  { start: 0xd000, end: 0xe000, why: 'I/O and colour RAM' },
];
/** why no font can be at `a` (its 2 KB touch such memory), or null */
export const noFont = (a: Addr) => NO_FONT.find(z => a < z.end && a + 0x800 > z.start) ?? null;

/**
 * The fonts of a font-per-row picture: from `first` in 2 KB steps, one per row, up to `rows` and not past $ffff. With
 * `skip`, a step where no font can be is passed over and the row takes the next one; `skipped` says which and why.
 */
export function fontRowStarts(first: Addr, rows: number, skip = true): { starts: Addr[]; skipped: { at: Addr; why: string }[] } {
  const starts: Addr[] = [], skipped: { at: Addr; why: string }[] = [];
  for (let a = first; a <= 0xffff && starts.length < Math.min(rows, FONT_ROWS); a += 0x800) {
    const z = skip ? noFont(a) : null;
    if (z) skipped.push({ at: a, why: z.why }); else starts.push(a);
  }
  return { starts, skipped };
}

/**
 * A picture of character rows, row r drawn with the font (256 characters, 2 KB) at `starts[r]` and the 40 screen
 * `codes`. A cell is a row: its font.
 */
export function fontRowsLayout(starts: Addr[], codes: ArrayLike<number>): GfxLayout {
  const rowStarts = starts.length ? starts.slice(0, FONT_ROWS) : [0];
  const c = new Uint8Array(40); for (let i = 0; i < 40; i++) c[i] = codes[i] ?? i;
  const n = rowStarts.length;
  return { kind: 'fontrows', unit: 0x800, cols: 1, cellW: 320, cellH: 8, gapX: 0, gapY: 0, offset: rowStarts[0], rows: n, width: 320, height: n * 8, codes: c, rowStarts };
}

/** the bytes of one row of cells */
export const rowBytes = (L: GfxLayout) => L.unit * L.cols;
/** the address of the first byte in row `r` (`rows`: just past the last row) */
export const rowAddr = (L: GfxLayout, r: number) => {
  const s = L.rowStarts;
  return s ? (r < s.length ? s[r] : s[s.length - 1] + 0x800) : L.offset + r * rowBytes(L);
};

/** the cell under a point (pixels at zoom 1), as the address of its first byte; null in a gap or past the end */
export function cellAt(L: GfxLayout, x: number, y: number): Addr | null {
  const c = Math.floor(x / (L.cellW + L.gapX)), r = Math.floor(y / (L.cellH + L.gapY));
  if (c < 0 || c >= L.cols || r < 0 || r >= L.rows) return null;
  if (x - c * (L.cellW + L.gapX) >= L.cellW || y - r * (L.cellH + L.gapY) >= L.cellH) return null;
  const a = rowAddr(L, r) + c * L.unit;
  return a < 0x10000 ? a : null;
}

/** the cell holding `a`: its first byte and where it is drawn */
export function cellOf(L: GfxLayout, a: Addr): { start: Addr; x: number; y: number; w: number; h: number } | null {
  if (a < L.offset || a > 0xffff) return null;
  if (L.rowStarts) {
    // a font per row: the row whose font holds `a` (none in memory the rows skip)
    const r = L.rowStarts.findIndex(s => a >= s && a < s + L.unit);
    return r < 0 ? null : { start: L.rowStarts[r], x: 0, y: r * L.cellH, w: L.cellW, h: L.cellH };
  }
  const k = Math.floor((a - L.offset) / L.unit), r = Math.floor(k / L.cols), c = k % L.cols;
  if (r >= L.rows) return null;
  return { start: L.offset + k * L.unit, x: c * (L.cellW + L.gapX), y: r * (L.cellH + L.gapY), w: L.cellW, h: L.cellH };
}

/** the byte under a point (pixels at zoom 1): a character's row, a sprite's byte, a bitmap cell's row, a screen code */
export function byteAt(L: GfxLayout, x: number, y: number): Addr | null {
  const start = cellAt(L, x, y);
  if (start == null) return null;
  const xi = Math.floor(x % (L.cellW + L.gapX)), yi = Math.floor(y % (L.cellH + L.gapY));
  const a = L.kind === 'chars' ? start + yi : L.kind === 'sprites' ? start + yi * 3 + (xi >> 3)
    : L.kind === 'screens' ? start + (yi >> 3) * 40 + (xi >> 3)
      // a font per row: the character's line in the row's font
      : L.kind === 'fontrows' ? start + L.codes![xi >> 3] * 8 + yi
        : start + ((yi >> 3) * 40 + (xi >> 3)) * 8 + (yi & 7);
  return a <= 0xffff ? a : null;
}

/** the bytes a cell stands for (a bitmap frame: 8000, not the 8 KB step; a screen: 1000, not the 1 KB step) */
export const cellBytes = (L: GfxLayout) => (L.kind === 'bitmap' ? BITMAP_BYTES : L.kind === 'screens' ? SCREEN_BYTES : L.unit);

/** whole cells from the cell holding `a` to the one holding `b` (either order), as [start, end) */
export function cellRange(L: GfxLayout, a: Addr, b: Addr): { start: Addr; end: Addr } | null {
  const x = cellOf(L, Math.min(a, b)), y = cellOf(L, Math.max(a, b));
  if (!x || !y) return null;
  return { start: x.start, end: Math.min(0x10000, y.start + cellBytes(L)) };
}

/** the rectangles a range covers, one per row (cells are drawn row by row) */
export function rangeRects(L: GfxLayout, start: Addr, end: Addr): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  // a font per row: every row whose font the range touches
  if (L.rowStarts) return L.rowStarts.flatMap((s, r) => (s < end && s + L.unit > start ? [{ x: 0, y: r * L.cellH, w: L.cellW, h: L.cellH }] : []));
  const a = cellOf(L, Math.max(start, L.offset)), b = cellOf(L, Math.min(end, 0x10000, rowAddr(L, L.rows)) - 1);
  if (!a || !b || end <= start) return out;
  const stepX = L.cellW + L.gapX, stepY = L.cellH + L.gapY;
  for (let y = a.y; y <= b.y; y += stepY) {
    const x0 = y === a.y ? a.x : 0, x1 = y === b.y ? b.x + L.cellW : (L.cols - 1) * stepX + L.cellW;
    out.push({ x: x0, y, w: x1 - x0, h: L.cellH });
  }
  return out;
}

/** the 2 KB charset (VIC alignment) around `a` */
export const charsetAround = (a: Addr) => ({ start: a & 0xf800, end: (a & 0xf800) + 0x800 });
/** the 8 KB-aligned bitmap around `a` (8000 bytes) */
export const bitmapAround = (a: Addr) => ({ start: a & 0xe000, end: (a & 0xe000) + BITMAP_BYTES });
/** what the VIC calls the sprite at `a`: its pointer value (in its 16 KB bank) and the bank */
export const spritePointer = (a: Addr) => ({ pointer: (a & 0x3fff) >> 6, bank: a >> 14 });
/** what the VIC calls the screen at `a` (1 KB aligned): the high nibble of $d018 and the bank; null when not aligned */
export const screenPointer = (a: Addr) => ((a & 0x3ff) === 0 ? { d018: (a & 0x3fff) >> 10, bank: a >> 14 } : null);

/** screen code order of the built-in letters: @, A-Z, then space to ? (the graphics are left empty) */
const SCREEN_ORDER = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[£]↑← !"#$%&\'()*+,-./0123456789:;<=>?';

/**
 * A 2 KB charset to draw screens with when VICE's character ROM is not found: the demo font's letters, digits and
 * punctuation at their screen codes, codes 128-255 reversed.
 */
export function builtinFont(): Uint8Array {
  const f = new Uint8Array(0x800);
  [...SCREEN_ORDER].forEach((c, code) => { const g = DEMO_FONT[c]; if (g) for (let y = 0; y < 8; y++) f[code * 8 + y] = parseInt(g.slice(y * 2, y * 2 + 2), 16); });
  for (let i = 0; i < 0x400; i++) f[0x400 + i] = f[i] ^ 0xff;
  return f;
}

export interface GfxColors { bg: number; fg: number; mc1: number; mc2: number }

/**
 * Draw all memory in layout `L` into RGBA `px` (L.width x L.height): hires, or multicolor (pairs of bits: bg, mc1, mc2,
 * fg). Screens draw each screen code with `font` (2 KB). Bytes that are not loaded are drawn dark, so the program
 * stands out; gaps get `gap`.
 */
export function drawMemory(px: Uint8ClampedArray, L: GfxLayout, mem: Uint8Array, loaded: (a: Addr) => boolean, mc: boolean, colors: GfxColors, font?: Uint8Array, gap: [number, number, number] = [24, 24, 32]): void {
  const pal = [colors.bg, colors.mc1, colors.mc2, colors.fg].map(i => hexRgb(C64[i & 15]));
  // not loaded: a blue-grey of its own, so it differs from loaded bytes in any colours (a black background too)
  const dimmed = pal.map(([r, g, b]) => [r * 0.25 + 34, g * 0.25 + 34, b * 0.25 + 52]);
  for (let i = 0; i < px.length; i += 4) { px[i] = gap[0]; px[i + 1] = gap[1]; px[i + 2] = gap[2]; px[i + 3] = 255; }
  const put = (x: number, y: number, c: number[]) => { const o = (y * L.width + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; };
  const bits = (b: number, p: number[][], x: number, y: number) => {
    if (mc) for (let k = 0; k < 4; k++) { const c = p[(b >> (6 - k * 2)) & 3]; put(x + k * 2, y, c); put(x + k * 2 + 1, y, c); }
    else for (let k = 0; k < 8; k++) put(x + k, y, (b >> (7 - k)) & 1 ? p[3] : p[0]);
  };
  const byte = (a: Addr, x: number, y: number) => { if (a <= 0xffff) bits(mem[a], loaded(a) ? pal : dimmed, x, y); };
  const f = L.kind === 'screens' ? font ?? builtinFont() : null;
  const stepX = L.cellW + L.gapX, stepY = L.cellH + L.gapY;
  for (let r = 0; r < L.rows; r++) for (let c = 0; c < L.cols; c++) {
    const base = rowAddr(L, r) + c * L.unit, ox = c * stepX, oy = r * stepY;
    if (base > 0xffff) continue;
    if (L.kind === 'chars') for (let y = 0; y < 8; y++) byte(base + y, ox, oy + y);
    else if (L.kind === 'sprites') for (let y = 0; y < 21; y++) for (let k = 0; k < 3; k++) byte(base + y * 3 + k, ox + k * 8, oy + y);
    else if (L.kind === 'fontrows') for (let x = 0; x < 40; x++) for (let y = 0; y < 8; y++) byte(base + L.codes![x] * 8 + y, x * 8, oy + y);
    else if (f) for (let i = 0; i < SCREEN_BYTES && base + i <= 0xffff; i++) {
      const p = loaded(base + i) ? pal : dimmed, g = mem[base + i] * 8, x = ox + (i % 40) * 8, y0 = oy + Math.floor(i / 40) * 8;
      for (let y = 0; y < 8; y++) bits(f[g + y], p, x, y0 + y);
    }
    else for (let cy = 0; cy < 25; cy++) for (let cx = 0; cx < 40; cx++) for (let y = 0; y < 8; y++) byte(base + (cy * 40 + cx) * 8 + y, ox + cx * 8, oy + cy * 8 + y);
  }
}

/**
 * The selection as an image at 1x, drawn as the tab draws it but without the gaps: characters 16 to a row, sprites 8, a
 * bitmap or a screen as 320 x 200 (multicolour pixels two wide; screens drawn with `font`, one per 1 KB), the fonts of a
 * font-per-row picture as its rows (each 320 x 8, with the 40 `codes`). Cells past the end of the selection stay
 * transparent.
 */
export function gfxImage(kind: GfxKind, mem: Uint8Array, start: Addr, end: Addr, mc: boolean, colors: GfxColors, opts: { font?: Uint8Array; codes?: ArrayLike<number>; rows?: Addr[] } = {}): { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> } {
  const pal = [colors.bg, colors.mc1, colors.mc2, colors.fg].map(i => hexRgb(C64[i & 15]));
  const g = kind === 'chars' ? { unit: 8, w: 8, h: 8, per: 16 } : kind === 'sprites' ? { unit: 64, w: 24, h: 21, per: 8 }
    : kind === 'screens' ? { unit: 0x400, w: 320, h: 200, per: 1 } : kind === 'fontrows' ? { unit: 0x800, w: 320, h: 8, per: 1 }
      : { unit: BITMAP_BYTES, w: 320, h: 200, per: 1 };
  // a font per row: the rows whose font lies in the selection (memory the picture skips is no row)
  const bases = kind === 'fontrows' && opts.rows ? opts.rows.filter(a => a >= start && a < end) : null;
  const n = bases ? Math.max(1, bases.length) : Math.max(1, Math.ceil((end - start) / g.unit)), cols = Math.min(g.per, n), rows = Math.ceil(n / cols);
  const width = cols * g.w, height = rows * g.h, rgba = new Uint8ClampedArray(width * height * 4);
  const put = (x: number, y: number, c: number[]) => { const o = (y * width + x) * 4; rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255; };
  const bits = (b: number, x: number, y: number) => {
    if (mc) for (let k = 0; k < 4; k++) { const c = pal[(b >> (6 - k * 2)) & 3]; put(x + k * 2, y, c); put(x + k * 2 + 1, y, c); }
    else for (let k = 0; k < 8; k++) put(x + k, y, (b >> (7 - k)) & 1 ? pal[3] : pal[0]);
  };
  const byte = (a: Addr, x: number, y: number) => { if (a < end && a <= 0xffff) bits(mem[a], x, y); };
  const f = kind === 'screens' ? opts.font ?? builtinFont() : null;
  for (let i = 0; i < n; i++) {
    const base = bases ? bases[i] ?? start : start + i * g.unit, ox = (i % cols) * g.w, oy = Math.floor(i / cols) * g.h;
    if (kind === 'chars') for (let y = 0; y < 8; y++) byte(base + y, ox, oy + y);
    else if (kind === 'sprites') for (let y = 0; y < 21; y++) for (let k = 0; k < 3; k++) byte(base + y * 3 + k, ox + k * 8, oy + y);
    else if (kind === 'fontrows') for (let x = 0; x < 40; x++) for (let y = 0; y < 8; y++) byte(base + (opts.codes?.[x] ?? x) * 8 + y, x * 8, oy + y);
    else if (f) for (let j = 0; j < SCREEN_BYTES && base + j < end && base + j <= 0xffff; j++) {
      const code = mem[base + j];
      for (let y = 0; y < 8; y++) bits(f[code * 8 + y], ox + (j % 40) * 8, oy + Math.floor(j / 40) * 8 + y);
    }
    else for (let cy = 0; cy < 25; cy++) for (let cx = 0; cx < 40; cx++) for (let y = 0; y < 8; y++) byte(base + (cy * 40 + cx) * 8 + y, ox + cx * 8, oy + cy * 8 + y);
  }
  return { width, height, rgba };
}
