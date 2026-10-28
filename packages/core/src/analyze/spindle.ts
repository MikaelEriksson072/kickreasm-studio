/* 5.4c Spindle's effect drivers (spec 8.11f). Pefchain, the linker of Spindle (lft), builds a demo from a script with a
 * line per part: the part's .pef file and the condition that ends it (`space`, `-` for at once, `stay`, `addr = value`,
 * `@` for the music's interlock), `|` to go on with the part before, `-` as the name for its blank part, and `NN:` for
 * a label to seek to. The script itself is not on the disk. Pefchain turns each line into a driver, about 48 bytes of
 * code after the part's code: it installs the part's interrupt, calls its setup, calls the loader and the next part's
 * prepare, waits for the condition, runs the fadeout and the cleanup and jumps to the next driver. Reading the drivers
 * in memory back gives the script's lines for the parts that are there.
 *
 * The code below is what Spindle 3.0 and 3.1 write (pefchain.c: generate_drivers and the routines it calls, MIT
 * licence; template/earlysetup.s and seek.s, public domain), checked against the drivers pefchain 3.1 printed (-v -v)
 * for test parts. Spindle 2 builds other drivers, which are not read. */
import type { Addr, SpindleCondition, SpindleDriver } from '../types';
import type { Ctx } from './context';
import { $4, h2, h4 } from '../util/hex';
import { parseVsf, snapshotConfig } from '../c64/vsf';

type Pat = (number | null)[];
/** hex bytes, `..` for any byte */
const hex = (s: string): Pat => s.trim().split(/\s+/).map(t => (t === '..' ? null : parseInt(t, 16)));

/** template/earlysetup.s: the first driver starts with it, unless the demo brings its own (pefchain -s) */
const EARLY_SETUP = hex(`2c 11 d0 30 fb 2c 11 d0 10 fb a9 40 8d ff ff a2 ff 8e fa ff 8e fb ff e8 8e 0e dd 8e 04 dd 8e 05 dd
  a9 81 8d 0d dd a9 19 8d 0e dd ae 12 d0 e8 ec 12 d0 d0 fb a0 00 8c 07 dc a9 3e 8d 06 dc c8 8c 1a d0 88 88 8c 02 dc
  ea ea ea ea ea ea ea ea ea a9 11 8d 0f dc 8a e8 e8 cd 12 d0 d0 d2`);
/** template/seek.s without its rts: tells the drive the label (in A) to seek to */
const SEEK = hex('09 80 38 2a a2 18 8e 00 dd 90 02 a0 10 2c 00 dd 10 fb 8c 00 dd a0 05 88 d0 fd 0a d0 e9 a2 08 8e 00 dd');
/** the side door: the cleanup of the part before comes on the stack, called through a jmp in the zero page */
const SIDE = hex('a9 4c 85 .. 68 85 .. 68 85 .. 20 .. 00');
/** lda #<irq / sta $fffe / lda #>irq / sta $ffff; after the setup lsr $d019 / cli */
const IRQ_SET = hex('a9 .. 8d fe ff a9 .. 8d ff ff');
const ACK = hex('4e 19 d0 58');
/** the space bar: lda #$7f / sta $dc00 / lda #$10 / bit $dc01, then beq (until it is let go) or bne (until pressed) */
const SPACE = hex('a9 7f 8d 00 dc a9 10 2c 01 dc');
/** the end of the demo: clc / bcc * */
const STOP = hex('18 90 fe');
/** Pefchain's blank part: its interrupt plays the music (jsr, or bit $0000 without), and its setup blanks the screen */
const BLANK_IRQ = hex('c6 00 48 8a 48 98 48 .. .. .. 68 a8 68 aa 68 4e 19 d0 e6 00 40');
const BLANK_SETUP = hex('a9 00 8d 11 d0 8d 20 d0 8d 15 d0 a9 f0 8d 12 d0 60');
/** the start of Spindle 3's resident page (stage1.s; analyze/loaders.ts knows the loader by it too) */
const RESIDENT = hex('a9 18 80 01 c9 38 f0 .. 8d 00 dd');
/** a driver, the early setup included, fits in 250 bytes */
const MAX_DRIVER = 250;

interface Mem { b: (a: number) => number; w: (a: number) => Addr; is: (a: number, p: Pat) => boolean }

