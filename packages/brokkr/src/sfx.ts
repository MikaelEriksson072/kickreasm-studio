/* Self-extracting programs for the C64. The file loads at $0801 and starts with SYS from a BASIC line; the start of
 * the decruncher runs from where it loaded, copies the resident part to a place of its own, moves the stream where
 * it is decrunched from and sets up; the resident part decrunches backward and starts the program.
 *
 * Brokkr plans where everything goes: the decruncher, its tables and zero page bytes where the data and the stream
 * leave room, the stream so that the decruncher never writes over bytes it has not read yet, and $01 so that every
 * byte it reads and writes is RAM. Then it runs the file in an emulated C64 and compares the memory with the program
 * before it hands the file over. The stream is Exomizer 3's format (src/decruncher.ts) or Brokkr's own
 * (src/brk-decruncher.ts). */
import { assemble, AsmError } from './asm.ts';
import { BRK_START, BRK_ZP_BYTES, brkResident } from './brk-decruncher.ts';
import { crunchBrk, type BrkCrunched, type BrkOptions } from './crunch-brk.ts';
import { crunchData, type CrunchOptions, type Crunched } from './crunch.ts';
import { SFX_PROLOGUE, SFX_RESIDENT, SFX_START, ZP_BYTES } from './decruncher.ts';
import { Machine } from './emulate.ts';
import { BrokkrError, h2, h4, span } from './errors.ts';
import { P, T } from './format.ts';

export type Start = 'sys' | 'basic' | number;
export type SfxFormat = 'exomizer' | 'brokkr';

export interface SfxOptions {
  /** what runs after decrunching: the SYS of the program's BASIC line (default), RUN, or a jump to an address */
  start?: Start;
  /** $01 after decrunching (default $37; RUN needs $37) */
  ramExit?: number;
  /** interrupts after decrunching: on (cli) or off; default on when the KERNAL is in after decrunching */
  irqExit?: boolean;
  /** flash the border while decrunching (when I/O can stay visible); default on */
  effect?: boolean;
  /** the number of the file's BASIC line (default 0) */
  line?: number;
  /** the stream's format: Exomizer 3's (default), or Brokkr's own (smaller, slower to decrunch, more RAM) */
  format?: SfxFormat;
  /** Brokkr's own format: Exomizer's when the program leaves no room for its decruncher (default), or false: an error */
  fallback?: boolean;
  crunch?: CrunchOptions;
  /** Exomizer format: a table of its own for the offsets of length 3 (-P+16); 'auto' crunches both ways */
  fourTables?: boolean | 'auto';
}

export interface Area { name: string; start: number; end: number; note?: string }

export interface SfxResult {
  prg: Uint8Array;
  /** where everything is while decrunching */
  areas: Area[];
  /** where the program starts (for RUN, BASIC's RUN at $a7ae) */
  entry: number;
  basic: boolean;
  ramDuring: number;
  ramExit: number;
  irqExit: boolean;
  effect: boolean;
  format: SfxFormat;
  /** the crunched stream, in reading order */
  stream: Uint8Array;
  /** Exomizer's format: the crunch, and its -P bits in `protocol`; Brokkr's own: `brk` (protocol 0) */
  crunched?: Crunched;
  brk?: BrkCrunched;
  protocol: number;
  /** what the emulated C64 took from SYS to the program's start */
  cycles: number;
  warnings: string[];
}

/** The SYS address in the first line of a BASIC program at `start`, or null. */
export function findSys(peek: (a: number) => number, start = 0x0801): number | null {
  const link = peek(start) | (peek(start + 1) << 8);
  if (!link) return null;
  for (let a = start + 4; a < start + 80; a++) {
    const b = peek(a);
    if (b === 0) return null;
    if (b !== 0x9e) continue;
    let k = a + 1, digits = '';
    while (peek(k) === 0x20 || peek(k) === 0x28) k++;
    while (peek(k) >= 0x30 && peek(k) <= 0x39 && digits.length < 5) digits += String.fromCharCode(peek(k++));
    if (!digits) return null;
    const v = Number(digits);
    return v <= 0xffff ? v : null;
  }
  return null;
}

