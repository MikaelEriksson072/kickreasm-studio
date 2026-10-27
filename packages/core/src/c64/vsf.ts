/* VICE snapshots (.vsf): the C64's 64 KB of RAM, the CPU port and the CPU registers, from the snapshot's C64MEM and
 * MAINCPU modules, and CIA 2's port A (the VIC bank) from its CIA2 module. A snapshot opens like a PRG: its RAM from $0200 is the file, and the code the CPU was running and
 * its interrupt handlers become entry points (spec 13.7). The snapshot itself is kept, so that Build & Run can restart
 * it as it was, with the built program in its RAM (patchSnapshot). */
import type { Addr } from '../types';
import { h2, h4 } from '../util/hex';
import { parseBasic } from './basic';
import { areaAt } from './memconfig';
import { parsePrg, type ParsedPrg } from './prg';

const MAGIC = 'VICE Snapshot File\x1a';
const VERSION = 'VICE Version\x1a';
const MODULE_HEADER = 22; // name (16), major, minor, size (4, the header included)

export interface VsfModule {
  name: string; major: number; minor: number;
  /** where its data starts in the file, and how many bytes it has */
  offset: number; size: number;
}

export interface Snapshot {
  /** "C64", "C64SC" */
  machine: string;
  /** the snapshot format, and the VICE version that wrote it (VICE 3.x and later) */
  version: [number, number];
  vice: string | null;
  modules: VsfModule[];
  /** all 64 KB of RAM (the RAM below ROM and I/O too) */
  ram: Uint8Array;
  /** the 6510 port ($00 direction, $01 data) */
  port: { dir: number; data: number };
  /** the CPU registers, when the MAINCPU module could be read */
  cpu: { pc: Addr; a: number; x: number; y: number; sp: number; status: number } | null;
  /** CIA 2's port A ($dd00) and its direction ($dd02), when the CIA2 module could be read */
  cia2: { pra: number; ddra: number } | null;
}

const text = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const dword = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

export const isVsf = (b: Uint8Array): boolean => b.length >= MAGIC.length && text(b, 0, MAGIC.length) === MAGIC;

/** Read a C64 snapshot; anything else (another machine, a damaged file) is refused with the reason. */
export function parseVsf(b: Uint8Array, name = 'snapshot'): Snapshot {
  if (!isVsf(b)) throw new Error(`${name} is not a VICE snapshot`);
  const version: [number, number] = [b[19], b[20]];
  const machine = text(b, 21, 16).replace(/\0.*$/s, '');
  if (!/^C64/.test(machine)) throw new Error(`${name} is a snapshot of a ${machine || 'unknown machine'}, not a C64`);
  let p = 37, vice: string | null = null;
  if (text(b, p, VERSION.length) === VERSION) { vice = `${b[p + 13]}.${b[p + 14]}${b[p + 15] ? `.${b[p + 15]}` : ''}`; p += VERSION.length + 8; }
  const modules: VsfModule[] = [];
  while (p + MODULE_HEADER <= b.length) {
    const size = dword(b, p + 18);
    if (size < MODULE_HEADER || p + size > b.length) throw new Error(`${name}: the snapshot is damaged (module at ${p} runs past the end)`);
    modules.push({ name: text(b, p, 16).replace(/\0.*$/s, ''), major: b[p + 16], minor: b[p + 17], offset: p + MODULE_HEADER, size: size - MODULE_HEADER });
    p += size;
  }
  const mem = modules.find(m => m.name === 'C64MEM');
  if (!mem || mem.size < 4 + 0x10000) throw new Error(`${name}: the snapshot has no C64 memory (C64MEM)`);
  const ram = b.slice(mem.offset + 4, mem.offset + 4 + 0x10000);
  const port = { data: b[mem.offset], dir: b[mem.offset + 1] };
  // MAINCPU: the cycle counter (8 bytes from snapshot format 2, before that 4), then A, X, Y, SP, PC and the status
  const cpuMod = modules.find(m => m.name === 'MAINCPU');
  const clk = version[0] >= 2 ? 8 : 4;
  const cpu = cpuMod && cpuMod.size >= clk + 7 ? (o => ({ a: b[o], x: b[o + 1], y: b[o + 2], sp: b[o + 3], pc: b[o + 4] | (b[o + 5] << 8), status: b[o + 6] }))(cpuMod.offset + clk) : null;
  // CIA2: PRA, PRB, DDRA, DDRB first
  const ciaMod = modules.find(m => m.name === 'CIA2');
  const cia2 = ciaMod && ciaMod.size >= 4 ? { pra: b[ciaMod.offset], ddra: b[ciaMod.offset + 2] } : null;
  return { machine, version, vice, modules, ram, port, cpu, cia2 };
}