const memOf = (ctx: Ctx): Mem => {
  const { mem, loaded } = ctx;
  const ok = (a: number) => a >= 0 && a < 0x10000 && loaded(a);
  return {
    b: a => (ok(a) ? mem[a] : -1),
    w: a => mem[a & 0xffff] | (mem[(a + 1) & 0xffff] << 8),
    is: (a, p) => p.every((x, i) => ok(a + i) && (x == null || mem[a + i] === x)),
  };
};

type Item =
  | { t: 'load'; at: Addr }
  | { t: 'call'; at: Addr; to: Addr; sec: boolean }
  | { t: 'cond'; at: Addr; c: SpindleCondition; main: Addr | null }
  | { t: 'fade'; at: Addr; main: Addr | null; fadeout: Addr }
  | { t: 'seek'; at: Addr; label: number }
  | { t: 'jump'; at: Addr };

/** A driver from its front door on: what it sets up, its calls and loops in order, and how it ends. */
interface Body {
  end: Addr; irq: Addr | null; setup: Addr | null; extend: boolean; items: Item[];
  next: Addr | null; ends: SpindleDriver['ends'];
  /** the cleanup a seek jump passes on the stack */
  cleanup: Addr | null;
}

/** The driver whose front door is `front`, read up to `room` bytes; null: it is not one. `res`: the loader's page. */
function readBody(m: Mem, front: Addr, res: number, room: number): Body | null {
  const { b, w, is } = m;
  const loader = res << 8;
  const to = (br: number) => br + 2 + ((b(br + 1) ^ 0x80) - 0x80);
  // the seek jump: the cleanup's address and $00 / zp-1 (the side door's jmp) on the stack, then the loader, which seeks
  const seekJump = (a: number) => is(a, [0xa9, null, 0x48, 0xa9, null, 0x48, 0xa9, 0x00, 0x48, 0xa9, null, 0x48, 0x4c, 0x00, res]);
  // a part without a cleanup passes an rts in the resident page
  const pushed = (a: number): Addr | null => (b(a + 1) === res ? null : (b(a + 1) << 8) | b(a + 4));
  /** a loop at p that waits for the condition or runs the fadeout: [jsr main], the test, a branch back to p */
  const loop = (p: number, inc: Addr | null): { item: Item; end: number } | null => {
    let q = p, main: Addr | null = null;
    if (b(q) === 0x20 && w(q + 1) !== loader) { main = w(q + 1); q += 3; }
    const back = (br: number) => to(br) === p;
    if (b(q) === 0x20 && b(q + 3) === 0x90 && back(q + 3)) return { item: { t: 'fade', at: p, main, fadeout: w(q + 1) }, end: q + 5 };
    if (main != null && b(q) === 0x90 && back(q)) return { item: { t: 'fade', at: p, main: null, fadeout: main }, end: q + 2 };
    if (is(q, SPACE) && b(q + 10) === 0xf0 && back(q + 10)) {
      // then the same with bne
      const p2 = q + 12;
      const q2 = b(p2) === 0x20 ? p2 + 3 : p2;
      return is(q2, SPACE) && b(q2 + 10) === 0xd0 && to(q2 + 10) === p2 ? { item: { t: 'cond', at: p, c: { kind: 'space' }, main }, end: q2 + 12 } : null;
    }
    const lda = b(q) === 0xa5 ? { a: b(q + 1), n: 2 } : b(q) === 0xad ? { a: w(q + 1), n: 3 } : null;
    if (lda) {
      const r = q + lda.n;
      if (b(r) === 0xc9 && b(r + 2) === 0xd0 && back(r + 2)) return { item: { t: 'cond', at: p, c: { kind: 'value', addr: lda.a, value: b(r + 1) }, main }, end: r + 4 };
      // the interlock: Pefchain reads one at $0100 or later as lda zp of its low byte
      if (inc != null && (lda.a === inc || (lda.n === 2 && lda.a === (inc & 0xff))) && b(r) === 0xd0 && back(r)) return { item: { t: 'cond', at: p, c: { kind: 'sync', addr: inc }, main }, end: r + 2 };
    }
    if (b(q) === 0x18 && b(q + 1) === 0x90 && back(q + 1)) return { item: { t: 'cond', at: p, c: { kind: 'stay' }, main }, end: q + 3 };
    return null;
  };

  let p = front, irq: Addr | null = null, setup: Addr | null = null;
  // `|` goes on with the part before: no sei, no interrupt, no setup
  const extend = b(p) !== 0x78;
  if (!extend) {
    p++;
    if (is(p, IRQ_SET)) {
      irq = b(p + 1) | (b(p + 6) << 8); p += 10;
      if (b(p) === 0x20 && is(p + 3, ACK)) { setup = w(p + 1); p += 3; }
      if (!is(p, ACK)) return null;
      p += 4;
    } else if (b(p) === 0x20 && w(p + 1) !== loader && !loop(p, null)) { setup = w(p + 1); p += 3; }
  }
  const items: Item[] = [];
  const done = (end: number, ends: Body['ends'], next: Addr | null = null, cleanup: Addr | null = null): Body => ({ end, irq, setup, extend, items, next, ends, cleanup });
  let inc: Addr | null = null, sec = false;
  while (p - front <= room) {
    const L = loop(p, inc);
    if (L) {
      items.push(L.item); p = L.end; inc = null;
      if (L.item.t === 'cond' && L.item.c.kind === 'stay') {
        // the part stays: the driver ends here, or (the demo's last part) with its cleanup and clc / bcc *
        if (is(p, STOP)) return done(p + 3, 'stop');
        if (b(p) === 0x20 && is(p + 3, STOP)) { items.push({ t: 'call', at: p, to: w(p + 1), sec: false }); return done(p + 6, 'stop'); }
        return done(p, 'stay');
      }
      continue;
    }
    if (inc != null) return null;
    switch (b(p)) {
      case 0x4c: return done(p + 3, 'next', w(p + 1));
      case 0x18: return is(p, STOP) ? done(p + 3, 'stop') : null;
      // before the prepare of the first part, or the jump to it: the script loops
      case 0x38: if (b(p + 1) !== 0x20 && b(p + 1) !== 0x4c) return null; sec = true; p++; continue;
      case 0xa9:
        if (is(p + 2, SEEK)) { items.push({ t: 'seek', at: p, label: b(p + 1) }); p += 2 + SEEK.length; continue; }
        // the last part of a disk side: the next side comes in through its side door
        return seekJump(p) ? done(p + 15, 'flip', null, pushed(p)) : null;
      case 0xaa: {
        // J: tax / bmi past a seek and a seek jump, taken when the fadeout leaves no label
        const over = p + 3 + SEEK.length + 15;
        if (b(p + 1) !== 0x30 || to(p + 1) !== over || items[items.length - 1]?.t !== 'fade' || !is(p + 3, SEEK) || !seekJump(p + 3 + SEEK.length)) return null;
        items.push({ t: 'jump', at: p }); p = over; continue;
      }
      case 0xe6: inc = b(p + 1); p += 2; continue;
      case 0xee: inc = w(p + 1); p += 3; continue;
      case 0x20: { const t = w(p + 1); items.push(t === loader ? { t: 'load', at: p } : { t: 'call', at: p, to: t, sec }); sec = false; p += 3; continue; }
      default: return null;
    }
  }
  return null;
}

