/* Deterministic test programs shared by the fuzz, differential and KickAss integration tests. */
import { assemble, h4, parsePrg, type FileInput, type Override, type ProjectInput, type Settings } from '../../src';

/** mulberry32: small, fast, seedable PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type LoadKind = 'basic' | 'c000' | 'random';

/** Same shape as the prototype's fuzz: random bytes (30 % zeros), optional BASIC SYS 2061 stub. */
export function randomPrg(seed: number, load: number, len: number, name = 'fuzz.prg'): FileInput {
  const r = rng(seed);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = r() < 0.3 ? 0 : Math.floor(r() * 256);
  if (load === 0x0801) bytes.set([0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00], 0);
  return { name, load, bytes };
}

export const loadFor = (kind: LoadKind, random: number): number => kind === 'basic' ? 0x0801 : kind === 'c000' ? 0xc000 : random;

export const OVERRIDE_TYPES = ['code', 'data', 'text', 'words', 'sprite', 'fill', 'music', 'charset', 'bitmap', 'screen', 'table', 'lohi', 'auto'] as const;

/** A seeded random project in the spirit of the prototype harness (used where fast-check is not driving). */
export function seededProject(seed: number): ProjectInput {
  const r = rng(seed * 7919 + 13);
  const len = 200 + Math.floor(r() * 3000);
  const load = r() < 0.5 ? 0x0801 : (r() < 0.5 ? 0xc000 : Math.floor(r() * 0xf000));
  const file = randomPrg(seed, load, len);
  const p: ProjectInput = { name: 'fuzz', files: [file], overrides: [], labels: {}, settings: {} };
  if (r() < 0.3) p.overrides!.push({ start: load + 20, end: load + 60, type: (['code', 'data', 'text', 'words', 'sprite', 'fill', 'music', 'charset'] as const)[Math.floor(r() * 8)] });
  if (r() < 0.3) p.settings = { musicAsSid: r() < 0.5, gfxBinary: r() < 0.5, basicUpstart: r() < 0.5, hwInclude: (['import', 'inline', 'none'] as const)[Math.floor(r() * 3)] };
  return p;
}

export function fromSource(name: string, src: string): FileInput {
  const r = assemble({ 'src.asm': src }, 'src.asm');
  if (r.errors.length || !r.prg) throw new Error(`${name}: ` + r.errors.map(e => `${e.line}: ${e.msg}`).join('; '));
  return parsePrg(name, r.prg);
}

/** A VICE snapshot (MAINCPU and C64MEM, as x64sc 3.10 writes them) of RAM holding the assembled program, with the CPU
 *  at `pc` and the CPU port at `port` ($01 data, $00 direction), and with `cia2` ($dd00, $dd02) a CIA2 module. */
export function snapshotOf(src: string, pc: number, port: [number, number] = [0x37, 0x2f], cia2?: [number, number]): Uint8Array {
  const f = fromSource('snap.prg', src), ram = new Uint8Array(0x10000);
  ram.set(f.bytes.subarray(0, 0x10000 - f.load), f.load);
  const bytes: number[] = [...'VICE Snapshot File\x1a'].map(c => c.charCodeAt(0)), pad = (s: string, n: number) => [...s.padEnd(n, '\0')].map(c => c.charCodeAt(0));
  bytes.push(2, 0, ...pad('C64SC', 16), ...pad('VICE Version\x1a', 13), 3, 10, 0, 0, 0, 0, 0, 0);
  const module = (name: string, data: number[]) => { const size = 22 + data.length; bytes.push(...pad(name, 16), 1, 0, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, size >>> 24, ...data); };
  module('MAINCPU', [...Array(8).fill(0), 1, 2, 3, 0xf0, pc & 0xff, pc >> 8, 0x20, 0, 0, 0, 0]);
  module('C64MEM', [port[0], port[1], 1, 1, ...ram, 0, 0, 0]);
  if (cia2) module('CIA2', [cia2[0], 0, cia2[1], 0, ...Array(12).fill(0)]);
  return new Uint8Array(bytes);
}

/** Every opcode Kick can express (and every other one as .byte) in a straight line of traced code. */
export function allOpcodesProgram(opcodes: readonly { op: number; mn: string; mode: string; flow: string; jam: boolean }[]): FileInput {
  const operand: Record<string, string> = { imp: '', acc: '', imm: ' #$12', zp: ' $12', zpx: ' $12,x', zpy: ' $12,y', izx: ' ($12,x)', izy: ' ($12),y', rel: ' *+2', abs: ' $1234', abx: ' $1234,x', aby: ' $1234,y', ind: ' ($1234)' };
  const lines = ['.pc = $1000 "Code"', 'start:'];
  for (const o of opcodes) {
    if (o.jam || o.flow === 'brk' || o.flow === 'ret' || o.flow === 'jmp' || o.flow === 'jmpi' || o.flow === 'jsr') continue;
    const ops = [o.op];
    const v = operand[o.mode];
    const len = o.mode === 'imp' || o.mode === 'acc' ? 1 : ['abs', 'abx', 'aby', 'ind'].includes(o.mode) ? 3 : 2;
    if (len === 2) ops.push(o.mode === 'rel' ? 0x00 : 0x12);
    if (len === 3) ops.push(0x34, 0x12);
    lines.push(`  .byte ${ops.map(b => '$' + b.toString(16).padStart(2, '0')).join(',')}  // ${o.mn}${v}`);
    // the same opcode with an absolute operand below $0100 (needs .abs to round-trip)
    if (['abs', 'abx', 'aby'].includes(o.mode)) lines.push(`  .byte $${o.op.toString(16).padStart(2, '0')},$34,$00`);
  }
  lines.push('  jsr sub', '  jmp ($0300)', 'sub:', '  rts');
  return fromSource('opcodes.prg', lines.join('\n'));
}

/** A program loaded into zero page so instructions address program labels in zp: exercises .zp/.abs. */
export function zeroPageProgram(): FileInput {
  return fromSource('zp.prg', `
.pc = $00f0 "ZP"
  jmp code
v1: .byte $00
v2: .byte $00
p1: .word $0400
p2: .word $0428
tab: .byte 1,2,3,4,5
.pc = $0110 "Code"
code:
  lda v1
  sta v2
  lda v1,x
  ldx v2,y
  stx v1,y
  lda (p1),y
  sta (p2),y
  lda (p1,x)
  sax v1
  lax v2
  lax v1,y
  dcp v1,x
  lda $00f3
  lda $00f4,x
  ldx $00f4,y
  inc tab
  ldy tab,x
  jmp (p1)
`);
}

/** Every combination knob the generator exposes, for setting-matrix tests. */
export const SETTING_VARIANTS: Partial<Settings>[] = [
  {},
  { mnemonicCase: 'upper', hexCase: 'upper' },
  { hwInclude: 'inline' },
  { hwInclude: 'none', hwComments: false },
  { musicAsSid: false, gfxBinary: false },
  { basicUpstart: false, addrComments: true },
  { bytesPerRow: 16, indent: 2, commentCol: 32 },
  { illegal: false, detectMusic: false, detectGfx: false, detectText: false },
];

export const withOverrides = (p: ProjectInput, overrides: Override[]): ProjectInput => ({ ...p, overrides });
export const describeProject = (p: ProjectInput): string =>
  `${p.files.map(f => `${f.name}@$${h4(f.load)}+${f.bytes.length}`).join(', ')} overrides=${JSON.stringify(p.overrides || [])} settings=${JSON.stringify(p.settings || {})}`;
