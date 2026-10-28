/* 5.15 Loaders (spec 8.11c): the fast, IRQ and tape loaders in the program.
 *
 * Spindle, Krill's loader, Bitfire, Sparkle and the Covert Bitops loader are known by their own receive loops, install
 * commands and texts; the byte patterns come from their sources (Spindle 3.1 stage1.s, Krill's loader v194
 * hal-c64-c128.inc and install.s, Bitfire resident.asm, Sparkle sl.asm, Covert Bitops loader v3 loader.s). Any other
 * loader is known by what every disk loader has (Spindle 2.3 and an older Bitfire were read from their releases' binaries): code for the 1541 (it reads and writes the drive's VIA registers at
 * $1800 and $1c00, and waits for GCR bytes with bvc *), drive commands that upload and start it (M-W, M-E, M-R) and a
 * receive loop that reads the serial bus at $dd00 again and again. A tape turbo loader reads CIA1's FLAG line and times
 * the pulses with a CIA timer; the KERNAL's own LOAD is a call to $ffd5. */
import type { Addr, Block, LoaderFinding, LoaderId, LoaderPart } from '../types';
import type { Ctx } from './context';
import { $4 } from '../util/hex';
import { parseVsf } from '../c64/vsf';

type Pattern = (Set<number> | null)[];
/** hex bytes, `..` for any byte, `a|b` for either */
const pat = (s: string): Pattern => s.trim().split(/\s+/).map(t => (t === '..' ? null : new Set(t.split('|').map(x => parseInt(x, 16)))));

interface Sign {
  pat: Pattern; role: LoaderPart['role']; what: string;
  /** the match starts the resident page: the part is that page */
  page?: boolean;
  /** a resident part at a fixed place: the part is all of it when the match is inside */
  fixed?: [Addr, Addr];
}
interface Known { id: LoaderId; name: string; how: string; signs: Sign[]; /** a name it writes somewhere */ text?: string }

const KNOWN: Known[] = [
  {
    id: 'spindle', name: 'Spindle (lft)', how: '2-bit + ATN, synchronous; one resident page that the program calls with jsr, the VIC bank set through $dd02',
    signs: [
      { pat: pat('A9 18 80 01 C9 38 F0 .. 8D 00 DD 2C 00 DD 30 .. 50'), role: 'resident', what: 'resident page (jsr here to load the next part)', page: true },
      { pat: pat('4D 00 DD 8F 00 DD 4A 4A C8 8C'), role: 'resident', what: 'receive loop (eor $dd00 / sax $dd00)' },
      // Spindle 2: two resident pages at $0c00-$0dff, loading with jsr $0c90, bytes decoded through a table
      { pat: pat('AE 00 DD 8C 00 DD 5D'), role: 'resident', what: 'Spindle 2 receive loop (ldx $dd00 / sty $dd00 / eor table,x)', fixed: [0x0c00, 0x0e00] },
    ],
  },
  {
    id: 'krill', name: "Krill's loader (Krill/Plush)", how: '2-bit + ATN, the serial bus driven through $dd02 ($37 and $3f)',
    signs: [
      { pat: pat('1D C9 DC 8E 02 DD 6A 6A A2 3F 87|8F'), role: 'resident', what: 'receive loop (ora $dcc9,x / stx $dd02)' },
      { pat: pat('6D|7D 00|C9 DD|DC 8E 02 DD C8 F0 .. 4A 4A A2 3F'), role: 'resident', what: 'receive loop (adc $dd00 / stx $dd02 / iny)' },
    ],
    text: 'KRILL.',
  },
  {
    id: 'bitfire', name: 'Bitfire (Bitbreaker/Oxyron)', how: '2-bit + ATN, the serial bus driven through $dd02 ($3f)',
    signs: [
      { pat: pat('6D 00 DD 8E 02 DD 4A 4A 88 C0 01 A2 3F'), role: 'resident', what: 'receive loop (adc $dd00 / stx $dd02 / dey)' },
      { pat: pat('0D 00 DD 8E 02 DD 6A 6A A2 3F 8F'), role: 'resident', what: 'receive loop (ora $dd00 / stx $dd02)' },
      // an older Bitfire: lda $dcc9,y / sty $dd02 (Krill's loader indexes with x)
      { pat: pat('A0 37 B9 C9 DC 8C 02 DD 4A 4A'), role: 'resident', what: 'receive loop (lda $dcc9,y / sty $dd02)' },
    ],
  },
  {
    id: 'sparkle', name: 'Sparkle (Sparta/OMG)', how: '2-bit + ATN; the resident part lives at $0160 and $0200',
    signs: [
      // dex or inx, ora #$00 or #$01: the versions differ there
      { pat: pat('AD 00 DD 8C 00 DD 4A 4A CA|E8 EA A0 C0 0D 00 DD 8C 00 DD 4A 4A'), role: 'resident', what: 'receive loop (lda $dd00 / sty $dd00)' },
      { pat: pat('2D 00 DD 8D 00 DD 09 00|01 9D .. .. 50'), role: 'resident', what: 'receive loop (and $dd00 / sta $dd00 / sta buffer,x)' },
    ],
    text: 'SPARKLE',
  },
  {
    id: 'covert', name: 'Covert Bitops loader (Cadaver)', how: '2-bit, the C64 reads $dd00 four times per byte (lsr / lsr / eor $dd00)',
    signs: [
      // waits out badlines, then pulls CLK and reads with the classic loop (which older loaders use too)
      { pat: pat('AD 11 D0 18 ED 12 D0 29 07 F0 .. A9 10 0D 00 DD 8D 00 DD'), role: 'resident', what: 'receive loop (waits for no badline, then lda $dd00 / lsr / lsr / eor $dd00 …)' },
      { pat: pat('.. 04|05|06|07 .. 57 2D 4D'), role: 'command', what: 'drive command M-W, stored backwards (its installer sends it from the end)' },
    ],
  },
];
/** the classic 2-bit receive loop: the Covert Bitops loader's, and many older loaders' */
const CLASSIC = pat('AD 00 DD 4A 4A 4D 00 DD 4A 4A 4D 00 DD 4A 4A 4D 00 DD');