/** A driver as read, before its calls are told apart and it is numbered. */
interface Raw {
  start: Addr; front: Addr; side: Addr | null; first: boolean; ownSetup: boolean; prepare: Addr | null; body: Body;
  /** it has code no other routine has: a side door, a loader call, a condition or fadeout loop, a seek */
  strong: boolean;
}

const isStrong = (b: Body) => b.ends === 'flip' || b.items.some(x => x.t !== 'call');

/**
 * Find the drivers in memory (5.4c): their side doors, the front doors that set $fffe, and the drivers those jump to.
 * The ones the code runs are entry points: in a snapshot not the ones of the parts before the part that runs, whose
 * routines the parts after it may have loaded over.
 */
export function findSpindle(ctx: Ctx): SpindleDriver[] {
  const m = memOf(ctx), { b, w, is } = m;
  // the loader's resident page (pefchain -r, $0200 by default): where its code is, or where the seek jumps go
  let res = 2;
  const page = [...Array(0xfd).keys()].map(p => p + 2).find(p => is(p << 8, RESIDENT));
  if (page != null) res = page;
  else for (let a = 11; a < 0xfff0; a++) if (b(a) === 0x48 && is(a + 1, [0x4c, 0x00]) && is(a - 11, [0xa9, null, 0x48, 0xa9, null, 0x48, 0xa9, 0x00, 0x48, 0xa9])) { res = b(a + 3); break; }
  const raws = new Map<Addr, Raw>();
  const add = (start: Addr, front: Addr, side: Addr | null, first: boolean, ownSetup: boolean, prepare: Addr | null, weak = false) => {
    if (raws.has(front)) return true;
    const body = readBody(m, front, res, MAX_DRIVER - (front - start));
    if (!body || (body.next != null && body.next >= start && body.next < body.end)) return false;
    const strong = side != null || isStrong(body);
    if (!strong && !weak) return false;
    raws.set(front, { start, front, side, first, ownSetup, prepare, body, strong });
    return true;
  };

  for (let s = 0; s < 0xfff3; s++) {
    if (!is(s, SIDE)) continue;
    const z = b(s + 3);
    if (b(s + 6) !== z + 1 || b(s + 9) !== z + 2 || b(s + 11) !== z) continue;
    const core = s + SIDE.length;
    // the first driver: [early setup] [clc / jsr prepare] clc / bcc past the side door [sec / jsr prepare] side door, sec
    let first: { start: Addr; side: Addr; prepare: Addr | null; own: boolean } | null = null;
    for (const pre of [4, 0]) {
      const side = s - pre, by = side - 3;
      if (pre && !is(side, [0x38, 0x20])) continue;
      if (b(core) !== 0x38 || !is(by, [0x18, 0x90]) || by + 3 + b(by + 2) !== core + 1) continue;
      let start = is(by - 4, [0x18, 0x20]) ? by - 4 : by;
      const own = !is(start - EARLY_SETUP.length, EARLY_SETUP);
      if (!own) start -= EARLY_SETUP.length;
      first = { start, side, prepare: pre ? w(s - 2) : null, own };
      break;
    }
    if (first) { add(first.start, core + 1, first.side, true, first.own, first.prepare); continue; }
    // a part after a label: [jsr prepare] side door
    const own = b(s - 3) === 0x20 && w(s - 2) !== res << 8;
    add(own ? s - 3 : s, core, own ? s - 3 : s, false, false, own ? w(s - 2) : null);
  }
  // front doors that install an interrupt
  const weak: Addr[] = [];
  for (let a = 0; a < 0xfff0; a++) {
    if (b(a) !== 0x78 || !is(a + 1, IRQ_SET) || raws.has(a)) continue;
    if (!add(a, a, null, false, false, null)) weak.push(a);
  }
  // the drivers they jump to (one that does only what any code could starts with sei: where the next driver is not
  // loaded yet, older code such as jsr / jmp is not one), and a driver like that which jumps to one
  const follow = () => {
    for (let more = true; more;) {
      more = false;
      for (const r of [...raws.values()]) {
        const n = r.body.next;
        if (n != null && !raws.has(n) && add(n, n, null, false, false, null, b(n) === 0x78)) more = true;
      }
    }
  };
  follow();
  for (const a of weak) {
    const body = readBody(m, a, res, MAX_DRIVER);
    if (body?.next != null && raws.has(body.next) && add(a, a, null, false, false, null, true)) follow();
  }
  if (!raws.size) return [];

  // in the order they run: the first driver's chain, then the others from the ones nothing jumps to
  const all = [...raws.values()];
  const reached = new Set(all.map(r => r.body.next));
  const heads = all.slice().sort((x, y) => Number(y.first) - Number(x.first) || Number(reached.has(x.front)) - Number(reached.has(y.front)) || x.front - y.front);
  const order: Raw[] = [], seen = new Set<Raw>();
  for (const h of heads) for (let r: Raw | undefined = h; r && !seen.has(r); r = r.body.next != null ? raws.get(r.body.next) : undefined) { seen.add(r); order.push(r); }

  const snap = snapshotState(ctx);
  const drivers = order.map((r): SpindleDriver => {
    const { body } = r;
    const next = body.next != null ? raws.get(body.next) : undefined;
    const items = body.items.slice();
    // a lone call of main before its loop: the condition `-` of a part with a main routine
    let main: Addr | null = null;
    for (let k = 0; k + 1 < items.length; k++) {
      const x = items[k], y = items[k + 1];
      if (x.t === 'call' && (y.t === 'fade' || y.t === 'cond') && y.main === x.to) { main = x.to; items.splice(k, 1); break; }
    }
    const cond = items.find(x => x.t === 'cond') as Extract<Item, { t: 'cond' }> | undefined;
    const fade = items.find(x => x.t === 'fade') as Extract<Item, { t: 'fade' }> | undefined;
    main = main ?? cond?.main ?? fade?.main ?? null;
    // the calls: without a main routine [load] [prepare next] loops [cleanup]; with one loops [load] [prepare next] [cleanup]
    const loops = items.flatMap((x, k) => (x.t === 'cond' || x.t === 'fade' ? [k] : []));
    const calls = items.flatMap((x, k) => (x.t === 'call' ? [{ ...x, k }] : []));
    let prepareNext: Addr | null = null, cleanup = body.cleanup;
    if (main == null && loops.length) {
      prepareNext = calls.find(c => c.k < loops[0])?.to ?? null;
      cleanup = calls.filter(c => c.k > loops[loops.length - 1]).pop()?.to ?? cleanup;
    } else {
      const after = main == null ? calls : calls.filter(c => c.k > loops[loops.length - 1]);
      if (after.length >= 2) { prepareNext = after[0].to; cleanup = after[after.length - 1].to; }
      else if (after.length === 1) {
        // one call: its part's cleanup when it is nearer below this driver than below the next one
        const x = after[0].to, below = (d: Addr) => (x < d ? d - x : Infinity);
        const mine = below(r.start), theirs = next ? below(next.start) : Infinity;
        if (!after[0].sec && mine <= theirs && mine < 0x4000) cleanup = x; else prepareNext = x;
      }
    }
    const irq = body.irq;
    const blank = irq != null && is(irq, BLANK_IRQ) && (b(irq + 7) === 0x2c || b(irq + 7) === 0x20) && body.setup === irq + BLANK_IRQ.length && is(irq + BLANK_IRQ.length, BLANK_SETUP);
    const running = !!snap && ((snap.pc >= r.start && snap.pc < body.end) || (irq != null && snap.vector === irq));
    return {
      part: 0, start: r.start, end: body.end, front: r.front, side: r.side, first: r.first, ownSetup: r.ownSetup,
      prepare: r.prepare, setup: body.setup, irq, main, fadeout: fade?.fadeout ?? null, cleanup, prepareNext,
      condition: cond?.c ?? { kind: 'drop' }, loads: items.some(x => x.t === 'load'), next: body.next, ends: body.ends,
      seek: (items.find(x => x.t === 'seek') as Extract<Item, { t: 'seek' }> | undefined)?.label ?? null,
      jump: items.some(x => x.t === 'jump'), extend: body.extend, blank,
      music: blank && b(irq! + 7) === 0x20 ? w(irq! + 8) : null, running,
    };
  });
  // the part before in each driver's chain, for its prepare; `|` goes on with that part, under its number
  let part = 0;
  drivers.forEach((d, i) => {
    const prev = drivers.find(x => x.next === d.front);
    if (d.prepare == null) d.prepare = prev?.prepareNext ?? null;
    d.part = d.extend && i && drivers[i - 1] === prev ? prev.part : ++part;
  });

  // entry points: every driver; in a snapshot the ones before the part that runs as guesses (a deep analysis traces
  // them on trial), since the parts after them may have loaded over their routines
  const before = new Set<SpindleDriver>();
  for (const d of drivers.filter(x => x.running)) {
    for (let x = drivers.find(y => y.next === d.front); x && !x.running && !before.has(x); x = drivers.find(y => y.next === x!.front)) before.add(x);
  }
  for (const d of drivers) for (const a of new Set([d.start, d.front, d.side])) if (a != null) ctx.enqueue(a, before.has(d) ? 'guess' : 'entry');
  const n = drivers.length;
  ctx.L('ok', `Spindle: ${n} effect driver${n === 1 ? '' : 's'} (Pefchain), from ${$4(drivers[0].start)}; the Spindle tab shows them as the script they were built from`, drivers[0].start, 'loader');
  return drivers;
}

