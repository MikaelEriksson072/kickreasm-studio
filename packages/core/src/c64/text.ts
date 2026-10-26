/* =====================================================================
 * Text encodings: which bytes a `.text` string can write, and how.
 * The characters follow Kick Assembler 5.25's tables (measured with KickAss.jar). Only characters that
 * show what the C64 shows are used: a byte without one (inverse, graphics, ", £, ↑, ←, control codes)
 * is written as `.byte`, which keeps the output byte-exact.
 * ===================================================================== */
import type { TextEncoding } from '../types';

export interface TextEncodingInfo {
  /** the Kick Assembler `.encoding` name */
  kick: string;
  /** shown in block titles and menus */
  label: string;
  /** the character written in `.text` for a byte, or null for `.byte` */
  char: (b: number) => string | null;
}

const at = String.fromCharCode;
/** $20-$3f: digits and punctuation, the same in every table (" ends the string) */
const punct = (b: number) => (b >= 0x20 && b <= 0x3f && b !== 0x22 ? at(b) : null);

export const TEXT_ENCODINGS: Record<TextEncoding, TextEncodingInfo> = {
  petscii: { kick: 'petscii_upper', label: 'PETSCII', char: b => (b >= 0x20 && b <= 0x5d && b !== 0x22 && b !== 0x5c ? at(b) : null) },
  // the lower case character set: $41-$5a are lower case letters, $c1-$da upper case
  'petscii-mixed': {
    kick: 'petscii_mixed', label: 'PETSCII, mixed case',
    char: b => (b >= 0x41 && b <= 0x5a ? at(b + 0x20) : b >= 0xc1 && b <= 0xda ? at(b - 0x80) : b >= 0x20 && b <= 0x5d && b !== 0x22 && b !== 0x5c ? at(b) : null),
  },
  screen: { kick: 'screencode_upper', label: 'screen codes', char: b => (b <= 0x1b || b === 0x1d ? at(b + 0x40) : punct(b)) },
  // the lower case character set: $01-$1a are lower case letters, $41-$5a upper case
  'screen-mixed': {
    kick: 'screencode_mixed', label: 'screen codes, mixed case',
    char: b => (b === 0 || b === 0x1b || b === 0x1d ? at(b + 0x40) : b <= 0x1a ? at(b + 0x60) : b >= 0x41 && b <= 0x5a ? at(b) : punct(b)),
  },
};

export const textEncoding = (enc: TextEncoding | undefined): TextEncodingInfo => TEXT_ENCODINGS[enc ?? 'petscii'] ?? TEXT_ENCODINGS.petscii;