/** The VIC bank (0-3, $0000/$4000/$8000/$c000) the snapshot was showing: $dd00 bits 0-1, inputs read as 1; null: unknown. */
export const snapshotVicBank = (s: Snapshot): number | null =>
  s.cia2 ? 3 - (((s.cia2.pra & s.cia2.ddra) | (~s.cia2.ddra & 0xff)) & 3) : null;

/** The RAM a snapshot opens as: from $0200, after the zero page and the stack, which are machine state. */
export const SNAPSHOT_LOAD = 0x0200;
/** with `zeroPage`: from $0002, the zero page and the stack too (code can run there); $00/$01 are the CPU port */
export const SNAPSHOT_ZP_LOAD = 0x0002;

export interface OpenOptions {
  /** a snapshot opens from $0002 (zero page and stack included) instead of $0200 */
  zeroPage?: boolean;
}

/** A PRG or a VICE snapshot, opened as one file of the project */
export interface OpenedFile extends ParsedPrg {
  /** a snapshot: where the CPU was and the interrupt handlers in RAM (the analysis traces from there) */
  entries?: Addr[];
  /** a snapshot with the program's BASIC line at $0801: its SYS address, the program start (the RAM from $0200
   *  overwrites BASIC's work area, so Build & Run cannot RUN it and starts it there instead) */
  start?: Addr;
  /** a snapshot: what it is, for the user */
  snapshot?: string;
  /** a snapshot: the file itself, for Build & Run */
  vsf?: Uint8Array;
}

/**
 * Open a file the way the app opens PRGs: a VICE snapshot (recognised by its header, whatever its name) becomes its
 * RAM from $0200 (`zeroPage`: from $0002) as `<name>.prg`, with entry points at the PC (when it is in that RAM) and at
 * the IRQ and NMI handlers its vectors point to in RAM: $0314/$0318 with the KERNAL banked in, $fffe/$fffa without.
 */
/** The memory configuration (0-7, the bits LORAM, HIRAM and CHAREN of $01) the snapshot was running with. */
export const snapshotConfig = (s: Snapshot): number => ((s.port.data & s.port.dir) | (~s.port.dir & 0xff)) & 7; // inputs read as 1

export function openC64File(name: string, bytes: Uint8Array, opts: OpenOptions = {}): OpenedFile {
  if (!isVsf(bytes)) return parsePrg(name, bytes);
  const s = parseVsf(bytes, name);
  const load = opts.zeroPage ? SNAPSHOT_ZP_LOAD : SNAPSHOT_LOAD;
  const cfg = snapshotConfig(s);
  const ramAt = (a: Addr) => a >= load && areaAt(a, cfg, false) === 'ram';
  const word = (a: Addr) => s.ram[a] | (s.ram[a + 1] << 8);
  const entries = new Set<Addr>();
  if (s.cpu && ramAt(s.cpu.pc)) entries.add(s.cpu.pc);
  for (const v of cfg & 2 ? [0x0314, 0x0318] : [0xfffe, 0xfffa]) if (ramAt(word(v))) entries.add(word(v));
  const what = [`VICE${s.vice ? ` ${s.vice}` : ''} snapshot of a ${s.machine}`, s.cpu ? `PC $${h4(s.cpu.pc)}` : null, `$01 = $${h2(s.port.data)}`].filter(Boolean).join(', ');
  const owner = new Int16Array(0x10000).fill(-1).fill(0, load);
  const basic = parseBasic(s.ram, owner, 0x0801);
  const start = basic && basic.sys != null && ramAt(basic.sys) ? basic.sys : undefined;
  return { name: `${name.replace(/\.vsf$/i, '')}.prg`, load, bytes: s.ram.slice(load), entries: [...entries], snapshot: what, vsf: bytes.slice(), ...(start != null ? { start } : {}) };
}

/**
 * The snapshot with the programs (PRGs: a load address, then the bytes) in its RAM, in order, where they cover it;
 * bytes past $ffff are left out. Everything else stays as it was when the snapshot was taken: VICE restores the CPU,
 * the memory configuration, VIC, SID, the CIAs, colour RAM and the drives, and goes on from the PC.
 */
export function patchSnapshot(vsf: Uint8Array, prgs: Uint8Array[]): Uint8Array {
  const mem = parseVsf(vsf).modules.find(m => m.name === 'C64MEM')!;
  const out = vsf.slice();
  for (const prg of prgs) {
    if (prg.length < 3) continue;
    const load = prg[0] | (prg[1] << 8), n = Math.min(prg.length - 2, 0x10000 - load);
    out.set(prg.subarray(2, 2 + n), mem.offset + 4 + load);
  }
  return out;
}