/** instructions that read or write an absolute address (the drive's VIA registers in drive code) */
const ABS_OPS = new Set([0xad, 0x8d, 0x2c, 0xae, 0x8e, 0xac, 0x8c, 0x0d, 0x2d, 0x4d, 0x6d, 0xcd, 0xec, 0xcc, 0xee, 0xce, 0x0e, 0x2e, 0x4e, 0x6e, 0xed]);
/** instructions that read $dd00 (indexed forms from $dcxx reach it too, as Krill's NTSC loop does) */
const READ_OPS = new Set([0xad, 0x0d, 0x2d, 0x4d, 0x6d, 0x2c, 0xcd, 0xae, 0xac]);
const READ_X_OPS = new Set([0x1d, 0x3d, 0x5d, 0x7d, 0xbd, 0x19, 0x39, 0x59, 0x79, 0xb9]);

const KERNAL_SERIAL: Record<number, string> = { 0xffb1: 'LISTEN', 0xff93: 'SECOND', 0xffa8: 'CIOUT', 0xffae: 'UNLSN', 0xffb4: 'TALK', 0xff96: 'TKSA', 0xffa5: 'ACPTR', 0xffab: 'UNTLK' };

/** the encodings a name can be written in: PETSCII upper case, PETSCII lower case (shifted), screen codes, ASCII */
const encodings = (s: string): Pattern[] => {
  const up = [...s.toUpperCase()].map(c => c.charCodeAt(0));
  const letter = (c: number) => c >= 0x41 && c <= 0x5a;
  return [up, up.map(c => (letter(c) ? c + 0x80 : c)), up.map(c => (letter(c) ? c - 0x40 : c)), up.map(c => (letter(c) ? c + 0x20 : c))].map(b => b.map(x => new Set([x])));
};

