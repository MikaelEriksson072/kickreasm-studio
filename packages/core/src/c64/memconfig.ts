/* =====================================================================
 * 6510 memory configuration: what the CPU sees through the port at $01.
 * Bits 0-2 (LORAM, HIRAM, CHAREN) select one of 8 configurations, with the
 * default DDR ($00 = $2f). Without a cartridge EXROM = GAME = 1; a
 * cartridge (CartMode) maps its ROM in by pulling them low.
 * Masks: bit c set = configuration c is possible.
 * ===================================================================== */
import type { Addr } from '../types';

/** `cart`: a cartridge's ROM (ROML at $8000, ROMH at $a000 or $e000), which the program's own bytes are */
export type MemArea = 'ram' | 'basic' | 'kernal' | 'io' | 'char' | 'cart';

/**
 * The memory map a cartridge gives (spec 13.9): none; 8K (EXROM low: ROML at $8000-$9fff where BASIC would be
 * visible); 16K (EXROM and GAME low: ROML there too and ROMH at $a000-$bfff in place of BASIC, wherever HIRAM is set);
 * Ultimax (GAME low: ROML at $8000, ROMH at $e000 in place of the KERNAL, I/O at $d000 whatever $01 says, and no
 * BASIC, no KERNAL and no RAM at $1000-$7fff or $a000-$cfff).
 */
export type CartMode = 'none' | '8k' | '16k' | 'ultimax';

/** $01 & 7 after power-on ($37): BASIC, I/O and KERNAL visible */
export const DEFAULT_PORT = 7;
export const ALL_PORTS = 0xff;
export const ALL_BANKS = 0x0f;

/** What address `a` reaches in configuration `c` (with a cartridge's map). Writes to the ROM areas always go to the
 *  RAM below (in Ultimax mode to nothing there, which reads the same here). */
export function areaAt(a: Addr, c: number, write: boolean, cart: CartMode = 'none'): MemArea {
  if (cart === 'ultimax') {
    if (a >= 0xd000 && a < 0xe000) return 'io';
    return !write && (a >= 0xe000 || (a >= 0x8000 && a < 0xa000)) ? 'cart' : 'ram';
  }
  if (cart !== 'none' && !write) {
    if (a >= 0x8000 && a < 0xa000 && (c & 3) === 3) return 'cart';
    if (cart === '16k' && a >= 0xa000 && a < 0xc000 && (c & 2)) return 'cart';
  }
  if (a >= 0xa000 && a < 0xc000) return !write && (c & 3) === 3 ? 'basic' : 'ram';
  if (a >= 0xe000) return !write && (c & 2) ? 'kernal' : 'ram';
  if (a >= 0xd000 && a < 0xe000) { if ((c & 3) === 0) return 'ram'; if (c & 4) return 'io'; return write ? 'ram' : 'char'; }
  return 'ram';
}

/** Is `a` in an area the port can switch ($a000-$bfff, $d000-$ffff; with a cartridge's ROML $8000-$9fff too)? */
export const banked = (a: Addr, cart: CartMode = 'none'): boolean => (a >= 0xa000 && a < 0xc000) || a >= 0xd000 || (cart !== 'none' && a >= 0x8000 && a < 0xa000);

/**
 * For an access from code that may run in the configurations of `mask`: 'hw' when it always reaches
 * I/O or ROM, 'ram' when it always reaches RAM (or the character ROM), null when that differs or is unknown.
 * A cartridge's ROM counts as RAM: it is the program's own bytes.
 */
export function reaches(a: Addr, mask: number, write: boolean, cart: CartMode = 'none'): 'hw' | 'ram' | null {
  if (cart === 'ultimax' && !write && (a >= 0xe000 || (a >= 0x8000 && a < 0xa000))) return 'ram';
  if (cart === 'ultimax' && a >= 0xd000 && a < 0xe000) return 'hw';
  if (!mask || mask === ALL_PORTS || !banked(a, cart)) return null;
  let hw = false, ram = false;
  for (let c = 0; c < 8; c++) {
    if (!(mask & (1 << c))) continue;
    const ar = areaAt(a, c, write, cart);
    if (ar === 'ram' || ar === 'char' || ar === 'cart') ram = true; else hw = true;
  }
  return hw === ram ? null : hw ? 'hw' : 'ram';
}

/**
 * `reaches` for naming an operand: where it cannot tell (the configurations differ, or $01 is unknown), an address at
 * $d000-$dfff counts as I/O, so a register keeps its name (VIC_RASTER, not var_d012) unless the code surely runs with
 * all RAM there.
 */
export function reachesForName(a: Addr, mask: number, write: boolean, cart: CartMode = 'none'): 'hw' | 'ram' | null {
  const r = reaches(a, mask, write, cart);
  return r === null && a >= 0xd000 && a < 0xe000 ? 'hw' : r;
}

/** Does code in the configurations of `mask` see I/O at $d000-$dfff: 'all', 'none' or 'some'? (Ultimax: always) */
export function ioVisible(mask: number, cart: CartMode = 'none'): 'all' | 'none' | 'some' {
  if (cart === 'ultimax') return 'all';
  let io = 0, other = 0;
  for (let c = 0; c < 8; c++) if (mask & (1 << c)) { if ((c & 3) && (c & 4)) io++; else other++; }
  return !other ? 'all' : !io ? 'none' : 'some';
}

/** "$35" style name of a configuration (the usual values $30-$37). */
export const portName = (c: number): string => `$3${c & 7}`;

/** What $a000, $d000 and $e000 show: "RAM · I/O · RAM"; with a cartridge $8000 first: "ROML · ROMH · I/O · KERNAL". */
export function portText(c: number, cart: CartMode = 'none'): string {
  if (cart === 'ultimax') return 'ROML · – · I/O · ROMH';
  const a = cart === '16k' && c & 2 ? 'ROMH' : (c & 3) === 3 ? 'BASIC' : 'RAM';
  const d = (c & 3) === 0 ? 'RAM' : c & 4 ? 'I/O' : 'CHAR ROM';
  const e = c & 2 ? 'KERNAL' : 'RAM';
  return `${cart !== 'none' ? `${(c & 3) === 3 ? 'ROML' : 'RAM'} · ` : ''}${a} · ${d} · ${e}`;
}

/** The configurations in a mask, e.g. [5] or [5, 7]. */
export const portsOf = (mask: number): number[] => [0, 1, 2, 3, 4, 5, 6, 7].filter(c => mask & (1 << c));
/** The VIC banks in a mask. */
export const banksOf = (mask: number): number[] => [0, 1, 2, 3].filter(b => mask & (1 << b));

/** "$35 (RAM · I/O · RAM)", "$35 or $37", or "unknown". */
export function describePorts(mask: number, cart: CartMode = 'none'): string {
  if (!mask || mask === ALL_PORTS) return 'unknown';
  const cs = portsOf(mask);
  return cs.length === 1 ? `${portName(cs[0])} (${portText(cs[0], cart)})` : cs.map(portName).join(' or ');
}

export const bankRange = (b: number): string => { const s = b * 0x4000; return `$${s.toString(16).padStart(4, '0')}-$${(s + 0x3fff).toString(16).padStart(4, '0')}`; };