/** In a snapshot: where the CPU was, and the interrupt handler its vector points at. */
function snapshotState(ctx: Ctx): { pc: Addr; vector: Addr } | null {
  for (const f of ctx.files) {
    if (!f.vsf) continue;
    try {
      const s = parseVsf(f.vsf), v = snapshotConfig(s) & 2 ? 0x0314 : 0xfffe;
      return { pc: s.cpu?.pc ?? -1, vector: s.ram[v] | (s.ram[v + 1] << 8) };
    } catch { /* not readable */ }
  }
  return null;
}

const hx = (a: Addr) => (a < 0x100 ? h2(a) : h4(a));

/** A condition the way Pefchain's script writes it: `space`, `-`, `stay`, `ed = 0b`, `@`. */
export function spindleCondition(c: SpindleCondition): string {
  switch (c.kind) {
    case 'space': return 'space';
    case 'drop': return '-';
    case 'stay': return 'stay';
    case 'sync': return '@';
    case 'value': return `${hx(c.addr)} = ${h2(c.value)}`;
  }
}

/** The name column: the part's .pef file (made up, the script's names are not in the program), `|` or `-`. */
export const spindleName = (d: SpindleDriver): string => (d.blank ? '-' : d.extend ? '|' : `part${d.part}.pef`);

