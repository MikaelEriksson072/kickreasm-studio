/* Graphics as files (spec 14.5): the Graphics tab saves its selection as it is (.bin), with a load address (.prg, or
 * .64c for a charset), as a picture C64 paint programs open (Koala Painter, Art Studio), or as Kick Assembler source
 * with .byte rows shaped like the graphics (a screen: a row of 40 screen codes a line). A picture gets the colours the
 * tab shows: one set for the whole picture. */
import type { Addr } from '../types';
import { h2, h4 } from '../util/hex';
import { makePrg } from './prg';

export type GfxFileKind = 'chars' | 'sprites' | 'bitmap' | 'screens';
/** the colours of the Graphics tab: background (%00), multicolour 1 (%01) and 2 (%10), foreground (%11 / set bits) */
export interface GfxFileColors { bg: number; fg: number; mc1: number; mc2: number }

export const BITMAP_SIZE = 8000;
/** a screen matrix: 40 x 25 screen codes, in a 1 KB step whose last 8 bytes are the sprite pointers */
export const SCREEN_SIZE = 1000;
export const KOALA_LOAD = 0x6000;
export const ART_STUDIO_LOAD = 0x2000;

/** the first 8000 bytes, padded with zeros when there are fewer */
const bitmapOf = (bytes: Uint8Array) => { const b = new Uint8Array(BITMAP_SIZE); b.set(bytes.subarray(0, BITMAP_SIZE)); return b; };

/**
 * A Koala Painter picture: load address $6000, the 8000-byte multicolour bitmap, the screen matrix (%01 the high and %10
 * the low nibble), colour RAM (%11) and the background (%00): 10003 bytes.
 */
export function koalaPicture(bitmap: Uint8Array, c: GfxFileColors): Uint8Array {
  const body = new Uint8Array(BITMAP_SIZE + 1000 + 1000 + 1);
  body.set(bitmapOf(bitmap));
  body.fill(((c.mc1 & 15) << 4) | (c.mc2 & 15), BITMAP_SIZE, BITMAP_SIZE + 1000);
  body.fill(c.fg & 15, BITMAP_SIZE + 1000, BITMAP_SIZE + 2000);
  body[BITMAP_SIZE + 2000] = c.bg & 15;
  return makePrg(KOALA_LOAD, body);
}

/**
 * An Art Studio hires picture: load address $2000, the 8000-byte bitmap, the screen matrix (set bits the high nibble,
 * clear bits the low one), the border colour and six bytes of padding: 9009 bytes.
 */
export function artStudioPicture(bitmap: Uint8Array, c: GfxFileColors): Uint8Array {
  const body = new Uint8Array(BITMAP_SIZE + 1000 + 1 + 6);
  body.set(bitmapOf(bitmap));
  body.fill(((c.fg & 15) << 4) | (c.bg & 15), BITMAP_SIZE, BITMAP_SIZE + 1000);
  body[BITMAP_SIZE + 1000] = c.bg & 15;
  return makePrg(ART_STUDIO_LOAD, body);
}

const bin = (b: number) => `%${b.toString(2).padStart(8, '0')}`;
const hex = (b: number) => `$${h2(b)}`;
const row = (vals: string[]) => `        .byte ${vals.join(',')}`;

/**
 * The bytes as Kick Assembler source: a comment saying what they are, a label and .byte rows shaped like the graphics.
 * Characters get one binary byte a line (eight lines a character, so the shape shows), sprites three binary bytes a
 * line (21 lines and the padding byte), bitmaps hex in rows of eight (a cell each), screens a row of 40 hex screen codes a
 * line (per 1 KB, with the 24 bytes after the 1000 on a line of their own). Anything else: hex, 16 a row.
 */
export function gfxSource(kind: GfxFileKind | 'bytes', label: string, start: Addr, bytes: Uint8Array): string {
  const end = start + bytes.length - 1;
  const what = kind === 'chars' ? `${Math.ceil(bytes.length / 8)} characters` : kind === 'sprites' ? `${Math.ceil(bytes.length / 64)} sprites`
    : kind === 'bitmap' ? 'a bitmap' : kind === 'screens' ? (n => `${n} screen${n === 1 ? '' : 's'}`)(Math.ceil(bytes.length / 0x400)) : 'data';
  const out = [`// ${label}: $${h4(start)}-$${h4(end)}, ${bytes.length} bytes (${what}), saved by KickReasm Studio`,
    `// .import source "${label}.asm" puts it where the .pc is, or paste it`, '', `${label}:`];
  const at = (i: number) => h4(start + i);
  if (kind === 'chars') {
    for (let i = 0; i < bytes.length; i++) {
      if (i % 8 === 0) out.push(`        // char ${i / 8} at $${at(i)}`);
      out.push(row([bin(bytes[i])]));
    }
  } else if (kind === 'sprites') {
    for (let s = 0; s < bytes.length; s += 64) {
      out.push(`        // sprite ${s / 64} at $${at(s)}: pointer $${h2(((start + s) & 0x3fff) >> 6)} in its VIC bank`);
      for (let y = s; y < Math.min(bytes.length, s + 63); y += 3) out.push(row([...bytes.subarray(y, Math.min(y + 3, s + 63, bytes.length))].map(bin)));
      if (s + 63 < bytes.length) out.push(`${row([hex(bytes[s + 63])])}    // padding`);
    }
  } else if (kind === 'screens') {
    for (let s = 0; s < bytes.length; s += 0x400) {
      out.push(`        // screen ${s / 0x400} at $${at(s)}: 25 rows of 40 screen codes`);
      const e = Math.min(bytes.length, s + SCREEN_SIZE), k = Math.min(bytes.length, s + 0x400);
      for (let i = s; i < e; i += 40) out.push(row([...bytes.subarray(i, Math.min(i + 40, e))].map(hex)));
      if (e < k) out.push('        // then 16 unused bytes and the 8 sprite pointers', row([...bytes.subarray(e, k)].map(hex)));
    }
  } else {
    const per = kind === 'bitmap' ? 8 : 16;
    for (let i = 0; i < bytes.length; i += per) {
      if (kind === 'bitmap' && i % 320 === 0) out.push(`        // row ${i / 320}`);
      out.push(row([...bytes.subarray(i, i + per)].map(hex)));
    }
  }
  return out.join('\n') + '\n';
}