type Range = [number, number];
const overlaps = (a: Range, b: Range) => a[0] < b[1] && b[0] < a[1];
const IO: Range = [0xd000, 0xe000];

/** The $01 under which all these ranges are RAM to read: I/O out for $d000-$dfff, the KERNAL for $e000 up, BASIC
 * for $a000-$bfff. */
export function ramFor(ranges: Range[]): number {
  let io = false, kernal = false, basic = false;
  for (const r of ranges) {
    if (r[1] <= r[0]) continue;
    if (overlaps(r, IO)) io = true;
    if (r[1] > 0xe000) kernal = true;
    if (overlaps(r, [0xa000, 0xc000])) basic = true;
  }
  return io ? 0x34 : kernal ? 0x35 : basic ? 0x36 : 0x37;
}

/** the BASIC line `line SYS<address>` at $0801, ending the program */
function basicLine(line: number, sys: number): number[] {
  const text = [0x9e, ...String(sys).split('').map(c => c.charCodeAt(0)), 0];
  const next = 0x0801 + 4 + text.length;
  return [next & 0xff, next >> 8, line & 0xff, (line >> 8) & 0xff, ...text, 0, 0];
}

/** places for the decruncher and its tables in low memory that a program rarely needs while it loads */
const LOW: Range[] = [[0x0100, 0x01e8], [0x0334, 0x0400], [0x0200, 0x0281]];
const ZP_SPOTS = [0xf7, 0x02, 0x22, 0xa3, 0x92, 0xb0, 0x57];
/** the top of the stack, which the decruncher's subroutine calls use (some bytes below where BASIC's SYS leaves it) */
const STACK: Range = [0x01e8, 0x0200];
const PROLOGUE_SIZE = 8;

function build(source: string, defs: Record<string, number>, at?: number): ReturnType<typeof assemble> {
  try { return assemble(at == null ? source : `* = ${at}\n${source}`, defs); }
  catch (e) {
    if (e instanceof AsmError) throw new BrokkrError('BRK-E900', `Brokkr's decruncher did not assemble: ${e.message}. This is a bug in Brokkr.`);
    throw e;
  }
}

/** Free places of `size` bytes in [from, to) that miss every blocked range, at multiples of `align`, lowest first. */
function places(size: number, blocked: Range[], from: number, to: number, align = 1): number[] {
  const out: number[] = [];
  const up = (a: number) => Math.ceil(a / align) * align;
  let a = up(from);
  while (a + size <= to && out.length < 8) {
    const hit = blocked.find(b => overlaps(b, [a, a + size]));
    if (!hit) { out.push(a); a = up(a + Math.max(size, 256)); continue; }
    a = up(Math.max(a + 1, hit[1]));
  }
  return out;
}

/** A decruncher for a stream: its sources, zero page and tables, and the sizes of its parts. */
interface Kit {
  stream: Uint8Array; safety: number;
  zp: number; zpBytes: number;
  resident: string; start: string;
  /** the constants both parts take (the tables' addresses are added by name) */
  base: Record<string, number>;
  /** each at a multiple of its `align` */
  tables: { name: string; what: string; size: number; align?: number }[];
  /** labels of the resident part the start jumps to or calls */
  links: string[];
  /** the resident part's size, and the start's when it moves the stream down and up */
  bSize: number; aDown: number; aUp: number;
  /** about what the file takes */
  size: number;
  /** tried before the others when it finds room (the faster decruncher), whatever its size */
  first: boolean;
  format: SfxFormat; protocol: number; crunched?: Crunched; brk?: BrkCrunched;
}
type Plan = { layout: 'end' | 'start'; fB: number; fC: number; aAt: number; fE: number; B: Range; tables: Range[]; x: number };

/** What to crunch, and how: to Exomizer's format, or to Brokkr's own. */
export type CrunchRequest = { format: 'exomizer'; data: Uint8Array; options: CrunchOptions } | { format: 'brokkr'; data: Uint8Array; options: BrkOptions };