/** The label a driver's chain seeks to before it jumps to `d`, when one does (the script loops). */
export const spindleLabel = (d: SpindleDriver, drivers: SpindleDriver[]): number | null =>
  drivers.find(x => x.seek != null && x.next === d.front)?.seek ?? null;

/** A part's routines, as `name $addr` (its prepare from the driver before when that one calls it). */
export function spindleRoutines(d: SpindleDriver): [string, Addr][] {
  const r: [string, Addr | null][] = [['prepare', d.prepare], ['setup', d.setup], ['irq', d.irq], ['main', d.main], ['fadeout', d.fadeout], ['cleanup', d.cleanup]];
  return r.filter((x): x is [string, Addr] => x[1] != null);
}

/**
 * The Spindle script the drivers were built from, as Pefchain reads it: a line per part with its condition, and after
 * `#` the driver and the part's routines. Labels whose number a loop shows are lines of their own (`01:`).
 */
export function spindleScript(drivers: SpindleDriver[]): string[] {
  if (!drivers.length) return [];
  const out = [
    `# Spindle script, rebuilt by Mimir Studio from the ${drivers.length} Pefchain driver${drivers.length === 1 ? '' : 's'} in memory.`,
    '# The parts are numbered in the order they run; their file names are not in the program.',
  ];
  drivers.forEach((d, i) => {
    const prev = drivers[i - 1];
    if (prev && prev.next !== d.front) out.push('', '# not reached from the part above:');
    const label = spindleLabel(d, drivers);
    if (label != null) out.push(`${h2(label)}:`);
    else if (d.side != null && !d.first) out.push(`# a label to seek to (its number is on the disk) comes in at $${h4(d.side)}`);
    const notes = [
      d.blank ? `Pefchain's blank part${d.music != null ? `, plays $${h4(d.music)}` : ''}` : null,
      d.condition.kind === 'sync' ? `the interlock at $${hx(d.condition.addr)} (pefchain -@ ${hx(d.condition.addr)})` : null,
      d.jump ? 'the fadeout picks a label to seek to (J)' : null,
      d.loads ? 'loads' : null,
      d.running ? 'running' : null,
    ].filter(Boolean);
    const routines = d.blank ? [] : spindleRoutines(d).map(([k, a]) => `${k} $${h4(a)}`);
    const what = [`driver $${h4(d.front)}${routines.length ? `: ${routines.join(', ')}` : ''}`, ...notes].join('; ');
    out.push(`${spindleName(d).padEnd(13)} ${spindleCondition(d.condition).padEnd(10)} # ${what}`);
    const after = drivers[i + 1];
    if (d.ends === 'stop') out.push('# the end of the demo');
    else if (d.ends === 'flip') out.push('# the end of the disk side: then the next side');
    else if (d.ends === 'next' && d.next != null && after?.front !== d.next) {
      const to = drivers.find(x => x.front === d.next);
      out.push(to ? `# then back to part ${to.part}${d.seek != null ? ` (pefchain -L ${h2(d.seek)})` : ''}` : `# then the driver at $${h4(d.next)}, which is not in memory`);
    }
  });
  return out;
}
