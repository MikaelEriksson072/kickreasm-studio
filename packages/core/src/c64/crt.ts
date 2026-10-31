/* Cartridge images (.crt, spec 13.9), VICE's format: a header (the signature, the hardware type, EXROM and GAME, the
 * cartridge's name), then a CHIP packet per ROM chip with its bank, the address the cartridge maps it at and its bytes.
 * A cartridge opens like a disk: the chips of its boot bank become the project's files, at the addresses the CPU sees
 * them at when the C64 starts, and the other banks open from the Explorer. The image stays with the project, so the
 * export rebuilds it byte for byte in a Kick Assembler source of its own (cartridgeSource), from the re-assembled
 * chips and the others as binary files, and Build & Run starts it in VICE. */
import type { Addr, Cartridge } from '../types';
import type { CartMode } from './memconfig';
import { h2, h4 } from '../util/hex';
import type { ParsedPrg } from './prg';

const MAGIC = 'C64 CARTRIDGE   ';
/** the header is at least this long; a header length below it (some old files) reads as it, as VICE reads it */
const HEADER = 0x40;
const CHIP_HEADER = 0x10;

/** The cartridge hardware types of VICE 3.10 (cartconv --types), by their CRT id. */
export const CRT_TYPES: Record<number, string> = {
  0: 'Normal cartridge', 1: 'Action Replay V5', 2: 'KCS Power Cartridge', 3: 'The Final Cartridge III', 4: "Simons' BASIC", 5: 'Ocean',
  6: 'Expert Cartridge', 7: 'Fun Play', 8: 'Super Games', 9: 'Atomic Power', 10: 'Epyx FastLoad', 11: 'Westermann Learning', 12: 'REX Utility',
  13: 'The Final Cartridge', 14: 'Magic Formel', 15: 'C64 Games System (System 3)', 16: 'Warp Speed', 17: 'Dinamic', 18: 'Zaxxon (Sega)',
  19: 'Magic Desk (Domark, HES Australia)', 20: 'Super Snapshot V5', 21: 'Comal 80', 22: 'Structured BASIC', 23: 'ROSS', 24: 'Dela EP64',
  25: 'Dela EP7x8', 26: 'Dela EP256', 27: 'REX 256K EPROM Cart', 28: 'Mikro Assembler', 29: 'Final Cartridge Plus', 30: 'Action Replay MK4',
  31: 'Stardos', 32: 'EasyFlash', 33: 'EasyFlash Xbank', 34: 'Capture', 35: 'Action Replay MK3', 36: 'Retro Replay', 37: 'MMC64',
  38: 'MMC Replay', 39: 'IDE64', 40: 'Super Snapshot V4', 41: 'IEEE-488 Interface', 42: 'Game Killer', 43: 'Prophet64', 44: 'EXOS',
  45: 'Freeze Frame', 46: 'Freeze Machine', 47: 'Snapshot 64', 48: 'Super Explode V5.0', 49: 'Magic Voice', 50: 'Action Replay MK2',
  51: 'MACH 5', 52: 'Diashow-Maker', 53: 'Pagefox', 54: 'Kingsoft', 55: 'Silverrock 128KiB Cartridge', 56: 'Formel 64', 57: 'RGCD',
  58: 'RR-Net MK3', 59: 'Easy Calc Result', 60: 'GMod2', 61: 'MAX Basic', 62: 'GMod3', 63: 'ZIPP-CODE 48', 64: 'Blackbox V8',
  65: 'Blackbox V3', 66: 'Blackbox V4', 67: 'REX RAM-Floppy', 68: 'BIS-Plus', 69: 'SD-BOX', 70: 'MultiMAX', 71: 'Blackbox V9',
  72: 'Lt. Kernal Host Adaptor', 73: 'RAMLink', 74: 'Drean', 75: 'IEEE Flash! 64', 76: 'HES Turtle Graphics II', 77: 'Freeze Frame MK2',
  78: 'Partner 64', 79: 'Hyper-BASIC', 80: 'Universal Cartridge 1', 81: 'Universal Cartridge 1.5', 82: 'Universal Cartridge 2',
  83: 'BMP Data Turbo 2000', 84: 'Profi-DOS', 85: 'Magic Desk 16K', 86: 'PTV Megabyter',
};

