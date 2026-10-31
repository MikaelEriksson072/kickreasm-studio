/* A small two-pass 6502 assembler for the Kick Assembler subset Brokkr's decrunchers are written in, so they are
 * assembled at the addresses each file needs and the same sources assemble in Kick Assembler:
 *  - `// comments`, `label:`, `* = address`, `.const` and `.label NAME = value`;
 *  - `.byte`, `.word`, `.fill count, value`;
 *  - `.if (condition) {` ... `} else {` ... `}`, blocks nested;
 *  - the documented opcodes in every addressing mode (zero page when the address is known and below $100);
 *  - expressions with numbers ($hex, %binary, decimal), labels, `*`, ( ), unary - < > !, the operators
 *    * / + - << >> < > <= >= == != & ^ | && || and ? :.
 * An error names the line and what is wrong with it. */
import { OPCODES, isDocumented, type Mode } from './opcodes.ts';

const OPS = new Map<string, number>();
for (let op = 0; op < 256; op++) {
  if (!isDocumented(op)) continue;
  OPS.set(`${OPCODES[op].name.toLowerCase()} ${OPCODES[op].mode}`, op);
}
const MNEMONICS = new Set([...OPS.keys()].map(k => k.split(' ')[0]));
const BRANCHES = new Set(['bpl', 'bmi', 'bvc', 'bvs', 'bcc', 'bcs', 'bne', 'beq']);

export class AsmError extends Error {
  readonly line: number;
  constructor(line: number, message: string) { super(`line ${line}: ${message}`); this.line = line; }
}

export interface Assembled {
  /** the bytes from `start` to `end` (exclusive), gaps zero */
  bytes: Uint8Array;
  start: number;
  end: number;
  labels: Record<string, number>;
}

type Value = number | null;

/** Evaluate an expression; null when it names a label not known yet. */
function evaluate(src: string, symbols: Map<string, number>, pc: number, line: number): Value {
  let i = 0;
  const fail = (msg: string): never => { throw new AsmError(line, `${msg} in "${src.trim()}"`); };
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const peek = (s: string) => { ws(); return src.startsWith(s, i); };
  const eat = (s: string) => { if (peek(s)) { i += s.length; return true; } return false; };
  const lift = (a: Value, b: Value, f: (x: number, y: number) => number): Value => (a == null || b == null ? null : f(a, b));

  const primary = (): Value => {
    ws();
    if (eat('(')) { const v = ternary(); if (!eat(')')) fail('a missing )'); return v; }
    if (eat('-')) { const v = primary(); return v == null ? null : -v; }
    if (eat('!')) { const v = primary(); return v == null ? null : v ? 0 : 1; }
    if (eat('<')) { const v = additive(); return v == null ? null : v & 0xff; }
    if (eat('>')) { const v = additive(); return v == null ? null : (v >> 8) & 0xff; }
    const m = /^(\$[0-9a-f]+|%[01]+|\d+|[a-z_][\w.]*|\*)/i.exec(src.slice(i));
    if (!m) fail('a value is missing');
    i += m![1].length;
    const t = m![1];
    if (t === '*') return pc;
    if (t[0] === '$') return parseInt(t.slice(1), 16);
    if (t[0] === '%') return parseInt(t.slice(1), 2);
    if (/^\d/.test(t)) return Number(t);
    return symbols.get(t) ?? null;
  };
  const binary = (next: () => Value, ops: [string, (a: number, b: number) => number][]) => (): Value => {
    let v = next();
    for (;;) {
      const op = ops.find(([s]) => peek(s) && !(s === '<' && (peek('<<') || peek('<='))) && !(s === '>' && (peek('>>') || peek('>=')))
        && !(s === '&' && peek('&&')) && !(s === '|' && peek('||')));
      if (!op) return v;
      i += op[0].length;
      v = lift(v, next(), op[1]);
    }
  };
  const multiplicative = binary(primary, [['*', (a, b) => a * b], ['/', (a, b) => Math.trunc(a / b)]]);
  const additive: () => Value = binary(multiplicative, [['+', (a, b) => a + b], ['-', (a, b) => a - b]]);
  const shift = binary(additive, [['<<', (a, b) => a << b], ['>>', (a, b) => a >> b]]);
  const relational = binary(shift, [['<=', (a, b) => +(a <= b)], ['>=', (a, b) => +(a >= b)], ['<', (a, b) => +(a < b)], ['>', (a, b) => +(a > b)]]);
  const equality = binary(relational, [['==', (a, b) => +(a === b)], ['!=', (a, b) => +(a !== b)]]);
  const and = binary(equality, [['&', (a, b) => a & b]]);
  const xor = binary(and, [['^', (a, b) => a ^ b]]);
  const or = binary(xor, [['|', (a, b) => a | b]]);
  const land = binary(or, [['&&', (a, b) => +(!!a && !!b)]]);
  const lor = binary(land, [['||', (a, b) => +(!!a || !!b)]]);
  function ternary(): Value {
    const c = lor();
    if (!eat('?')) return c;
    const a = ternary();
    if (!eat(':')) fail('a ? without its :');
    const b = ternary();
    return c == null ? null : c ? a : b;
  }
  const v = ternary();
  ws();
  if (i < src.length) fail(`"${src.slice(i)}" is not understood`);
  return v;
}