function crunchHere(r: CrunchRequest): Crunched | BrkCrunched {
  return r.format === 'brokkr' ? crunchBrk(r.data, r.options) : crunchData(r.data, r.options);
}

/**
 * Crunch a program into a self-extracting PRG. `data` is the memory from `load` on (a PRG's bytes without its
 * load address); with `start: 'sys'` it must hold the BASIC line with the SYS.
 */
export function sfx(data: Uint8Array, load: number, o: SfxOptions = {}): SfxResult {
  const steps = sfxSteps(data, load, o);
  let r = steps.next();
  while (!r.done) r = steps.next(crunchHere(r.value));
  return r.value;
}

/** The same, with a crunch to Exomizer's format that may run elsewhere (the thorough search on a pool of threads). */
export async function sfxAsync(data: Uint8Array, load: number, o: SfxOptions, crunch: (d: Uint8Array, o: CrunchOptions) => Promise<Crunched>): Promise<SfxResult> {
  const steps = sfxSteps(data, load, o);
  let r = steps.next();
  while (!r.done) r = steps.next(r.value.format === 'exomizer' ? await crunch(r.value.data, r.value.options) : crunchHere(r.value));
  return r.value;
}

function* sfxSteps(data: Uint8Array, load: number, o: SfxOptions): Generator<CrunchRequest, SfxResult, Crunched | BrkCrunched> {
  const lo = load, hi = load + data.length;
  if (!data.length) throw new BrokkrError('BRK-E100', 'There is nothing to crunch: the program is empty.');
  if (hi > 0x10000) throw new BrokkrError('BRK-E101', `The program ${span(lo, hi)} goes past $ffff.`);
  const U: Range = [lo, hi];
  const warnings: string[] = [];
  const startKind = o.start ?? 'sys';
  const basic = startKind === 'basic';
  let entry: number;
  if (startKind === 'sys') {
    const sys = lo === 0x0801 ? findSys(a => (a >= lo && a < hi ? data[a - lo] : 0)) : null;
    if (sys == null) {
      throw new BrokkrError('BRK-E110', lo === 0x0801
        ? 'The program has no SYS in its first BASIC line, so Brokkr does not know where it starts.'
        : `The program loads at ${h4(lo)}, not at $0801, so it has no BASIC line with a SYS to start it.`,
      'Give the start address (start: $xxxx, or --start on the command line), or RUN for a BASIC program.');
    }
    entry = sys;
  } else if (basic) {
    if (lo !== 0x0801) warnings.push(`The program loads at ${h4(lo)}; RUN starts the BASIC program at $0801.`);
    entry = 0xa7ae;
  } else {
    entry = startKind;
    if (entry < 0 || entry > 0xffff) throw new BrokkrError('BRK-E111', `The start address ${entry} is not an address.`);
  }
  if (overlaps(U, STACK)) {
    throw new BrokkrError('BRK-E120', `The program ${span(lo, hi)} covers the top of the stack ${span(STACK[0], STACK[1])}, which the decruncher needs while it runs.`,
      'Leave that part out of what is packed, or pack the data with `mem` and decrunch it with your own code.');
  }
  if (lo < 2) throw new BrokkrError('BRK-E121', `The program starts at ${h4(lo)}: $0000 and $0001 are the CPU port, not memory.`);

  const ramExit = basic ? 0x37 : o.ramExit ?? 0x37;
  if (basic && o.ramExit != null && (o.ramExit & 7) !== 7) warnings.push('RUN needs BASIC and the KERNAL: $01 is $37 after decrunching.');
  const irqExit = o.irqExit ?? (ramExit & 2) !== 0;
  if (irqExit && !(ramExit & 2)) warnings.push(`Interrupts go on with the KERNAL out ($01 = ${h2(ramExit)}): the program must have its own interrupt vector at $fffe.`);
  const line = basicLine(o.line ?? 0, 0x080d);
  if (line.length !== 12) throw new BrokkrError('BRK-E901', 'The BASIC line is not 12 bytes long. This is a bug in Brokkr.');
  const sysAt = 0x0801 + line.length;
  const zpFor = (bytes: number) => {
    const z = ZP_SPOTS.find(s => s + bytes <= 0x100 && !overlaps([s, s + bytes], U));
    if (z == null) throw new BrokkrError('BRK-E140', `The program ${span(lo, hi)} covers every zero page place the decruncher could use (${bytes} bytes from ${ZP_SPOTS.map(h2).join(', ')}).`, 'Leave the zero page out of what is packed.');
    return z;
  };
  const exitDefs = { RAM_EXIT: ramExit, IRQ_EXIT: irqExit ? 1 : 0, START: basic ? 0 : entry, BASIC: basic ? 1 : 0, BASIC_END: hi & 0xffff, EFFECT: o.effect === false ? 0 : 1 };
  /** the sizes of a kit's parts: the resident one, and the start moving the stream down (at the file's end) or up */
  const sized = (k: Omit<Kit, 'bSize' | 'aDown' | 'aUp' | 'size'>): Kit => {
    const tablesAt = Object.fromEntries(k.tables.map(t => [t.name, 0x1000]));
    const defs = { ...k.base, ...tablesAt, ZP: k.zp, STREAM_END: 0x1000 };
    const bSize = build(k.resident, defs, 0x1000).bytes.length;
    const startDefs = {
      ...defs, A_ADDR: 0x3000, RAM_DURING: 0x37, B_FROM: 0x2000, B_TO: 0x0100, B_LEN: bSize, DATA_END: 0x1000, MOVE_LEN: k.stream.length,
      ...Object.fromEntries(k.links.map(l => [l, 0x0100])),
    };
    const aDown = build(k.start, { ...startDefs, PROLOGUE: 0, MOVE_FROM: 0x2000, MOVE_TO: 0x1000 }).bytes.length;
    const aUp = build(k.start, { ...startDefs, PROLOGUE: 1, MOVE_FROM: 0x1000, MOVE_TO: 0x2000 }).bytes.length;
    return { ...k, bSize, aDown, aUp, size: k.stream.length + bSize + Math.max(aDown + PROLOGUE_SIZE, aUp) };
  };

  // crunch backward, as the decruncher reads
  const reversed = data.slice().reverse();
  function* exomizerKits(): Generator<CrunchRequest, Kit[], Crunched | BrkCrunched> {
    const out: Kit[] = [];
    const zp = zpFor(ZP_BYTES);
    // with a table for length 3 or not, and without literal sequences too when the stream has some (the
    // decruncher is 20 bytes shorter without them)
    for (const four of o.fourTables === 'auto' ? [false, true] : [o.fourTables === true]) {
      const flags = P.BE | P.COPY_GT7 | P.IMPL_LIT | P.REUSE | (four ? P.FOUR_TABLES : 0);
      const crunches: Crunched[] = [(yield { format: 'exomizer', data: reversed, options: { ...o.crunch, protocol: { ...o.crunch?.protocol, flags, traits: T.NO_MIRRORS } } }) as Crunched];
      if (crunches[0].stats.sequences) {
        crunches.push((yield { format: 'exomizer', data: reversed, options: { ...o.crunch, protocol: { ...o.crunch?.protocol, flags, traits: T.NO_LIT_SEQ | T.NO_MIRRORS } } }) as Crunched);
      }
      for (const c of crunches) {
        out.push(sized({
          stream: c.stream, safety: c.safety, zp, zpBytes: ZP_BYTES, resident: SFX_RESIDENT, start: SFX_START,
          base: { ...exitDefs, SFX: 1, FOUR: four ? 1 : 0, REUSE: 1, LITSEQ: c.stats.sequences ? 1 : 0, MIRRORS: 0 },
          tables: [{ name: 'TABLE', what: 'Decrunch table', size: 3 * (four ? 68 : 52) }],
          links: ['literal', 'getbyte', 'getbits'], first: false, format: 'exomizer', protocol: flags, crunched: c,
        }));
      }
    }
    return out;
  }
  let kits: Kit[] = [];
  if (o.format === 'brokkr') {
    const brk = (yield { format: 'brokkr', data: reversed, options: { effort: o.crunch?.effort, profile: o.crunch?.profile } }) as BrkCrunched;
    const zp = zpFor(BRK_ZP_BYTES);
    // the faster decruncher multiplies with 1 KB of quarter squares; without room for them, it shifts and adds
    for (const qsq of [true, false]) {
      kits.push(sized({
        stream: brk.stream, safety: brk.safety, zp, zpBytes: BRK_ZP_BYTES, resident: brkResident(qsq), start: BRK_START,
        base: { ...exitDefs, QSQ: qsq ? 1 : 0, ...(qsq ? {} : { SQ: 0 }) },
        tables: [{ name: 'PROBS', what: 'Probabilities', size: 512, align: 256 }, ...(qsq ? [{ name: 'SQ', what: 'Quarter squares', size: 1024, align: 256 }] : [])],
        links: ['next'], first: qsq, format: 'brokkr', protocol: 0, brk,
      }));
    }
  } else kits = yield* exomizerKits();

  /**
   * A layout: the file is the BASIC line, then either a prologue, the resident part, the stream and the start
   * (`end`: the stream moves down, away from the start), or the start, the resident part and the stream (`start`:
   * the stream moves up). The resident part is copied before the stream moves, so it misses the file; the tables
   * are filled after, by the start, so they miss the start; while decrunching none may be in the program or the
   * stream.
   */
  const planFor = (k: Kit, ioFree: boolean): Plan | null => {
    const C = k.stream.length, s = k.safety, bSize = k.bSize;
    const Z: Range = [k.zp, k.zp + k.zpBytes];
    for (const layout of ['end', 'start'] as const) {
      const fB = layout === 'end' ? sysAt + PROLOGUE_SIZE : sysAt + k.aUp;
      const fC = fB + bSize;
      const aAt = layout === 'end' ? fC + C : sysAt;
      const fE = layout === 'end' ? aAt + k.aDown : fC + C;
      if (fE > 0xd000) continue;
      const file: Range = [0x0801, fE], A: Range = [aAt, aAt + (layout === 'end' ? k.aDown : k.aUp)];
      const io: Range[] = ioFree ? [] : [IO];
      // the resident part ends by switching $01 to its value after decrunching, so it must be RAM then too
      const exitRom: Range[] = [IO];
      if ((ramExit & 3) === 3) exitRom.push([0xa000, 0xc000]);
      if (ramExit & 2) exitRom.push([0xe000, 0x10000]);
      for (const bAt of [...LOW.filter(r => r[1] - r[0] >= bSize).map(r => r[0]), ...places(bSize, [U, file, Z, STACK, [0, 0x100], ...exitRom], 0x0400, 0x10000)]) {
        const B: Range = [bAt, bAt + bSize];
        if ([U, file, Z, STACK].some(r => overlaps(r, B))) continue;
        // each table in the first place that misses the rest
        const tables: Range[] = [];
        for (const t of k.tables) {
          const blocked = [U, B, Z, A, STACK, [0, 0x100] as Range, ...tables];
          const align = t.align ?? 1;
          const at = [...LOW.filter(r => r[1] - r[0] >= t.size && r[0] % align === 0).map(r => r[0]), ...places(t.size, blocked, 0x0400, 0x10000, align)]
            .find(a => !blocked.some(r => overlaps(r, [a, a + t.size])));
          if (at == null) break;
          tables.push([at, at + t.size]);
        }
        if (tables.length < k.tables.length) continue;
        const blocked: Range[] = [B, ...tables, Z, STACK, [0, 2], ...io];
        const free = (a: number) => a >= 2 && a + C <= 0x10000 && (layout === 'end' ? a < fC : a >= fC)
          && !blocked.some(r => overlaps(r, [a, a + C]));
        // in place (starting the safety margin before the data, or lower), else above the data
        let x: number | null = null;
        for (let a = lo - s; a >= 2;) {
          if (free(a)) { x = a; break; }
          const hit = blocked.filter(r => overlaps(r, [a, a + C])).reduce((m, r) => Math.min(m, r[0]), a);
          a = hit < a ? hit - C : a - 1;
        }
        if (x == null) for (let a = hi; a + C <= 0x10000;) {
          if (free(a)) { x = a; break; }
          a = blocked.filter(r => overlaps(r, [a, a + C])).reduce((m, r) => Math.max(m, r[1]), a + 1);
        }
        if (x != null) return { layout, fB, fC, aAt, fE, B, tables, x };
      }
    }
    return null;
  };

  // the first kit that finds room among those tried first, else the smallest; the decruncher on the screen shows
  // as garbage while it runs, so that counts as 64 bytes more
  const choose = () => {
    let best: { k: Kit; plan: Plan; score: number } | null = null;
    for (const k of [...kits].sort((a, b) => Number(b.first) - Number(a.first))) {
      const plan = planFor(k, false) ?? planFor(k, true);
      if (!plan) continue;
      if (k.first) return { k, plan, score: 0 };
      const score = k.size + (overlaps(plan.B, [0x0400, 0x0800]) ? 64 : 0);
      if (!best || score < best.score) best = { k, plan, score };
    }
    return best;
  };
  let chosen = choose();
  if (!chosen && o.format === 'brokkr' && o.fallback !== false) {
    // Brokkr's own format needs its probabilities (512 bytes) and a bigger decruncher; Exomizer's may still fit
    const own = kits[kits.length - 1];
    kits = yield* exomizerKits();
    chosen = choose();
    if (chosen) warnings.push(`The program leaves no room for the probabilities (512 bytes) and the decruncher (${own.bSize} bytes) of Brokkr's own format while it decrunches, so the file is in Exomizer's format.`);
  }
  if (!chosen) {
    const k = kits.reduce((x, y) => (y.size < x.size ? y : x));
    if (sysAt + PROLOGUE_SIZE + k.bSize + k.stream.length + k.aDown > 0xd000) {
      throw new BrokkrError('BRK-E130', `The self-extracting file would reach past $d000 (the crunched data is ${k.stream.length} bytes): a file that loads into $d000 and up writes over I/O.`,
        'Make the program smaller or leave parts out, or pack them with `mem` and load them with a loader.');
    }
    const tables = k.tables.map(t => `${t.what.toLowerCase()} (${t.size} bytes)`).join(', ');
    throw new BrokkrError('BRK-E150', `There is no room for the decruncher (${k.bSize} bytes), its ${tables} and the crunched data (${k.stream.length} bytes) next to the program ${span(lo, hi)}.`,
      k.format === 'brokkr'
        ? "Brokkr's own format needs more memory while it decrunches than Exomizer's: leave some free, or pack with the Exomizer format."
        : 'Leave out a part of memory the program does not need at its start, such as $0100-$01ff or $0334-$03ff, or pack with `mem`.');
  }

  const { k, plan } = chosen;
  const stored = k.stream.slice().reverse();
  const C = stored.length;
  const { layout, fB, fC, aAt, fE, B, tables, x } = plan;
  const X: Range = [x, x + C], file: Range = [0x0801, fE];
  const ramDuring = ramFor([U, file, X, B, ...tables]);
  const ioVisible = (ramDuring & 3) !== 0 && (ramDuring & 4) !== 0;
  const effect = o.effect !== false && ioVisible;
  if (o.effect !== false && !ioVisible) warnings.push('No border flashing: I/O is switched out while decrunching, as data goes to or comes from $d000-$dfff.');
  if (overlaps(X, [0x0400, 0x07e8]) && !overlaps(U, [0x0400, 0x07e8])) warnings.push(`The crunched data lies on the screen (${span(Math.max(x, 0x0400), Math.min(x + C, 0x07e8))}) while decrunching, so the screen shows it.`);
  if (overlaps(B, [0x0400, 0x07e8])) warnings.push(`The decruncher runs on the screen (${span(B[0], B[1])}), as the program leaves no room for it in $0100-$01df or $0334-$03ff.`);
  for (let i = 0; i < tables.length; i++) {
    if (overlaps(tables[i], [0x0400, 0x07e8]) && !overlaps(U, [0x0400, 0x07e8])) warnings.push(`The decruncher's ${k.tables[i].what.toLowerCase()} are on the screen (${span(tables[i][0], tables[i][1])}) while it decrunches.`);
  }

  const tableDefs = Object.fromEntries(k.tables.map((t, i) => [t.name, tables[i][0]]));
  const defs = { ...k.base, ...tableDefs, ZP: k.zp, EFFECT: effect ? 1 : 0, STREAM_END: (x + C) & 0xffff };
  const resident = build(k.resident, defs, B[0]);
  const L = resident.labels;
  const startCode = build(k.start, {
    ...defs, A_ADDR: aAt, PROLOGUE: layout === 'start' ? 1 : 0, RAM_DURING: ramDuring,
    B_FROM: fB, B_TO: B[0], B_LEN: resident.bytes.length, DATA_END: hi & 0xffff, MOVE_FROM: fC, MOVE_TO: x, MOVE_LEN: C,
    ...Object.fromEntries(k.links.map(l => [l, L[l]])),
  });
  const prg = new Uint8Array(2 + fE - 0x0801);
  prg.set([0x01, 0x08, ...line]);
  if (layout === 'end') prg.set(build(SFX_PROLOGUE, { RAM_DURING: ramDuring, A_ADDR: aAt }).bytes, 2 + sysAt - 0x0801);
  prg.set(startCode.bytes, 2 + aAt - 0x0801);
  prg.set(resident.bytes, 2 + fB - 0x0801);
  prg.set(stored, 2 + fC - 0x0801);
  const used = layout === 'end' ? aAt + startCode.bytes.length : fE;

  // run it
  const m = new Machine();
  m.ram.set(prg.subarray(2, 2 + used - 0x0801), 0x0801);
  m.cpu.s = 0xf6;
  m.cpu.i = 0;
  const done = L.done;
  const stopAt = basic ? 0xa659 : entry;
  let finished = false;
  const run = m.run(sysAt, pc => { if (pc === done) finished = true; return finished && pc === stopAt; }, 2_000_000_000);
  const fail = (why: string) => {
    throw new BrokkrError('BRK-E910', `Brokkr's check of the self-extracting file failed: ${why}. This is a bug in Brokkr; please report it with the program.`);
  };
  if (m.trouble.length) fail(m.trouble.map(t => `at ${h4(t.pc)} it ${t.what} (${h4(t.addr)})`).join('; '));
  if (!run.stopped) fail(`it did not reach ${h4(stopAt)} within ${run.cycles} cycles`);
  for (let i = 0; i < data.length; i++) if (m.ram[lo + i] !== data[i]) fail(`the byte at ${h4(lo + i)} is ${h2(m.ram[lo + i])}, not ${h2(data[i])}`);
  if ((m.port & 7) !== (ramExit & 7)) fail(`$01 is ${h2(m.port)}, not ${h2(ramExit)}`);
  if (m.cpu.i !== (irqExit ? 0 : 1)) fail(`interrupts are ${m.cpu.i ? 'off' : 'on'}`);

  const areas: Area[] = [
    { name: 'Crunched data', start: x, end: x + C },
    { name: 'Decrunched data', start: lo, end: hi },
    ...k.tables.map((t, i) => ({ name: k.format === 'brokkr' ? t.what : 'Decrunch table', start: tables[i][0], end: tables[i][1] })),
    { name: 'Decruncher', start: B[0], end: B[0] + resident.bytes.length, note: `zero page ${h2(k.zp)}-${h2(k.zp + k.zpBytes - 1)}` },
    { name: 'File', start: 0x0801, end: used },
  ];
  return {
    prg: prg.subarray(0, 2 + used - 0x0801), areas, entry, basic, ramDuring, ramExit, irqExit, effect, format: k.format,
    stream: k.stream, crunched: k.crunched, brk: k.brk, protocol: k.protocol, cycles: run.cycles, warnings,
  };
}