const CHIP_TYPES = ['ROM', 'RAM', 'Flash', 'EEPROM'];

export interface CrtChip {
  /** its place among the CHIP packets, from 0 */
  index: number;
  /** 0 ROM, 1 RAM, 2 Flash, 3 EEPROM */
  type: number;
  bank: number;
  /** the address the file gives (an EasyFlash keeps ROMH at $a000 also where it boots it at $e000) */
  load: Addr;
  /** its bytes: a view into the image */
  data: Uint8Array;
  /** where the packet starts in the image, where its data starts, and its length field (header and data; more than
   *  that is kept as it is) */
  offset: number; dataOffset: number; length: number;
}

export interface Crt {
  /** the cartridge's name in the header */
  name: string;
  /** the header's version (1.0, 1.1, 2.0) */
  version: [number, number];
  /** the hardware type (CRT_TYPES), and its subtype (revision) from version 1.1 */
  hw: number; revision: number;
  /** the EXROM and GAME lines at reset, as the header gives them: 0 pulls the line low (active) */
  exrom: number; game: number;
  /** the memory map at reset (EXROM and GAME) */
  mode: CartMode;
  headerLength: number;
  chips: CrtChip[];
  /** the image itself */
  bytes: Uint8Array;
}

const text = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** A cartridge image of any machine VICE emulates (the C64's opens; parseCrt says why the others do not). */
export const isCrt = (b: Uint8Array): boolean => b.length >= 16 && /^(C64|C128|CBM2|VIC20|PLUS4) +CARTRIDGE *$/.test(text(b, 0, 16));

/** The memory map of the EXROM and GAME lines (0: pulled low). */
export const crtMode = (exrom: number, game: number): CartMode => (exrom ? (game ? 'none' : 'ultimax') : game ? '8k' : '16k');

export const crtTypeName = (hw: number): string => CRT_TYPES[hw] ?? `cartridge type ${hw}`;
export const chipTypeName = (type: number): string => CHIP_TYPES[type] ?? `chip type ${type}`;
export const cartModeName = (m: CartMode): string => (m === 'none' ? 'no ROM mapped at reset' : m === 'ultimax' ? 'Ultimax mode' : `${m.toUpperCase()} mode`);

/** Read a C64 cartridge image; anything else (another machine's, a damaged file) is refused with the reason. */
export function parseCrt(b: Uint8Array, name = 'cartridge'): Crt {
  if (!isCrt(b)) throw new Error(`${name} is not a cartridge image (.crt)`);
  const sig = text(b, 0, 16);
  if (sig !== MAGIC) throw new Error(`${name} is a cartridge for the ${sig.replace(/ +CARTRIDGE *$/, '')}, not the C64`);
  if (b.length < HEADER) throw new Error(`${name}: the cartridge header is cut short`);
  const headerLength = Math.max(HEADER, be32(b, 0x10));
  if (headerLength > b.length) throw new Error(`${name}: the cartridge header says it is ${headerLength} bytes long, longer than the file`);
  const exrom = b[0x18], game = b[0x19];
  const chips: CrtChip[] = [];
  let p = headerLength;
  while (p + CHIP_HEADER <= b.length && text(b, p, 4) === 'CHIP') {
    const length = be32(b, p + 4), size = be16(b, p + 14);
    const dataOffset = p + CHIP_HEADER;
    if (dataOffset + size > b.length) throw new Error(`${name} is cut short: its CHIP packet ${chips.length} (bank ${be16(b, p + 10)}) says it holds ${size} bytes, but the file ends after ${b.length - dataOffset} of them`);
    chips.push({ index: chips.length, type: be16(b, p + 8), bank: be16(b, p + 10), load: be16(b, p + 12), data: b.subarray(dataOffset, dataOffset + size), offset: p, dataOffset, length });
    // a packet longer than its data keeps the rest; one that says it is shorter ends with its data
    p += Math.min(b.length - p, Math.max(length, CHIP_HEADER + size));
  }
  if (!chips.length) throw new Error(`${name}: the cartridge has no CHIP packets`);
  return {
    name: text(b, 0x20, 32).replace(/\0.*$/s, '').trimEnd(), version: [b[0x14], b[0x15]], hw: be16(b, 0x16), revision: b[0x1a],
    exrom, game, mode: crtMode(exrom, game), headerLength, chips, bytes: b,
  };
}

/** The bank the C64 starts in: the first (bank 0 on every cartridge in practice). */
export const bootBank = (c: Crt): number => Math.min(...c.chips.map(x => x.bank));

/**
 * Where the CPU sees a chip: where the file maps it, except ROMH of an Ultimax cartridge's boot bank that the file
 * keeps at $a000 (an EasyFlash does): the C64 boots it at $e000, where its reset vector is.
 */
export function chipAddress(c: Crt, chip: CrtChip): Addr {
  return c.mode === 'ultimax' && chip.bank === bootBank(c) && chip.load === 0xa000 && chip.data.length <= 0x2000 ? 0xe000 : chip.load;
}

/** `bank03_8000`: the name of a chip's source, PRG and binary file */
export const chipName = (c: Crt, chip: CrtChip): string => `bank${String(chip.bank).padStart(2, '0')}_${h4(chipAddress(c, chip))}`;

/** The banks of the cartridge in order, each with its chips. */
export function crtBanks(c: Crt): { bank: number; chips: CrtChip[] }[] {
  const by = new Map<number, CrtChip[]>();
  for (const x of c.chips) by.set(x.bank, [...(by.get(x.bank) ?? []), x]);
  return [...by].sort((x, y) => x[0] - y[0]).map(([bank, chips]) => ({ bank, chips }));
}

/** "Magic Desk (Domark, HES Australia), 8 banks of 8 KB (64 KB), 8K mode" */
export function describeCrt(c: Crt): string {
  const banks = crtBanks(c), total = c.chips.reduce((n, x) => n + x.data.length, 0);
  const sizes = [...new Set(banks.map(b => b.chips.reduce((n, x) => n + x.data.length, 0)))];
  const kb = (n: number) => (n % 1024 ? `${n} bytes` : `${n / 1024} KB`);
  const what = banks.length === 1 ? kb(total) : `${banks.length} banks${sizes.length === 1 ? ` of ${kb(sizes[0])}` : ''} (${kb(total)})`;
  return `${crtTypeName(c.hw)}, ${what}, ${cartModeName(c.mode)}`;
}

/** A cartridge image (version 1.0) of these chips, in order: for tests, and cartridges made from source. */
export function makeCrt(o: { name?: string; hw?: number; exrom: number; game: number; chips: { bank: number; load: Addr; bytes: Uint8Array; type?: number }[] }): Uint8Array {
  const out = new Uint8Array(HEADER + o.chips.reduce((n, c) => n + CHIP_HEADER + c.bytes.length, 0));
  const put = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i) & 0xff; };
  const w16 = (at: number, v: number) => { out[at] = (v >> 8) & 0xff; out[at + 1] = v & 0xff; };
  const w32 = (at: number, v: number) => { w16(at, v >>> 16); w16(at + 2, v & 0xffff); };
  put(0, MAGIC); w32(0x10, HEADER); w16(0x14, 0x0100); w16(0x16, o.hw ?? 0); out[0x18] = o.exrom; out[0x19] = o.game; put(0x20, (o.name ?? '').slice(0, 32));
  let p = HEADER;
  for (const c of o.chips) {
    put(p, 'CHIP'); w32(p + 4, CHIP_HEADER + c.bytes.length); w16(p + 8, c.type ?? 0); w16(p + 10, c.bank); w16(p + 12, c.load); w16(p + 14, c.bytes.length);
    out.set(c.bytes, p + CHIP_HEADER);
    p += CHIP_HEADER + c.bytes.length;
  }
  return out;
}