/** Split operands at top-level commas (not inside parentheses). */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim() || out.length) out.push(cur);
  return out.map(x => x.trim());
}

export function assemble(source: string, defines: Record<string, number> = {}): Assembled {
  // one statement a line: the braces of .if and else blocks on lines of their own (the source's line numbers kept)
  const lines: string[] = [], at: number[] = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    for (const part of raw.replace(/\/\/.*$/, '').replace(/\{/g, '{\n').replace(/\}/g, '\n}\n').split('\n')) {
      if (part.trim()) { lines.push(part.trim()); at.push(i + 1); }
    }
  });
  const symbols = new Map<string, number>(Object.entries(defines));
  // zero page or absolute, decided in the first pass for each line
  const wide = new Map<number, boolean>();
  let mem = new Map<number, number>();
  let lo = Infinity, hi = -Infinity;

  for (const pass of [1, 2]) {
    mem = new Map();
    lo = Infinity; hi = -Infinity;
    let pc = 0;
    // the .if blocks open around the line: whether each is taken, and whether its else is
    const blocks: { on: boolean; taken: boolean }[] = [];
    const active = () => blocks.every(b => b.on);
    const emit = (line: number, ...bs: number[]) => {
      for (const b of bs) {
        if (pc > 0xffff) throw new AsmError(line, 'the code goes past $ffff');
        mem.set(pc, b & 0xff); lo = Math.min(lo, pc); hi = Math.max(hi, pc + 1); pc++;
      }
    };
    const value = (expr: string, line: number, must = pass === 2): number => {
      const v = evaluate(expr, symbols, pc, line);
      if (v == null) { if (must) throw new AsmError(line, `"${expr.trim()}" names a label that is not defined`); return 0; }
      return v;
    };

    let closed: { on: boolean; taken: boolean } | null = null;
    for (let li = 0; li < lines.length; li++) {
      const no = at[li];
      let text = lines[li];
      // the blocks: } closes the open .if or else, else { follows a }, .if (condition) { opens one
      if (text === '}') {
        closed = blocks.pop() ?? null;
        if (!closed) throw new AsmError(no, 'a } with no .if open');
        continue;
      }
      if (/^else\s*\{$/.test(text)) {
        if (!closed) throw new AsmError(no, 'an else that does not follow the } of an .if');
        blocks.push({ on: !closed.taken && active(), taken: true });
        closed = null;
        continue;
      }
      closed = null;
      const cond = /^\.if\s*\((.*)\)\s*\{$/.exec(text);
      if (cond) {
        const on = active() && !!value(cond[1], no, true);
        blocks.push({ on, taken: on });
        continue;
      }
      if (!active()) continue;

      const label = /^([a-z_]\w*):\s*(.*)$/i.exec(text);
      if (label) {
        if (pass === 1 && symbols.has(label[1]) && !(label[1] in defines)) throw new AsmError(no, `the label ${label[1]} is defined twice`);
        symbols.set(label[1], pc);
        text = label[2].trim();
        if (!text) continue;
      }
      const assign = /^\.(const|label|var)\s+([a-z_]\w*)\s*=\s*(.+)$/i.exec(text);
      if (assign) {
        if (assign[2] in defines) continue;
        const v = evaluate(assign[3], symbols, pc, no);
        if (v == null) { if (pass === 2) throw new AsmError(no, `"${assign[3]}" names a label that is not defined`); continue; }
        symbols.set(assign[2], v);
        continue;
      }
      const org = /^\*\s*=\s*(.+)$/.exec(text);
      if (org) { pc = value(org[1], no, true); continue; }
      const dir = /^\.(\w+)\s*(.*)$/.exec(text);
      if (dir) {
        const [, d, arg] = dir;
        const items = splitArgs(arg);
        if (d === 'byte' || d === 'by') for (const it of items) emit(no, value(it, no));
        else if (d === 'word' || d === 'wo') for (const it of items) { const v = value(it, no); emit(no, v, v >> 8); }
        else if (d === 'fill') { const n = value(items[0], no, true); const v = items[1] ? value(items[1], no) : 0; for (let k = 0; k < n; k++) emit(no, v); }
        else if (d === 'error') throw new AsmError(no, arg.replace(/^"|"$/g, ''));
        else throw new AsmError(no, `.${d} is not a directive this assembler knows`);
        continue;
      }

      const ins = /^([a-z]{3})\b\s*(.*)$/i.exec(text);
      if (!ins || !MNEMONICS.has(ins[1].toLowerCase())) throw new AsmError(no, `"${text}" is not an instruction`);
      const name = ins[1].toLowerCase(), arg = ins[2].trim();
      const op = (mode: Mode) => OPS.get(`${name} ${mode}`);
      const put = (mode: Mode, v?: number) => {
        const code = op(mode);
        if (code == null) throw new AsmError(no, `${name} has no ${mode} addressing mode`);
        if (mode === 'imp' || mode === 'acc') emit(no, code);
        else if (mode === 'abs' || mode === 'abx' || mode === 'aby' || mode === 'ind') emit(no, code, v!, v! >> 8);
        else emit(no, code, v!);
      };
      if (!arg) { put(op('acc') != null ? 'acc' : 'imp'); continue; }
      if (arg[0] === '#') { const v = value(arg.slice(1), no); if (pass === 2 && (v < -128 || v > 255)) throw new AsmError(no, `#${v} does not fit a byte`); put('imm', v); continue; }
      if (BRANCHES.has(name)) {
        const target = value(arg, no);
        const rel = target - (pc + 2);
        if (pass === 2 && (rel < -128 || rel > 127)) throw new AsmError(no, `the branch to $${target.toString(16)} is ${rel} bytes away, more than a branch reaches`);
        put('rel', rel);
        continue;
      }
      let m: RegExpExecArray | null;
      if ((m = /^\((.+)\)\s*,\s*y$/i.exec(arg))) { put('izy', value(m[1], no)); continue; }
      if ((m = /^\((.+),\s*x\)$/i.exec(arg))) { put('izx', value(m[1], no)); continue; }
      if ((m = /^\((.+)\)$/.exec(arg)) && name === 'jmp') { put('ind', value(m[1], no)); continue; }
      let index: 'x' | 'y' | null = null, expr = arg;
      if ((m = /^(.+),\s*([xy])$/i.exec(arg))) { expr = m[1]; index = m[2].toLowerCase() as 'x' | 'y'; }
      const known = evaluate(expr, symbols, pc, no);
      const zpMode: Mode = index === 'x' ? 'zpx' : index === 'y' ? 'zpy' : 'zp';
      const absMode: Mode = index === 'x' ? 'abx' : index === 'y' ? 'aby' : 'abs';
      if (pass === 1) wide.set(li, !(known != null && known >= 0 && known < 0x100 && op(zpMode) != null));
      const v = value(expr, no);
      if (wide.get(li)) put(absMode, v); else put(zpMode, v);
    }
    if (blocks.length) throw new AsmError(at[at.length - 1] ?? 0, 'an .if block is not closed with }');
  }
  if (lo === Infinity) return { bytes: new Uint8Array(0), start: 0, end: 0, labels: Object.fromEntries(symbols) };
  const bytes = new Uint8Array(hi - lo);
  for (const [a, b] of mem) bytes[a - lo] = b;
  return { bytes, start: lo, end: hi, labels: Object.fromEntries(symbols) };
}