export function findLoaders(ctx: Ctx, blocks: Block[]): LoaderFinding[] {
  const { mem, owner, insLen, codeOwner, L } = ctx;
  const inCode = (a: Addr) => insLen[a] > 0 || codeOwner[a] >= 0;
  const find = (p: Pattern, from = 0, to = 0x10000): Addr[] => {
    const out: Addr[] = [], first = p[0];
    for (let a = from; a + p.length <= to; a++) {
      if ((first && !first.has(mem[a])) || owner[a] < 0) continue;
      let i = 1;
      for (; i < p.length; i++) { const s = p[i]; if (s && !s.has(mem[a + i])) break; }
      if (i === p.length && owner[a + p.length - 1] === owner[a]) out.push(a);
    }
    return out;
  };
  const blockAt = (a: Addr) => blocks.find(b => a >= b.start && a < b.end);
  /** a traced routine holds the match: the part is that code block */
  const around = (a: Addr, n: number): [Addr, Addr] => { const b = blockAt(a); return b && b.type === 'code' && b.end - b.start <= 0x400 && inCode(a) ? [b.start, b.end] : [a, a + n]; };

  const findings: LoaderFinding[] = [];
  const overlaps = (s: Addr, e: Addr) => findings.some(f => f.parts.some(p => p.start < e && p.end > s));

  // ---- the known loaders ----
  for (const k of KNOWN) {
    const parts: LoaderPart[] = [];
    for (const s of k.signs) {
      for (const a of find(s.pat)) {
        const [start, end] = s.page ? [a, Math.min(0x10000, a + 0x100)] : s.fixed && a >= s.fixed[0] && a < s.fixed[1] ? s.fixed : around(a, s.pat.length);
        if (parts.some(p => p.start < end && p.end > start)) continue;
        parts.push({ start, end, role: s.role, what: s.what });
      }
    }
    if (k.text) for (const e of encodings(k.text)) for (const a of find(e)) if (!inCode(a)) parts.push({ start: a, end: a + e.length, role: 'text', what: `its name, "${k.text.replace(/\.$/, '')}"` });
    // its name alone could be any text: it counts with its code, or (below) next to drive commands
    if (parts.length) findings.push({ id: k.id, name: k.name, sure: 'match', how: k.how, parts: parts.sort((x, y) => x.start - y.start) });
  }
  // ---- a snapshot opened from $0200: a known loader's code in the zero page or the stack, which it holds ----
  for (const f of ctx.files) {
    if (!f.vsf) continue;
    let ram: Uint8Array;
    try { ram = parseVsf(f.vsf).ram; } catch { continue; }
    for (const k of KNOWN) for (const s of k.signs) {
      if (s.page || s.fixed) continue;
      for (let a = 0; a + s.pat.length <= 0x200; a++) {
        if (!s.pat.every((x, i) => owner[a + i] < 0 && (!x || x.has(ram[a + i])))) continue;
        const part: LoaderPart = { start: a, end: a + s.pat.length, role: s.role, what: `${s.what}, in the ${a < 0x100 ? 'zero page' : 'stack'}, which this snapshot is opened without`, outside: true };
        const known = findings.find(x => x.id === k.id);
        if (known) known.parts.push(part);
        else findings.push({ id: k.id, name: k.name, sure: 'match', how: k.how, parts: [part] });
      }
    }
  }
  const named = (f: LoaderFinding) => f.parts.some(p => p.role !== 'text');

  // ---- what every disk loader has ----
  const generic: LoaderPart[] = [];
  // drive commands: "M-W" lo hi length, "M-E" lo hi, "M-R" lo hi length; some loaders send them backwards ("W-M")
  for (const [c, name] of [[0x57, 'M-W'], [0x45, 'M-E'], [0x52, 'M-R']] as const) {
    const plausible = (lo: number, hi: number) => hi <= 0x07 || hi >= 0xc0;
    for (const a of find([new Set([0x4d]), new Set([0x2d]), new Set([c])])) {
      if (inCode(a) || a + 5 > 0xffff || !plausible(mem[a + 3], mem[a + 4])) continue;
      const at = mem[a + 3] | (mem[a + 4] << 8), n = c === 0x45 ? 5 : 6;
      generic.push({ start: a, end: a + n, role: 'command', what: `drive command ${name} $${h(at)}${c === 0x45 ? ': starts the code there in the drive' : c === 0x57 ? `, ${mem[a + 5]} bytes into the drive` : ': reads the drive' + (at >= 0xc000 ? "'s ROM (which drive it is)" : "'s memory")}` });
    }
    for (const a of find([new Set([c]), new Set([0x2d]), new Set([0x4d])])) {
      if (inCode(a) || a < 3 || !plausible(mem[a - 1], mem[a - 2])) continue;
      const at = mem[a - 1] | (mem[a - 2] << 8);
      generic.push({ start: a - (c === 0x45 ? 2 : 3), end: a + 3, role: 'command', what: `drive command ${name} $${h(at)}, stored backwards (sent from its end)` });
    }
  }
  // 1541 code: the drive's VIA registers ($1800 serial port, $1c00 disk controller) and GCR reads (bvc * / lda $1c01)
  const hits: { a: Addr; w: number }[] = [];
  for (let a = 0; a + 2 < 0x10000; a++) {
    if (owner[a] < 0 || inCode(a)) continue;
    const op = mem[a], lo = mem[a + 1], hi = mem[a + 2];
    if (op === 0x50 && lo === 0xfe) hits.push({ a, w: 2 });
    else if (ABS_OPS.has(op) && (hi === 0x18 || hi === 0x1c) && lo <= 0x0f) hits.push({ a, w: hi === 0x1c && lo === 0x01 ? 2 : 1 });
  }
  for (let i = 0; i < hits.length;) {
    let j = i, w = hits[i].w;
    while (j + 1 < hits.length && hits[j + 1].a - hits[j].a <= 160) w += hits[++j].w;
    const vias = hits.slice(i, j + 1).filter(x => x.w === 1 || mem[x.a] !== 0x50).length;
    if (w >= 5 && vias >= 3) {
      let start = hits[i].a, end = hits[j].a + 3;
      const b = blockAt(start);
      if (b && b.type !== 'code' && start - b.start <= 0x200) start = b.start;
      const e = blockAt(end - 1);
      if (e && e.type !== 'code' && e.end - end <= 0x200) end = e.end;
      generic.push({ start, end, role: 'drivecode', what: 'code for the 1541: it is uploaded to the drive and runs there (VIA registers $1800 and $1c00, GCR bytes from $1c01)' });
    }
    i = j + 1;
  }
  // the receive loop: $dd00 read at least four times within 48 bytes
  const reads: Addr[] = [];
  for (let a = 0; a + 2 < 0x10000; a++) {
    if (owner[a] < 0) continue;
    const op = mem[a], lo = mem[a + 1], hi = mem[a + 2];
    if ((READ_OPS.has(op) && lo === 0x00 && hi === 0xdd) || (READ_X_OPS.has(op) && hi === 0xdc && lo >= 0xc0)) reads.push(a);
  }
  for (let i = 0; i < reads.length;) {
    let j = i;
    while (j + 1 < reads.length && reads[j + 1] - reads[i] <= 48) j++;
    if (j - i >= 3) {
      const [start, end] = around(reads[i], reads[j] + 3 - reads[i]);
      const span = mem.subarray(start, end);
      const atn = find(pat('8C|8D|8E 02 DD'), start, end).length > 0;
      const twoBit = [...span.keys()].some(k => (span[k] === 0x4a && span[k + 1] === 0x4a) || (span[k] === 0x6a && span[k + 1] === 0x6a));
      const classic = find(CLASSIC, start, end).length > 0;
      generic.push({ start, end, role: 'resident', what: classic ? 'receive loop: the classic 2-bit loop (lda $dd00 / lsr / lsr / eor $dd00 …), as in the Covert Bitops loader and many older loaders' : `receive loop: reads the serial bus at $dd00 ${j - i + 1} times (${atn ? '2-bit + ATN through $dd02' : twoBit ? '2-bit' : '1-bit'})` });
      i = j + 1;
    } else i++;
  }
  // a name next to a drive command (Krill's installer sends "M-E" lo hi "KRILL.") is enough
  for (let i = findings.length - 1; i >= 0; i--) {
    const f = findings[i];
    if (named(f)) continue;
    if (f.parts.some(t => generic.some(c => c.role === 'command' && c.end <= t.start + 1 && t.start - c.end <= 8))) continue;
    findings.splice(i, 1);
  }
  const evidence = generic.filter(p => !overlaps(p.start, p.end));
  // the KERNAL's serial bus calls send the drive code and the commands (only counted when there is a loader to send)
  if (evidence.length || findings.length) {
    const calls = new Map<Addr, string[]>();
    for (let a = 0; a + 2 < 0x10000; a++) {
      if (insLen[a] !== 3 || mem[a] !== 0x20) continue;
      const name = KERNAL_SERIAL[mem[a + 1] | (mem[a + 2] << 8)];
      if (!name) continue;
      const [s] = around(a, 3);
      calls.set(s, [...new Set([...(calls.get(s) ?? []), name])]);
    }
    const all = [...new Set([...calls.values()].flat())];
    for (const s of calls.keys()) { const [start, end] = around(s, 3); evidence.push({ start, end, role: 'install', what: `talks to the drive through the KERNAL (${all.join(', ')}): sends the drive code and its commands` }); }
  }
  if (evidence.length) {
    // one known loader: these are its parts; otherwise they are a loader of their own
    const known = findings.length === 1 ? findings[0] : null;
    const keep = evidence.filter(p => !(known && p.role === 'resident' && known.parts.some(q => q.role === 'resident')));
    if (known) known.parts.push(...keep.filter(p => !known.parts.some(q => q.start < p.end && q.end > p.start)));
    else if (keep.some(p => p.role === 'drivecode' || p.role === 'resident' || p.role === 'command')) {
      const how = keep.find(p => p.role === 'resident')?.what.replace(/^receive loop: /, '') ?? 'its own code in the drive';
      findings.push({ id: 'fastloader', name: 'A fast loader (not one of the known ones)', sure: 'likely', how, parts: keep });
    }
  }
  for (const f of findings) f.parts = merged(f.parts);

  // ---- tape: CIA1's FLAG line (the datasette's read line) and a timer to measure the pulses ----
  const flag = [...find(pat('AD 0D DC 29 10')), ...find(pat('A9 10 2C 0D DC')), ...find(pat('A9 90 8D 0D DC'))].filter(inCode);
  const timers = [...find(pat('AD|AE|AC 04|05|06|07 DC')), ...find(pat('8D|8E|8C 0E|0F DC'))].filter(inCode);
  const tape = flag.filter(a => timers.some(t => Math.abs(t - a) <= 256));
  if (tape.length) {
    const parts: LoaderPart[] = [];
    for (const a of tape) { const [start, end] = around(a, 5); if (!parts.some(p => p.start === start)) parts.push({ start, end, role: 'tape', what: 'tape turbo: waits for pulses on the FLAG line ($dc0d bit 4) and times them with a CIA timer' }); }
    findings.push({ id: 'tape', name: 'A tape turbo loader', sure: 'likely', how: 'reads the datasette through CIA1’s FLAG line and measures the pulses with a timer', parts });
  }

  // ---- the KERNAL's LOAD ----
  const loads: LoaderPart[] = [];
  for (let a = 0; a + 2 < 0x10000; a++) if (insLen[a] === 3 && mem[a] === 0x20 && mem[a + 1] === 0xd5 && mem[a + 2] === 0xff) loads.push({ start: a, end: a + 3, role: 'kernal', what: 'loads a file with the KERNAL (jsr LOAD, $ffd5)' });
  if (loads.length) findings.push({ id: 'kernal', name: 'KERNAL LOAD', sure: 'match', how: 'the standard load through $ffd5 (slow, or as fast as a cartridge or JiffyDOS makes it)', parts: loads });

  for (const f of findings) {
    const where = f.parts.filter(p => p.role !== 'text').slice(0, 4).map(p => `${p.role === 'drivecode' ? 'drive code' : p.role === 'command' ? 'drive command' : p.role} ${$4(p.start)}${p.outside ? ' (not opened: Settings → Analysis → include the zero page and the stack)' : ''}`).join(', ');
    L(f.id === 'kernal' ? 'info' : 'ok', `Loader: ${f.name}${f.sure === 'likely' ? ' (by its traits)' : ''}: ${f.how}; ${where}${f.parts.length > 4 ? ', …' : ''}`, f.parts[0]?.start ?? null, 'loader');
  }
  return findings;
}

const h = (a: Addr) => a.toString(16).padStart(4, '0');

/** parts in address order; parts of the same kind that overlap (or code a few bytes apart) become one */
function merged(parts: LoaderPart[]): LoaderPart[] {
  const out: LoaderPart[] = [];
  for (const p of [...parts].sort((x, y) => x.start - y.start || y.end - x.end)) {
    const gap = p.role === 'resident' ? 32 : p.role === 'command' || p.role === 'text' || p.role === 'kernal' ? -1 : 0;
    const q = [...out].reverse().find(x => x.role === p.role && !x.outside === !p.outside);
    if (q && p.start <= q.end + gap) { q.end = Math.max(q.end, p.end); continue; }
    out.push({ ...p });
  }
  return out;
}
