/* BASIC V2 programs in memory: the lines, a listing, and the statements a packer's start line uses (SYS, POKE),
 * with a small evaluator for their numeric expressions. */

const TOKENS = [
  'END', 'FOR', 'NEXT', 'DATA', 'INPUT#', 'INPUT', 'DIM', 'READ', 'LET', 'GOTO', 'RUN', 'IF', 'RESTORE', 'GOSUB',
  'RETURN', 'REM', 'STOP', 'ON', 'WAIT', 'LOAD', 'SAVE', 'VERIFY', 'DEF', 'POKE', 'PRINT#', 'PRINT', 'CONT', 'LIST',
  'CLR', 'CMD', 'SYS', 'OPEN', 'CLOSE', 'GET', 'NEW', 'TAB(', 'TO', 'FN', 'SPC(', 'THEN', 'NOT', 'STEP', '+', '-',
  '*', '/', '^', 'AND', 'OR', '>', '=', '<', 'SGN', 'INT', 'ABS', 'USR', 'FRE', 'POS', 'SQR', 'RND', 'LOG', 'EXP',
  'COS', 'SIN', 'TAN', 'ATN', 'PEEK', 'LEN', 'STR$', 'VAL', 'ASC', 'CHR$', 'LEFT$', 'RIGHT$', 'MID$', 'GO',
];
export const T = { END: 0x80, REM: 0x8f, STOP: 0x90, POKE: 0x97, PRINT: 0x99, CLR: 0x9c, SYS: 0x9e, NEW: 0xa2, PLUS: 0xaa, MINUS: 0xab, TIMES: 0xac, DIVIDE: 0xad, PEEK: 0xc2 } as const;

export interface BasicLine { addr: number; next: number; number: number; bytes: number[] }

/** The lines of the program at `start`, following the links (at most `max`, stopping at a bad link). */
export function basicLines(peek: (a: number) => number, start = 0x0801, max = 64): BasicLine[] {
  const lines: BasicLine[] = [];
  let a = start;
  while (lines.length < max) {
    const next = peek(a) | (peek(a + 1) << 8);
    if (next === 0 || next <= a || next > 0xffff) break;
    const number = peek(a + 2) | (peek(a + 3) << 8);
    const bytes: number[] = [];
    for (let p = a + 4; p < next && p < 0x10000; p++) {
      const b = peek(p);
      if (b === 0) break;
      bytes.push(b);
    }
    lines.push({ addr: a, next, number, bytes });
    a = next;
  }
  return lines;
}

const petsciiChar = (b: number): string => {
  if (b >= 0x20 && b < 0x5b) return String.fromCharCode(b);
  if (b === 0x5c) return '£';
  if (b >= 0x5b && b < 0x60) return '[]^_'.charAt(b - 0x5b) || '?';
  if (b >= 0xc1 && b <= 0xda) return String.fromCharCode(b - 0x80);
  return `{${b.toString(16).padStart(2, '0')}}`;
};

/** A line as BASIC lists it (control codes in braces). */
export function listLine(line: BasicLine): string {
  let s = `${line.number} `, quoted = false;
  for (const b of line.bytes) {
    if (b === 0x22) quoted = !quoted;
    s += !quoted && b >= 0x80 && b < 0x80 + TOKENS.length ? TOKENS[b - 0x80] : b === 0xff && !quoted ? 'π' : petsciiChar(b);
  }
  return s;
}

/** The statements of a line, split at colons outside quotes. */
export function statements(bytes: number[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [], quoted = false;
  for (const b of bytes) {
    if (b === 0x22) quoted = !quoted;
    if (b === 0x3a && !quoted) { out.push(cur); cur = []; continue; }
    if (b === T.REM && !quoted) { cur.push(b); out.push(cur); return out; }
    cur.push(b);
  }
  out.push(cur);
  return out;
}

/** Evaluate a numeric expression (numbers, + - * /, brackets, PEEK); null if it holds anything else. */
export function evaluate(bytes: number[], peek: (a: number) => number): { value: number; rest: number[] } | null {
  let i = 0;
  const skip = () => { while (bytes[i] === 0x20) i++; };
  const primary = (): number | null => {
    skip();
    const b = bytes[i];
    if (b === T.MINUS) { i++; const v = primary(); return v == null ? null : -v; }
    if (b === T.PLUS) { i++; return primary(); }
    if (b === 0x28) { i++; const v = sum(); skip(); if (v == null || bytes[i] !== 0x29) return null; i++; return v; }
    if (b === T.PEEK) {
      i++; skip();
      if (bytes[i] !== 0x28) return null;
      i++;
      const v = sum(); skip();
      if (v == null || bytes[i] !== 0x29) return null;
      i++;
      return peek(Math.trunc(v) & 0xffff);
    }
    let text = '';
    while (i < bytes.length && ((bytes[i] >= 0x30 && bytes[i] <= 0x39) || bytes[i] === 0x2e || bytes[i] === 0x20)) {
      if (bytes[i] !== 0x20) text += String.fromCharCode(bytes[i]);
      i++;
    }
    return text && !Number.isNaN(Number(text)) ? Number(text) : null;
  };
  const product = (): number | null => {
    let v = primary();
    for (;;) {
      skip();
      if (v == null || (bytes[i] !== T.TIMES && bytes[i] !== T.DIVIDE)) return v;
      const op = bytes[i++], r = primary();
      if (r == null) return null;
      v = op === T.TIMES ? v * r : v / r;
    }
  };
  const sum = (): number | null => {
    let v = product();
    for (;;) {
      skip();
      if (v == null || (bytes[i] !== T.PLUS && bytes[i] !== T.MINUS)) return v;
      const op = bytes[i++], r = product();
      if (r == null) return null;
      v = op === T.PLUS ? v + r : v - r;
    }
  };
  const value = sum();
  return value == null ? null : { value, rest: bytes.slice(i) };
}

/** The address of the first SYS in the program, when its expression is plain enough to evaluate. */
export function findSys(peek: (a: number) => number, start = 0x0801): number | null {
  for (const line of basicLines(peek, start, 8)) {
    for (const st of statements(line.bytes)) {
      const k = st.findIndex(b => b !== 0x20);
      if (st[k] === T.SYS) {
        const r = evaluate(st.slice(k + 1), peek);
        return r && r.value >= 0 && r.value <= 0xffff ? Math.trunc(r.value) : null;
      }
    }
  }
  return null;
}