/** A chip opened as a file of the project: `chip` is its CHIP packet */
export interface ChipFile extends ParsedPrg { chip: number }

/** The chips of `bank` (the boot bank when not given) as files at the addresses the CPU sees them at. */
export function bankFiles(c: Crt, bank = bootBank(c)): ChipFile[] {
  return c.chips.filter(x => x.bank === bank).map(x => ({ name: `${chipName(c, x)}.prg`, load: chipAddress(c, x), bytes: x.data.slice(), chip: x.index }));
}

/** A cartridge image opened: the image kept with the project, and the chips of its boot bank as files. */
export function openCartridge(name: string, bytes: Uint8Array): { cart: Cartridge; crt: Crt; files: ChipFile[] } {
  const crt = parseCrt(bytes, name);
  return { cart: { name, crt: bytes.slice() }, crt, files: bankFiles(crt) };
}

/**
 * The memory map the opened chips run with: Ultimax where a chip is at $e000, 16K where one covers $a000-$bfff or the
 * cartridge starts in 16K mode, 8K where one is at $8000 or the cartridge starts in 8K mode. An Ultimax cartridge's
 * other banks (an EasyFlash's) run in 16K or 8K mode, so the files tell, not the header alone.
 */
export function cartMode(c: Pick<Crt, 'exrom' | 'game'>, files: readonly { load: Addr; bytes: Uint8Array; chip?: number }[]): CartMode {
  const chips = files.filter(f => f.chip != null);
  if (chips.some(f => f.load >= 0xe000)) return 'ultimax';
  if (chips.some(f => f.load < 0xc000 && f.load + f.bytes.length > 0xa000) || crtMode(c.exrom, c.game) === '16k') return '16k';
  if (chips.some(f => f.load >= 0x8000 && f.load < 0xa000) || c.exrom === 0) return '8k';
  return 'none';
}

