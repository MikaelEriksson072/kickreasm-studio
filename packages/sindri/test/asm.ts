/* A small two-pass 6502 assembler for building test programs: labels, `* = addr`, .byte, .word, .text, .fill,
 * expressions with + - < > and *, and every opcode (documented ones first). */
import { OPCODES, isDocumented, type Mode } from '../src/opcodes.ts';

const opcode = new Map<string, number>();
for (let op = 0; op < 256; op++) {
  const key = `${OPCODES[op].name} ${OPCODES[op].mode}`;
  if (!opcode.has(key) || (isDocumented(op) && !isDocumented(opcode.get(key)!))) opcode.set(key, op);
}
const BRANCHES = new Set(['BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BNE', 'BEQ']);

export interface Assembled { prg: Uint8Array; start: number; end: number; labels: Record<string, number> }

export function asm(source: string, defines: Record<string, number> = {}): Assembled {
  const lines = source.split('\n');
  const labels: Record<string, number> = { ...defines };
  const wide = new Set<number>();
  let bytes = new Map<number, number>();
  for (const pass of [1, 2]) {
    bytes = new Map();
    let pc = 0;
    const emit = (...bs: number[]) => { for (const b of bs) bytes.set(pc++ & 0xffff, b & 0xff); };
    const ev = (expr: string): number | null => {
      let total = 0, sign = 1, rest = expr.trim();
      if (!rest) throw new Error(`empty expression`);
      while (rest) {
        let lohi: '<' | '>' | null = null;
        if (rest[0] === '<' || rest[0] === '>') { lohi = rest[0]; rest = rest.slice(1).trim(); }
        const m = /^(\$[0-9a-f]+|%[01]+|\d+|[a-z_]\w*|\*)/i.exec(rest);
        if (!m) throw new Error(`bad expression "${expr}"`);
        const t = m[1];
        let v: number | null = t === '*' ? pc : t[0] === '$' ? parseInt(t.slice(1), 16) : t[0] === '%' ? parseInt(t.slice(1), 2)
          : /^\d/.test(t) ? Number(t) : labels[t] ?? null;
        if (v == null) { if (pass === 2) throw new Error(`unknown label ${t}`); return null; }
        if (lohi === '<') v &= 0xff; else if (lohi === '>') v = (v >> 8) & 0xff;
        total += sign * v;
        rest = rest.slice(t.length).trim();
        if (!rest) break;
        if (rest[0] !== '+' && rest[0] !== '-') throw new Error(`bad expression "${expr}"`);
        sign = rest[0] === '+' ? 1 : -1;
        rest = rest.slice(1).trim();
      }
      return total;
    };
    lines.forEach((raw, i) => {
      let line = raw.replace(/;.*/, '').trim();
      const label = /^([a-z_]\w*):\s*(.*)$/i.exec(line);
      if (label) { labels[label[1]] = pc; line = label[2]; }
      if (!line) return;
      const org = /^\*\s*=\s*(.+)$/.exec(line);
      if (org) { pc = ev(org[1])!; return; }
      const dir = /^\.(\w+)\s*(.*)$/.exec(line);
      if (dir) {
        const [, d, arg] = dir;
        if (d === 'text') { for (const ch of JSON.parse(arg) as string) emit(ch.charCodeAt(0)); return; }
        const items = arg.split(',').map(s => s.trim());
        if (d === 'byte') for (const it of items) emit(ev(it) ?? 0);
        else if (d === 'word') for (const it of items) { const v = ev(it) ?? 0; emit(v & 0xff, v >> 8); }
        else if (d === 'fill') { const n = ev(items[0])!; const v = ev(items[1] ?? '0') ?? 0; for (let k = 0; k < n; k++) emit(v); }
        else throw new Error(`unknown directive .${d}`);
        return;
      }
      const ins = /^([a-z]{3})\s*(.*)$/i.exec(line);
      if (!ins) throw new Error(`line ${i + 1}: cannot read "${raw}"`);
      const name = ins[1].toUpperCase(), op = ins[2].trim();
      let mode: Mode, arg = '';
      if (!op) mode = opcode.has(`${name} imp`) ? 'imp' : 'acc';
      else if (/^a$/i.test(op)) mode = 'acc';
      else if (op[0] === '#') { mode = 'imm'; arg = op.slice(1); }
      else if (/^\(.*,\s*x\)$/i.test(op)) { mode = 'izx'; arg = op.slice(1).replace(/,\s*x\)$/i, ''); }
      else if (/^\(.*\),\s*y$/i.test(op)) { mode = 'izy'; arg = op.slice(1).replace(/\),\s*y$/i, ''); }
      else if (/^\(.*\)$/.test(op)) { mode = 'ind'; arg = op.slice(1, -1); }
      else if (BRANCHES.has(name)) { mode = 'rel'; arg = op; }
      else {
        const idx = /,\s*([xy])$/i.exec(op);
        arg = idx ? op.slice(0, idx.index) : op;
        const v = ev(arg);
        const zp = pass === 1 ? v != null && v < 0x100 : !wide.has(i);
        if (pass === 1 && !zp) wide.add(i);
        const r = idx ? idx[1].toLowerCase() : '';
        mode = (zp ? (r ? `zp${r}` : 'zp') : (r ? `ab${r}` : 'abs')) as Mode;
        if (!opcode.has(`${name} ${mode}`) && zp) { mode = (r ? `ab${r}` : 'abs') as Mode; wide.add(i); }
      }
      const code = opcode.get(`${name} ${mode}`);
      if (code == null) throw new Error(`line ${i + 1}: no ${name} with ${mode}`);
      const v = mode === 'imp' || mode === 'acc' ? 0 : ev(arg) ?? 0;
      if (mode === 'rel') {
        const off = v - (pc + 2);
        if (pass === 2 && (off < -128 || off > 127)) throw new Error(`line ${i + 1}: branch too far`);
        emit(code, off & 0xff);
      } else if (['imm', 'zp', 'zpx', 'zpy', 'izx', 'izy'].includes(mode)) emit(code, v);
      else if (mode === 'imp' || mode === 'acc') emit(code);
      else emit(code, v & 0xff, v >> 8);
    });
  }
  const addrs = [...bytes.keys()];
  const start = Math.min(...addrs), end = Math.max(...addrs);
  const prg = new Uint8Array(end - start + 3);
  prg[0] = start & 0xff; prg[1] = start >> 8;
  for (const [a, b] of bytes) prg[a - start + 2] = b;
  return { prg, start, end, labels };
}

/** `.byte` lines for a block of bytes */
export const byteLines = (data: Uint8Array | number[]): string => {
  const out: string[] = [];
  for (let i = 0; i < data.length; i += 16) out.push('.byte ' + [...data.slice(i, i + 16)].map(b => '$' + b.toString(16)).join(','));
  return out.join('\n');
};

/** the BASIC line `10 SYS2061`, ending at $080c, so code can follow at $080d */
export const SYS_LINE = `
* = $0801
.word $080b, 10
.byte $9e
.text "2061"
.byte 0
.word 0
`;
