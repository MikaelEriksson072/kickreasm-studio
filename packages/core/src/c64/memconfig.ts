/* =====================================================================
 * 6510 memory configuration: what the CPU sees through the port at $01.
 * Bits 0-2 (LORAM, HIRAM, CHAREN) select one of 8 configurations; this
 * assumes no cartridge (EXROM = GAME = 1) and the default DDR ($00 = $2f).
 * Masks: bit c set = configuration c is possible.
 * ===================================================================== */
import type { Addr } from '../types';

export type MemArea = 'ram' | 'basic' | 'kernal' | 'io' | 'char';

/** $01 & 7 after power-on ($37): BASIC, I/O and KERNAL visible */
export const DEFAULT_PORT = 7;
export const ALL_PORTS = 0xff;
export const ALL_BANKS = 0x0f;

/** What address `a` reaches in configuration `c`. Writes to the ROM areas always go to the RAM below. */
export function areaAt(a: Addr, c: number, write: boolean): MemArea {
  if (a >= 0xa000 && a < 0xc000) return !write && (c & 3) === 3 ? 'basic' : 'ram';
  if (a >= 0xe000) return !write && (c & 2) ? 'kernal' : 'ram';
  if (a >= 0xd000 && a < 0xe000) { if ((c & 3) === 0) return 'ram'; if (c & 4) return 'io'; return write ? 'ram' : 'char'; }
  return 'ram';
}

/** Is `a` in an area the port can switch ($a000-$bfff, $d000-$ffff)? */
export const banked = (a: Addr): boolean => (a >= 0xa000 && a < 0xc000) || a >= 0xd000;

/**
 * For an access from code that may run in the configurations of `mask`: 'hw' when it always reaches
 * I/O or ROM, 'ram' when it always reaches RAM (or the character ROM), null when that differs or is unknown.
 */
export function reaches(a: Addr, mask: number, write: boolean): 'hw' | 'ram' | null {
  if (!mask || mask === ALL_PORTS || !banked(a)) return null;
  let hw = false, ram = false;
  for (let c = 0; c < 8; c++) {
    if (!(mask & (1 << c))) continue;
    const ar = areaAt(a, c, write);
    if (ar === 'ram' || ar === 'char') ram = true; else hw = true;
  }
  return hw === ram ? null : hw ? 'hw' : 'ram';
}

/**
 * `reaches` for naming an operand: where it cannot tell (the configurations differ, or $01 is unknown), an address at
 * $d000-$dfff counts as I/O, so a register keeps its name (VIC_RASTER, not var_d012) unless the code surely runs with
 * all RAM there.
 */
export function reachesForName(a: Addr, mask: number, write: boolean): 'hw' | 'ram' | null {
  const r = reaches(a, mask, write);
  return r === null && a >= 0xd000 && a < 0xe000 ? 'hw' : r;
}

/** Does code in the configurations of `mask` see I/O at $d000-$dfff: 'all', 'none' or 'some'? */
export function ioVisible(mask: number): 'all' | 'none' | 'some' {
  let io = 0, other = 0;
  for (let c = 0; c < 8; c++) if (mask & (1 << c)) { if ((c & 3) && (c & 4)) io++; else other++; }
  return !other ? 'all' : !io ? 'none' : 'some';
}

/** "$35" style name of a configuration (the usual values $30-$37). */
export const portName = (c: number): string => `$3${c & 7}`;

/** What $a000, $d000 and $e000 show: "RAM · I/O · RAM". */
export function portText(c: number): string {
  const a = (c & 3) === 3 ? 'BASIC' : 'RAM';
  const d = (c & 3) === 0 ? 'RAM' : c & 4 ? 'I/O' : 'CHAR ROM';
  const e = c & 2 ? 'KERNAL' : 'RAM';
  return `${a} · ${d} · ${e}`;
}

/** The configurations in a mask, e.g. [5] or [5, 7]. */
export const portsOf = (mask: number): number[] => [0, 1, 2, 3, 4, 5, 6, 7].filter(c => mask & (1 << c));
/** The VIC banks in a mask. */
export const banksOf = (mask: number): number[] => [0, 1, 2, 3].filter(b => mask & (1 << b));

/** "$35 (RAM · I/O · RAM)", "$35 or $37", or "unknown". */
export function describePorts(mask: number): string {
  if (!mask || mask === ALL_PORTS) return 'unknown';
  const cs = portsOf(mask);
  return cs.length === 1 ? `${portName(cs[0])} (${portText(cs[0])})` : cs.map(portName).join(' or ');
}

export const bankRange = (b: number): string => { const s = b * 0x4000; return `$${s.toString(16).padStart(4, '0')}-$${(s + 0x3fff).toString(16).padStart(4, '0')}`; };