/** cartMode for a project's cartridge; 'none' without one (or with an image that cannot be read) */
export function projectCartMode(cart: Cartridge | null | undefined, files: readonly { load: Addr; bytes: Uint8Array; chip?: number }[]): CartMode {
  if (!cart || !files.some(f => f.chip != null)) return 'none';
  try { return cartMode(parseCrt(cart.crt, cart.name), files); } catch { return 'none'; }
}

/**
 * The image with the chips in `built` (by CHIP packet) replaced: the header, the packet headers and every other chip
 * stay as they were. A chip built to another length than the original's is reported, and left as it was.
 */
export function rebuildCrt(c: Crt, built: ReadonlyMap<number, Uint8Array>): { crt: Uint8Array; problems: string[] } {
  const out = c.bytes.slice(), problems: string[] = [];
  for (const [i, bytes] of built) {
    const chip = c.chips[i];
    if (!chip) { problems.push(`there is no CHIP packet ${i}`); continue; }
    if (bytes.length !== chip.data.length) { problems.push(`${chipName(c, chip)}: built ${bytes.length} bytes, the chip has ${chip.data.length}`); continue; }
    out.set(bytes, chip.dataOffset);
  }
  return { crt: out, problems };
}

/** Where an offset of the image is: "the header ($18)", "CHIP 3's header", "CHIP 3 (bank 3) at $8123". */
export function crtOffsetText(c: Crt, offset: number): string {
  if (offset < c.headerLength) return `the header ($${h2(offset)})`;
  for (const x of c.chips) {
    if (offset >= x.offset && offset < x.dataOffset) return `CHIP ${x.index}'s header (+${offset - x.offset})`;
    if (offset >= x.dataOffset && offset < x.dataOffset + x.data.length) return `CHIP ${x.index} (bank ${x.bank}) at $${h4(chipAddress(c, x) + offset - x.dataOffset)}`;
  }
  return `offset ${offset}`;
}

