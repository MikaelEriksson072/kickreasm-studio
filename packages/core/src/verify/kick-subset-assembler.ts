/* =====================================================================
 * Assembles exactly the Kick Assembler subset that the generator emits
 * (#import, #define/#if/#else/#endif, .pc/*=, .label/.const/.var, .byte/.word/.text/.encoding,
 * .fill with expressions, .import binary, LoadSid, BasicUpstart2, every
 * addressing mode, .abs/.zp, multi-pass resolution). The desktop app and
 * the CLI can additionally run the real KickAss.jar.
 * ===================================================================== */
import type { AsmBlock, AsmError, AssembleResult, Vfs } from '../types';
import { BRANCHES, ENC, MODE_LEN, type AddrMode } from '../cpu/opcodes';
import { parsePsid } from '../c64/psid';
import { h4 } from '../util/hex';

interface Stmt { file: string; line: number; src?: string; label?: string; body: string }

type Tok = { t: 'n'; v: number } | { t: 's'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };
type Node =
  | { k: 'n'; v: number } | { k: 's'; v: string } | { k: 'pc' }
  | { k: 'id'; v: string } | { k: 'mem'; o: Node; v: string } | { k: 'call'; f: Node; args: Node[] }
  | { k: 'u'; op: string; a: Node } | { k: 'b'; op: string; a: Node; b: Node };
// The expression evaluator is dynamically typed: numbers, strings, functions and LoadSid objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Value = any;