/** An image built compared byte for byte with `expected` (the original image, or it with the project's patches in its
 *  chips): how many bytes are the same, and the first differences. */
export function compareCrt(c: Crt, built: Uint8Array | null, expected: Uint8Array = c.bytes): { ok: boolean; same: number; total: number; diffs: string[] } {
  const a = expected, total = a.length;
  if (!built) return { ok: false, same: 0, total, diffs: ['no image was built'] };
  let same = 0;
  const diffs: string[] = [];
  for (let i = 0; i < Math.min(a.length, built.length); i++) {
    if (a[i] === built[i]) same++;
    else if (diffs.length < 8) diffs.push(`${crtOffsetText(c, i)}: expected $${h2(a[i])}, got $${h2(built[i])}`);
  }
  if (built.length !== a.length) diffs.unshift(`the image built is ${built.length} bytes, the original ${a.length}`);
  return { ok: !diffs.length, same, total, diffs };
}

/** The chip's bytes from the PRG a source of it built: from the chip's address, its length; null when it starts elsewhere */
export function chipFromPrg(c: Crt, chip: CrtChip, prg: Uint8Array | null): Uint8Array | null {
  if (!prg || prg.length < 2 || (prg[0] | (prg[1] << 8)) !== chipAddress(c, chip)) return null;
  return prg.subarray(2);
}

/* ---- the Kick Assembler source that writes the image ---- */

/** `<name>.crt.asm` builds `<name>.crt` (runKickAssembler takes its output by that name) */
export const crtSourceName = (base: string): string => `${base}.crt.asm`;
export const crtOutputName = (base: string): string => `${base}.crt`;
/** the file name the source of a project's cartridge has (and the image it writes), from the .crt it was opened from */
export const crtBase = (cart: Pick<Cartridge, 'name'>): string => cart.name.replace(/\.crt$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_') || 'cartridge';

export interface CartSourceOptions {
  /** the output folder of the build (Settings.outDir), where the chips' PRGs are */
  outDir: string;
  /** the chips the project re-assembles: CHIP packet -> the name of their source (without .asm) */
  sources: ReadonlyMap<number, string>;
  hexCase?: 'lower' | 'upper';
}

/**
 * The cartridge's own source: `.file` writes the image (it runs past 64 KB, so a segment of its own starting at 0), with
 * the header and every packet header as commented `.byte` lines, the re-assembled chips from the PRGs their sources
 * build (the load address skipped) and the others from `banks/<name>.bin`. `.errorif` checks the length of each.
 * Returns the source and the binary files it reads.
 */
export function cartridgeSource(name: string, c: Crt, o: CartSourceOptions): { source: string; files: Record<string, Uint8Array> } {
  const up = o.hexCase === 'upper';
  const x2 = (v: number) => '$' + (up ? h2(v).toUpperCase() : h2(v));
  const x4 = (v: number) => '$' + (up ? h4(v).toUpperCase() : h4(v));
  const b = c.bytes, base = crtBase({ name }), files: Record<string, Uint8Array> = {};
  const out = (dir: string, cmt = '') => lines.push(cmt ? `${dir.padEnd(40)}// ${cmt}` : dir);
  const bytes = (from: number, to: number, cmt = '') => {
    if (to <= from) return;
    const same = b.subarray(from, to).every(v => v === b[from]);
    if (same && to - from > 4) { out(`.fill ${to - from}, ${x2(b[from])}`, cmt); return; }
    for (let p = from; p < to; p += 16) out(`.byte ${[...b.subarray(p, Math.min(to, p + 16))].map(x2).join(', ')}`, p === from ? cmt : '');
  };
  /** printable ASCII as .text (no " or \), the rest as bytes */
  const ascii = (from: number, to: number, cmt: string) => {
    let e = from;
    while (e < to && b[e] >= 0x20 && b[e] < 0x7f && b[e] !== 0x22 && b[e] !== 0x5c) e++;
    if (e > from) out(`.text "${text(b, from, e - from)}"`, cmt);
    bytes(e, to, e > from ? '' : cmt);
  };
  const outDir = o.outDir.replace(/\\/g, '/').replace(/\/+$/, '') || '.';
  const lines: string[] = [
    `// ${name} — the cartridge image, rebuilt by Mimir Studio`,
    `// ${describeCrt(c)}${c.name ? `: "${c.name}"` : ''}`,
    `// ${c.chips.length} CHIP packet${c.chips.length === 1 ? '' : 's'}: ${o.sources.size ? `${o.sources.size} re-assembled from ${o.sources.size === 1 ? 'its source' : 'their sources'}, built first into ${outDir}/` : 'none re-assembled'}${o.sources.size < c.chips.length ? `, ${c.chips.length - o.sources.size} from banks/` : ''}`,
    `// Assemble the chips' sources first (build.bat and build.sh do); this writes ${outDir}/${crtOutputName(base)}.`,
    '',
    `.file [name="${crtOutputName(base)}", type="bin", segments="Cartridge"]`,
    '.segmentdef Cartridge [start=0]',
    '.segment Cartridge',
    '.encoding "ascii"',
    '',
    '// the header',
  ];
  out('.text "C64 CARTRIDGE   "', 'signature');
  bytes(0x10, 0x14, `header length: ${be32(b, 0x10)}`);
  bytes(0x14, 0x16, `version ${c.version[0]}.${c.version[1]}`);
  bytes(0x16, 0x18, `hardware type ${c.hw}: ${crtTypeName(c.hw)}`);
  bytes(0x18, 0x19, `EXROM ${c.exrom ? 'inactive (1)' : 'active (0)'}`);
  bytes(0x19, 0x1a, `GAME ${c.game ? 'inactive (1)' : 'active (0)'}: ${cartModeName(c.mode)}`);
  bytes(0x1a, 0x1b, `hardware revision ${c.revision}`);
  bytes(0x1b, 0x20, 'reserved');
  ascii(0x20, 0x40, 'the name');
  bytes(0x40, c.headerLength, 'more header');
  let p = c.headerLength;
  for (const chip of c.chips) {
    const src = o.sources.get(chip.index), n = chipName(c, chip), size = chip.data.length;
    bytes(p, chip.offset, 'between the packets');
    lines.push('', `// CHIP ${chip.index}: bank ${chip.bank}, ${chipTypeName(chip.type)} at ${x4(chip.load)}, ${size} bytes${src ? ` (${src}.asm)` : ''}`);
    out('.text "CHIP"');
    bytes(chip.offset + 4, chip.offset + 8, `packet length: ${chip.length}`);
    bytes(chip.offset + 8, chip.offset + 10, `chip type: ${chipTypeName(chip.type)}`);
    bytes(chip.offset + 10, chip.offset + 12, `bank ${chip.bank}`);
    bytes(chip.offset + 12, chip.offset + 14, `load address ${x4(chip.load)}${chipAddress(c, chip) !== chip.load ? ` (the CPU sees it at ${x4(chipAddress(c, chip))})` : ''}`);
    bytes(chip.offset + 14, chip.offset + 16, `size: ${size}`);
    lines.push(`chip${chip.index}:`);
    if (src) out(`.import binary "${outDir}/${src}.prg", 2`, 'the re-assembled chip, without its load address');
    else { files[`banks/${n}.bin`] = chip.data.slice(); out(`.import binary "banks/${n}.bin"`); }
    lines.push(`.errorif * - chip${chip.index} != ${size}, "${src ? `${outDir}/${src}.prg` : `banks/${n}.bin`} does not hold the chip's ${size} bytes"`);
    p = chip.dataOffset + size;
  }
  if (p < b.length) { lines.push(''); bytes(p, b.length, 'after the last packet'); }
  return { source: lines.join('\n') + '\n', files };
}