const BIN: Record<string, number> = { '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6 };

// As measured with KickAss 5.25: the mapped characters below, every other character is its ASCII code
// (lower case in the *_upper tables too, and \ ^ _ ` { | } ~ everywhere).
const ENCODINGS: Record<string, (c: string) => number> = {
  screencode_upper: c => { const k = c.charCodeAt(0); if (c === '@') return 0; if (k >= 65 && k <= 90) return k - 64; if (c === '[') return 0x1b; if (c === ']') return 0x1d; return k; },
  screencode_mixed: c => { const k = c.charCodeAt(0); if (c === '@') return 0; if (k >= 97 && k <= 122) return k - 96; if (c === '[') return 0x1b; if (c === ']') return 0x1d; return k; },
  petscii_upper: c => c.charCodeAt(0),
  petscii_mixed: c => { const k = c.charCodeAt(0); if (k >= 97 && k <= 122) return k - 32; if (k >= 65 && k <= 90) return k + 0x80; return k; },
};

const IMPLIED_ACC = new Set(['ASL', 'LSR', 'ROL', 'ROR']);

export function assemble(vfs: Vfs, entryPath: string): AssembleResult {
  const errors: AsmError[] = [];
  const E = (msg: string, st?: Stmt) => errors.push({ msg, file: st ? st.file : entryPath, line: st ? st.line : 0 });
  const stmts: Stmt[] = [];
  // preprocessor: #define/#undef and #if/#elif/#else/#endif over defined symbols (!, &&, ||, parentheses)
  const defines = new Set<string>();
  const cond: { active: boolean; taken: boolean; outer: boolean }[] = [];
  const on = () => cond.every(c => c.active);
  const test = (src: string): boolean => {
    const t = src.match(/[A-Za-z_]\w*|&&|\|\||[!()]/g) || [];
    let i = 0;
    const not = (): boolean => {
      if (t[i] === '!') { i++; return !not(); }
      if (t[i] === '(') { i++; const v = or(); if (t[i] === ')') i++; return v; }
      const id = t[i++] ?? '';
      return id === 'true' || (id !== 'false' && defines.has(id));
    };
    const and = (): boolean => { let v = not(); while (t[i] === '&&') { i++; const r = not(); v = v && r; } return v; };
    const or = (): boolean => { let v = and(); while (t[i] === '||') { i++; const r = and(); v = v || r; } return v; };
    return or();
  };
  const loadFile = (path: string, depth: number) => {
    const src = vfs[path];
    if (typeof src !== 'string') { E(`Can't open file "${path}"`); return; }
    if (depth > 16) { E(`#import nested too deep at "${path}"`); return; }
    let inBlock = false;
    src.split(/\r?\n/).forEach((raw, i) => {
      let s = '', q = false;
      for (let k = 0; k < raw.length; k++) {
        const c = raw[k], c2 = raw[k + 1];
        if (inBlock) { if (c === '*' && c2 === '/') { inBlock = false; k++; } continue; }
        if (c === '"') q = !q;
        if (!q && c === '/' && c2 === '/') break;
        if (!q && c === '/' && c2 === '*') { inBlock = true; k++; continue; }
        s += c;
      }
      s = s.trim();
      if (!s) return;
      const pp = s.match(/^#(define|undef|if|elif|else|endif)\b\s*(.*)$/);
      if (pp) {
        const top = cond[cond.length - 1], at: Stmt = { file: path, line: i + 1, src: s, body: '' };
        switch (pp[1]) {
          case 'if': { const outer = on(), v = outer && test(pp[2]); cond.push({ active: v, taken: v, outer }); break; }
          case 'elif': if (!top) E('#elif without #if', at); else { const v = top.outer && !top.taken && test(pp[2]); top.active = v; top.taken ||= v; } break;
          case 'else': if (!top) E('#else without #if', at); else { top.active = top.outer && !top.taken; top.taken = true; } break;
          case 'endif': if (!cond.pop()) E('#endif without #if', at); break;
          default: if (on()) { const name = pp[2].trim().split(/\s+/)[0]; if (pp[1] === 'define') defines.add(name); else defines.delete(name); }
        }
        return;
      }
      if (!on()) return;
      const st: Stmt = { file: path, line: i + 1, src: s, body: '' };
      const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:(?!:)\s*(.*)$/);
      if (m && !/^[A-Za-z_]\w*\s*:\s*=/.test(s)) { st.label = m[1]; s = m[2]; }
      st.body = s;
      const imp = s.match(/^#import\s+"([^"]+)"/);
      if (imp) { if (st.label) stmts.push({ file: path, line: i + 1, label: st.label, body: '' }); loadFile(imp[1], depth + 1); return; }
      stmts.push(st);
    });
  };
  loadFile(entryPath, 0);
  if (cond.length) E(`#if without #endif (${cond.length} open)`);

  // ---- expressions ----
  const tokenize = (s: string): Tok[] => {
    const out: Tok[] = []; let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '$') { const m = s.slice(i + 1).match(/^[0-9a-fA-F]+/); if (!m) throw new Error(`bad hex number in "${s}"`); out.push({ t: 'n', v: parseInt(m[0], 16) }); i += 1 + m[0].length; continue; }
      if (c === '%') { const m = s.slice(i + 1).match(/^[01]+/); if (m) { out.push({ t: 'n', v: parseInt(m[0], 2) }); i += 1 + m[0].length; continue; } }
      if (/[0-9]/.test(c)) { const m = s.slice(i).match(/^[0-9]+/)!; out.push({ t: 'n', v: parseInt(m[0], 10) }); i += m[0].length; continue; }
      if (/[A-Za-z_]/.test(c)) { const m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)!; out.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
      if (c === '"') { const j = s.indexOf('"', i + 1); if (j < 0) throw new Error('unterminated string'); out.push({ t: 's', v: s.slice(i + 1, j) }); i = j + 1; continue; }
      if (s.startsWith('<<', i) || s.startsWith('>>', i)) { out.push({ t: 'op', v: s.slice(i, i + 2) }); i += 2; continue; }
      if ('+-*/&|^<>(),.'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
      throw new Error(`unexpected "${c}" in expression "${s}"`);
    }
    return out;
  };
  const parseExpr = (s: string): Node => {
    const tk = tokenize(s); let p = 0;
    const peek = (): Tok | undefined => tk[p], next = (): Tok | undefined => tk[p++];
    const primary = (): Node => {
      const t = next();
      if (!t) throw new Error(`incomplete expression "${s}"`);
      if (t.t === 'n') return { k: 'n', v: t.v };
      if (t.t === 's') return { k: 's', v: t.v };
      if (t.t === 'op' && t.v === '*') return { k: 'pc' };
      if (t.t === 'op' && t.v === '(') { const e = expr(0); const c = next(); if (!c || c.v !== ')') throw new Error(`missing ) in "${s}"`); return e; }
      if (t.t === 'op' && (t.v === '<' || t.v === '>' || t.v === '-')) return { k: 'u', op: t.v, a: unary() };
      if (t.t === 'id') {
        let node: Node = { k: 'id', v: t.v };
        for (;;) {
          const q = peek();
          if (q && q.t === 'op' && q.v === '.') { next(); const id = next(); if (!id || id.t !== 'id') throw new Error(`bad member access in "${s}"`); node = { k: 'mem', o: node, v: id.v }; continue; }
          if (q && q.t === 'op' && q.v === '(') {
            next(); const args: Node[] = [];
            if (!(peek() && peek()!.v === ')')) { for (;;) { args.push(expr(0)); const c = next(); if (c && c.v === ')') break; if (!c || c.v !== ',') throw new Error(`bad argument list in "${s}"`); } } else next();
            node = { k: 'call', f: node, args }; continue;
          }
          break;
        }
        return node;
      }
      throw new Error(`unexpected "${t.v}" in "${s}"`);
    };
    const unary = (): Node => primary();
    const expr = (minP: number): Node => {
      let left = unary();
      for (;;) {
        const t = peek();
        if (!t || t.t !== 'op' || !BIN[t.v] || BIN[t.v] <= minP - 1 || BIN[t.v] < minP) break;
        next(); const right = expr(BIN[t.v] + 1); left = { k: 'b', op: t.v, a: left, b: right };
      }
      return left;
    };
    const e = expr(0);
    if (p < tk.length) throw new Error(`unexpected "${tk[p].v}" in "${s}"`);
    return e;
  };
  const cache = new Map<string, Node>();
  const P = (s: string): Node => { if (!cache.has(s)) cache.set(s, parseExpr(s)); return cache.get(s)!; };

  const syms = new Map<string, Value>();
  let pc = 0, pass: number | 'final' = 0, unresolved: string[] = [];
  const builtins: Record<string, Value> = {
    toIntString: (v: number) => String(v),
    LoadSid: (path: string) => { const u = vfs[path]; if (!(u instanceof Uint8Array)) throw new Error(`LoadSid: can't open "${path}"`); const sid = parsePsid(u); return Object.assign({}, sid, { getData: (i: number) => sid.data[i] }); },
  };
  const ev = (node: Node, env?: Record<string, Value>): Value => {
    switch (node.k) {
      case 'n': return node.v;
      case 's': return node.v;
      case 'pc': return pc;
      case 'id': {
        if (env && node.v in env) return env[node.v];
        if (syms.has(node.v)) return syms.get(node.v);
        if (builtins[node.v]) return builtins[node.v];
        unresolved.push(node.v); return null;
      }
      case 'mem': { const o = ev(node.o, env); if (o == null) return null; const v = o[node.v]; if (v === undefined) throw new Error(`unknown member .${node.v}`); return v; }
      case 'call': {
        if (node.f.k === 'mem') { const o = ev(node.f.o, env); if (o == null) return null; const fn = o[node.f.v]; const args = node.args.map(a => ev(a, env)); if (args.some(a => a == null)) return null; return fn(...args); }
        const fn = ev(node.f, env); const args = node.args.map(a => ev(a, env));
        if (fn == null || args.some(a => a == null)) return null; return fn(...args);
      }
      case 'u': { const v = ev(node.a, env); if (v == null) return null; return node.op === '<' ? v & 0xff : node.op === '>' ? (v >> 8) & 0xff : -v; }
      case 'b': {
        const x = ev(node.a, env), y = ev(node.b, env); if (x == null || y == null) return null;
        switch (node.op) { case '+': return x + y; case '-': return x - y; case '*': return x * y; case '/': return Math.floor(x / y); case '&': return x & y; case '|': return x | y; case '^': return x ^ y; case '<<': return x << y; case '>>': return x >> y; }
        return null;
      }
    }
    return null;
  };
  const splitArgs = (s: string) => { const out: string[] = []; let depth = 0, q = false, cur = ''; for (const c of s) { if (c === '"') q = !q; if (!q && c === '(') depth++; if (!q && c === ')') depth--; if (!q && depth === 0 && c === ',') { out.push(cur.trim()); cur = ''; continue; } cur += c; } if (cur.trim()) out.push(cur.trim()); return out; };
  let mem = new Uint8Array(0x10000), written = new Uint8Array(0x10000), blocks: { start: number; name: string }[] = [];
  const emit = (b: number, st: Stmt) => { b &= 0xff; if (pc > 0xffff) { E('program counter past $ffff', st); return; } if (written[pc] && pass === 'final') E(`memory at $${h4(pc)} written twice`, st); mem[pc] = b; written[pc] = 1; pc++; };

  const runPass = (final: boolean) => {
    mem = new Uint8Array(0x10000); written = new Uint8Array(0x10000); blocks = [];
    pc = 0; let enc = 'screencode_mixed'; unresolved = []; let changed = false;
    const define = (name: string, v: Value, st: Stmt) => { if (final && syms.has(name) && syms.get(name) !== v && typeof v === 'number') E(`symbol "${name}" changed value in the final pass`, st); if (syms.get(name) !== v) changed = true; syms.set(name, v); };
    const defs = new Set<string>();
    for (const st of stmts) {
      try {
        if (st.label) { if (defs.has(st.label)) E(`label "${st.label}" defined twice`, st); defs.add(st.label); define(st.label, pc, st); }
        const s = st.body;
        if (!s) continue;
        let m: RegExpMatchArray | null;
        if ((m = s.match(/^(?:\.pc|\*)\s*=\s*(.+?)(?:\s+"([^"]*)")?$/))) { const v = ev(P(m[1])); if (v != null) pc = v; blocks.push({ start: pc, name: m[2] || '' }); continue; }
        if ((m = s.match(/^\.(label|const|var)\s+([A-Za-z_]\w*)\s*=\s*(.+)$/))) { const v = ev(P(m[3])); if (v != null) define(m[2], v, st); continue; }
        if ((m = s.match(/^\.encoding\s+"([^"]+)"$/))) { if (!ENCODINGS[m[1]]) E(`unknown encoding "${m[1]}"`, st); enc = m[1]; continue; }
        if ((m = s.match(/^\.cpu\b/))) continue;
        if ((m = s.match(/^BasicUpstart2\s*\((.+)\)$/))) {
          const v = ev(P(m[1])) ?? 0x1000; pc = 0x0801; blocks.push({ start: pc, name: 'Basic Upstart' });
          const digits = String(v); const endL = 0x0801 + 6 + digits.length;
          emit(endL & 0xff, st); emit(endL >> 8, st); emit(10, st); emit(0, st); emit(0x9e, st);
          for (const c of digits) emit(c.charCodeAt(0), st);
          emit(0, st); emit(0, st); emit(0, st);
          continue;
        }
        if ((m = s.match(/^\.(byte|by|word|wo|text|fill|import\s+binary|align)\b\s*(.*)$/))) {
          const dir = m[1].replace(/\s+/g, ' '), args = splitArgs(m[2]);
          if (dir === 'byte' || dir === 'by') for (const a of args) { const v = ev(P(a)); emit(v ?? 0, st); }
          else if (dir === 'word' || dir === 'wo') for (const a of args) { const v = ev(P(a)) ?? 0; emit(v & 0xff, st); emit((v >> 8) & 0xff, st); }
          else if (dir === 'text') for (const a of args) { const v = ev(P(a)); if (typeof v === 'string') for (const c of v) emit(ENCODINGS[enc](c), st); else E('.text expects a string', st); }
          else if (dir === 'fill') { const n = ev(P(args[0])); const node = P(args[1] || '0'); if (n == null) continue; for (let i = 0; i < n; i++) emit(ev(node, { i }) ?? 0, st); }
          else if (dir === 'align') { const n = ev(P(args[0])); if (n) while (pc % n) emit(0, st); }
          else if (dir === 'import binary') { const path = ev(P(args[0])); const u = vfs[path]; if (!(u instanceof Uint8Array)) { E(`Can't open binary file "${path}"`, st); continue; } const off = args[1] ? ev(P(args[1])) : 0; const len = args[2] ? ev(P(args[2])) : u.length - off; for (let i = 0; i < len; i++) emit(u[off + i], st); }
          continue;
        }
        if ((m = s.match(/^([A-Za-z]{3})(?:\.([A-Za-z]+))?(?:\s+(.*))?$/)) && ENC[m[1].toUpperCase()]) {
          const mn = m[1].toUpperCase(), ext = (m[2] || '').toLowerCase(), arg = (m[3] || '').trim();
          const modes = ENC[mn]!;
          let mode: string, ex: string | null = null;
          if (!arg) mode = IMPLIED_ACC.has(mn) ? 'acc' : 'imp';
          else if (arg[0] === '#') { mode = 'imm'; ex = arg.slice(1); }
          else if ((m = arg.match(/^\((.+),\s*[xX]\s*\)$/))) { mode = 'izx'; ex = m[1]; }
          else if ((m = arg.match(/^\((.+)\)\s*,\s*[yY]$/))) { mode = 'izy'; ex = m[1]; }
          else if ((m = arg.match(/^\((.+)\)$/)) && mn === 'JMP') { mode = 'ind'; ex = m[1]; }
          else if ((m = arg.match(/^(.+),\s*([xXyY])$/))) { ex = m[1]; mode = m[2].toLowerCase(); }
          else { ex = arg; mode = 'plain'; }
          // Kick Assembler only allows a forced mode where it can choose between zero page and absolute
          if ((mode === 'izy' && (ext === 'zp' || ext === 'z')) || ((mode === 'izx' || mode === 'izy') && (ext === 'abs' || ext === 'a'))) {
            E(`Cannot force ${ext === 'zp' || ext === 'z' ? 'zeropage' : 'absolute'} mode on an argument of type ${mode === 'izy' ? 'indirectZeropageY' : 'indirectZeropageX'}`, st); continue;
          }
          const v = ex != null ? ev(P(ex)) : null;
          if (BRANCHES.has(mn)) mode = 'rel';
          else if (mode === 'plain' || mode === 'x' || mode === 'y') {
            const suf = mode === 'plain' ? '' : mode;
            const forceZp = ext === 'zp' || ext === 'z', forceAbs = ext === 'abs' || ext === 'a';
            const zpOk = modes[('zp' + suf) as AddrMode] !== undefined, absOk = modes[('ab' + (suf || 's')) as AddrMode] !== undefined;
            const wantZp = forceZp || (!forceAbs && v != null && v >= 0 && v < 0x100);
            mode = (wantZp && zpOk) ? 'zp' + suf : absOk ? (suf ? 'ab' + suf : 'abs') : 'zp' + suf;
          }
          const op = modes[mode as AddrMode];
          if (op === undefined) { E(`${mn.toLowerCase()} does not support this addressing mode (${mode})`, st); continue; }
          emit(op, st);
          const len = MODE_LEN[mode as AddrMode];
          if (mode === 'rel') {
            const off = v == null ? 0 : v - (pc + 1);
            if (final && (off < -128 || off > 127)) E(`branch out of range (${off})`, st);
            emit(off & 0xff, st);
          } else if (len === 2) { if (final && v != null && (v < -128 || v > 255)) E(`value $${(v >>> 0).toString(16)} does not fit in a byte`, st); emit(v ?? 0, st); }
          else if (len === 3) { emit((v ?? 0) & 0xff, st); emit(((v ?? 0) >> 8) & 0xff, st); }
          continue;
        }
        E(`unsupported statement: ${s}`, st);
      } catch (err) { E((err as Error).message, st); }
    }
    return changed;
  };
  for (pass = 1; pass <= 12; pass++) { const ch = runPass(false); if (!ch && !unresolved.length && pass > 1) break; }
  pass = 'final';
  runPass(true);
  for (const u of new Set(unresolved)) E(`Unknown symbol "${u}"`);
  let min = -1, max = -1;
  for (let a = 0; a < 0x10000; a++) if (written[a]) { if (min < 0) min = a; max = a; }
  const blockList: AsmBlock[] = blocks.filter(b => b.name).map((b, i, arr) => ({ start: b.start, name: b.name, end: i + 1 < arr.length ? arr[i + 1].start - 1 : max }));
  let prg: Uint8Array | null = null;
  if (min >= 0) { prg = new Uint8Array(max - min + 3); prg[0] = min & 0xff; prg[1] = min >> 8; prg.set(mem.subarray(min, max + 1), 2); }
  return { mem, written, min, max, errors, prg, blocks: blockList, symbols: syms };
}
