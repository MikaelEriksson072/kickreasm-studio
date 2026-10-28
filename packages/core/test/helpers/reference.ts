/* Loads the original single-file prototype engine (test/reference/core.prototype.cjs) as an oracle.
 * Every deliberate deviation of the production engine is applied to the reference as an explicit
 * text patch, so this list documents each behaviour change in one place. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectMusic } from '../../src/analyze/music';

export interface Edit { find: string; replace: string }
export interface Deviation { why: string; edits: Edit[] }

export const DEVIATIONS: Deviation[] = [
  {
    why: 'KickAss 5.25 rejects `.zp` on (zp),y operands ("Cannot force zeropage mode on an argument of type indirectZeropageY"); that mode has no 16-bit form and needs no suffix',
    edits: [{
      find: "if (tk[0].t === 'lbl' && !tk[0].zp && loaded(tk[0].to)) ext = '.zp';",
      replace: "if (tk[0].t === 'lbl' && !tk[0].zp && loaded(tk[0].to) && o.mode !== 'izy') ext = '.zp';",
    }],
  },
  {
    why: 'A 1-byte Word table block wrote its label twice ("label defined twice"); found by the fuzz test',
    edits: [{
      find: 'if (p < b.end) { label(p); dataRows(out, p, b.end, ctx, {}); }\n        break;\n      }\n      case T.FILL:',
      replace: 'if (p < b.end) { if (p !== b.start) label(p); dataRows(out, p, b.end, ctx, {}); }\n        break;\n      }\n      case T.FILL:',
    }],
  },
  {
    why: 'The "Mark as code" linear sweep could start inside an instruction from an earlier code override, claim bytes a later data override owns, or cross into the next file (bytes emitted twice); found by the fuzz test',
    edits: [{
      find: 'let ok = loaded(a + info.len - 1) && a + info.len <= o.end;\n      for (let k = 1; ok && k < info.len; k++) if (insLen[a + k] || codeOwner[a + k] >= 0) ok = false;',
      replace: 'let ok = codeOwner[a] < 0 && !forcedData(a) && loaded(a + info.len - 1) && a + info.len <= o.end;\n      for (let k = 1; ok && k < info.len; k++) if (insLen[a + k] || codeOwner[a + k] >= 0 || forcedData(a + k) || owner[a + k] !== owner[a]) ok = false;',
    }],
  },
  {
    why: 'Tracing let an instruction run from one file into the next, so the first file re-assembled one byte too long (spec 7.3: an instruction never crosses a file end); found by the fuzz test',
    edits: [{
      find: 'if (!loaded(b) || insLen[b] || codeOwner[b] >= 0 || forcedData(b)) { ok = false; break; }',
      replace: 'if (!loaded(b) || owner[b] !== owner[pc] || insLen[b] || codeOwner[b] >= 0 || forcedData(b)) { ok = false; break; }',
    }],
  },
  {
    why: 'Music entries could disagree with the final Music blocks (two music overrides at one address, overrides splitting a detected tune), so the .sid file missed bytes; there is now one entry per Music block with its exact range',
    edits: [
      { find: '  const blocks = [];\n', replace: '  const blocks = [], finalMusic = [];\n' },
      {
        find: 'if (t === T.MUSIC) { const m = music.find(x => x.start === a); if (m) Object.assign(p, { init: m.init, play: m.play }); }',
        replace: "if (t === T.MUSIC) { const m = music.find(x => x.start === a); if (m) Object.assign(p, { init: m.init, play: m.play }); const src = m || music.find(x => a >= x.start && a < x.end); finalMusic.push(Object.assign({}, src || { init: a, play: a + 3, sidRegs: 0, score: 0, why: ['marked by user'], file: owner[a], user: true }, { start: a, end: e })); }",
      },
      { find: 'entryKind, entry, basics, music, vic, gfx: gfxBlocks', replace: 'entryKind, entry, basics, music: finalMusic, vic, gfx: gfxBlocks' },
    ],
  },
  {
    why: 'A user music override that a later code override replaced still painted its bytes as music over the new instructions (bytes emitted twice); found by the fuzz test',
    edits: [{
      find: 'for (const m of music) for (let a = m.start; a < m.end; a++) tm[a] = T.MUSIC;',
      replace: 'for (const m of music) for (let a = m.start; a < m.end; a++) if (!m.user || ov[a] === T.MUSIC) tm[a] = T.MUSIC;',
    }],
  },
  {
    why: 'A branch whose target wraps around $ffff/$0000 (code loaded at $0000) was written as `bne $ffe6`, which no assembler accepts; it is now a .byte line with the mnemonic in the comment; found by the fuzz test',
    edits: [{
      find: '    const d = decode(mem, pc);\n    const opTok = [];',
      replace: "    if (o.mode === 'rel') { const raw = pc + 2 + ((mem[(pc + 1) & 0xffff] ^ 0x80) - 0x80); if (raw < 0 || raw > 0xffff) return Object.assign(line, { k: 'dat', dir: '.byte', tok: joinList(bytes.map(b => ({ t: 'num', s: n2(b) }))), cmt: mnc(o.mn) + ' ' + n4(raw & 0xffff) + ' (branch wraps around the address space)' }); }\n    const d = decode(mem, pc);\n    const opTok = [];",
    }],
  },
  {
    why: 'A label inside a word, a sprite row or the BasicUpstart2 stub was referenced but never written ("Unknown symbol"); such blocks now fall back to plain .byte rows; found by the fuzz test',
    edits: [
      {
        find: "    const label = (a) => { const l = labelAt(a); if (l) out.push({ k: 'lbl', a, name: l.name }); };\n",
        replace: "    const label = (a) => { const l = labelAt(a); if (l) out.push({ k: 'lbl', a, name: l.name }); };\n    const hiddenLabel = (from, to, every = 0) => { for (let p = from; p < to; p++) if (labelAt(p) && !(every && (p - b.start) % every === 0)) return true; return false; };\n",
      },
      {
        find: 'if (bs && bs.upstart && S.basicUpstart && b.end === bs.end) {',
        replace: 'if (bs && bs.upstart && S.basicUpstart && b.end === bs.end && !hiddenLabel(b.start, b.end)) {',
      },
      {
        find: '      case T.WORDS: {\n        label(b.start);\n',
        replace: '      case T.WORDS: {\n        label(b.start);\n        if (hiddenLabel(b.start + 1, b.start + ((b.end - b.start) & ~1), 2)) { dataRows(out, b.start, b.end, ctx, {}); break; }\n',
      },
      {
        find: '      case T.SPRITE: {\n        let p = b.start;\n',
        replace: '      case T.SPRITE: {\n        if (hiddenLabel(b.start + 1, b.start + (b.end - b.start) - ((b.end - b.start) % 64), 64)) { label(b.start); dataRows(out, b.start, b.end, ctx, {}); break; }\n        let p = b.start;\n',
      },
    ],
  },
  {
    why: 'KickAss 5.25 rejects upper-case mnemonics ("Pseudo command \'SEI\' not defined"), so mnemonics are always lower case and Settings.mnemonicCase no longer changes the output',
    edits: [
      {
        find: "  const mnc = m => S.mnemonicCase === 'upper' ? m : m.toLowerCase();\n  const loaded =",
        replace: '  const mnc = m => m.toLowerCase();\n  const loaded =',
      },
      {
        find: "  const mnc = m => S.mnemonicCase === 'upper' ? m : m.toLowerCase();\n  const adr =",
        replace: '  const mnc = m => m.toLowerCase();\n  const adr =',
      },
    ],
  },
  {
    why: 'Word tables widened every number token, so `label+10` became `label+$080b` (wrong value); found by the fuzz test',
    edits: [{
      find: ".map(t => t.t === 'num' ? Object.assign({}, t, { s: n4(v) }) : t)",
      replace: ".map((t, _i, all) => t.t === 'num' && all.length === 1 ? Object.assign({}, t, { s: n4(v) }) : t)",
    }],
  },
  {
    why: '"Mark as Bytes" had no effect on data the heuristics detect (a sine table or PETSCII text stayed a Table/Text block with user false): a data override only set the type map to Data, which the map walk then classified again; such bytes are now their own plain user Data block, split at override starts like other overrides',
    edits: [{
      find: '    } else if (t === T.DATA) {\n      while (e < 0x10000 && tm[e] === T.DATA && owner[e] === fileA) e++;\n',
      replace: "    } else if (t === T.DATA && ov[a] === T.DATA) {\n      while (e < 0x10000 && tm[e] === T.DATA && ov[e] === T.DATA && owner[e] === fileA && !ovProps.has(e)) e++;\n      const o = ovProps.get(a);\n      pushBlock(a, e, T.DATA, Object.assign({}, o ? o.props : {}), 1, 'user override');\n    } else if (t === T.DATA) {\n      while (e < 0x10000 && tm[e] === T.DATA && ov[e] !== T.DATA && owner[e] === fileA) e++;\n",
    }],
  },
  {
    why: 'Overrides that later ones cover completely still counted: their start split the new block, their props leaked into it, and a covered (or cleared) code override still traced and swept, so "Clear override" did not undo "Mark as code"; now block boundaries and props follow the override that wins at each address, and only overrides that still win somewhere are traced, swept or used as music',
    edits: [{
      find: "  const ovList = (project.overrides || []).filter(o => o.type !== 'auto');\n  const ovProps = new Map();\n  for (const o of project.overrides || []) {\n    for (let a = o.start; a < o.end && a < 0x10000; a++) ov[a] = o.type === 'auto' ? 0 : (TYPE_BY_KEY[o.type] || T.DATA);\n    if (o.type !== 'auto') ovProps.set(o.start, o);\n  }\n",
      replace: "  const ovProps = new Map();\n  const ovAll = project.overrides || [], ovWin = new Int32Array(0x10000).fill(-1);\n  ovAll.forEach((o, i) => { for (let a = o.start; a < o.end && a < 0x10000; a++) { ov[a] = o.type === 'auto' ? 0 : (TYPE_BY_KEY[o.type] || T.DATA); ovWin[a] = o.type === 'auto' ? -1 : i; } });\n  const ovLive = new Set();\n  for (let a = 0; a < 0x10000; a++) { const i = ovWin[a]; if (i >= 0) { ovLive.add(i); if (a === 0 || ovWin[a - 1] !== i) ovProps.set(a, ovAll[i]); } }\n  const ovList = ovAll.filter((_o, i) => ovLive.has(i));\n",
    }],
  },
  {
    why: 'A block comment with a line break (the inspector field is multi-line) became one `//` line whose second half was read as code, and a line comment with a line break did the same; a block comment is now one `//` line per text line (an empty one is a bare `//`), and line breaks in a line comment become spaces',
    edits: [
      { find: "    if (userCmt) out.push({ k: 'cmt', a: b.start, text: userCmt });\n", replace: "    if (userCmt) for (const x of userCmt.replace(/\\r\\n?/g, '\\n').split('\\n')) out.push({ k: 'cmt', a: b.start, text: x.trimEnd() });\n" },
      { find: '{ l.cmt = userCmt[l.a]; l.userCmt = true; done.add(l.a); }', replace: "{ l.cmt = userCmt[l.a].replace(/\\s*\\r?\\n\\s*/g, ' '); l.userCmt = true; done.add(l.a); }" },
      { find: "    case 'cmt': return `// ${l.text}`;", replace: "    case 'cmt': return l.text ? `// ${l.text}` : '//';" },
    ],
  },
  {
    why: 'The demo program hung after printing its text: `sei` came before init_screen, whose KERNAL text output ends with `cli`, so the raster IRQ was enabled while $0314 still pointed at the KERNAL handler, which never acknowledges it; `sei` now follows init_screen. The raster bars moved below the title, and the second text line no longer breaks inside "C64" (same length, so every address stays)',
    edits: [
      { find: '  sei\n  jsr $e544\n  jsr init_screen\n', replace: '  jsr $e544\n  jsr init_screen\n  sei\n' },
      { find: '  lda #$32\n  sta $d012\n', replace: '  lda #$62\n  sta $d012\n' },
      { find: 'scrolltext: .text "HELLO FROM THE MIMIR DEMO: 6502 + C64 = FUN    "', replace: 'scrolltext: .text "HELLO FROM THE MIMIR STUDIO DEMO!       ENJOY!!"' },
    ],
  },
  {
    why: 'With "raw addresses" (hwInclude none) an access to a hardware register or KERNAL routine lost its comment ("Border color"), and include/c64-hardware.asm was still written although nothing imports it; the operand stays the raw address but keeps the symbol for the comment, and the include file is left out',
    edits: [
      {
        find: "      const hs = S.hwInclude !== 'none' ? hwSymbol(a) : null;\n      if (hs && (!ctx.isCall || hs.sym.call || hs.off)) { ctx.useHw && ctx.useHw(hs.sym.addr); return [{ t: 'hw', s: hs.text, to: a, sym: hs.sym }]; }\n",
        replace: "      const hs = hwSymbol(a);\n      if (hs && (!ctx.isCall || hs.sym.call || hs.off)) { if (S.hwInclude === 'none') return [{ t: 'num', s: a < 0x100 && ctx.zpWidth ? n2(a) : n4(a), to: a, sym: hs.sym }]; ctx.useHw && ctx.useHw(hs.sym.addr); return [{ t: 'hw', s: hs.text, to: a, sym: hs.sym }]; }\n",
      },
      { find: "const hsTok = opTok.find(t => t.t === 'hw');", replace: "const hsTok = opTok.find(t => (t.t === 'hw' || t.t === 'num') && t.sym);" },
      { find: "  outFiles['include/c64-hardware.asm'] = KR.hardwareInclude(S);", replace: "  if (S.hwInclude !== 'none') outFiles['include/c64-hardware.asm'] = KR.hardwareInclude(S);" },
    ],
  },
  {
    why: 'A program whose own bytes cover $fffa-$ffff (a memory dump) set its IRQ vector with `sta charset_fffe`, a label of the data there; the CPU vectors now keep their names (IRQ_VECTOR, or the raw address with its comment) for every access but a JSR/JMP target',
    edits: [{
      find: "      return [{ t: 'kw', s: `${v}.location`, to: m.start }, { t: 'p', s: '+' }, { t: 'num', s: n4(a - m.start) }];\n    }\n    const lb = labelAt(a);\n",
      replace: "      return [{ t: 'kw', s: `${v}.location`, to: m.start }, { t: 'p', s: '+' }, { t: 'num', s: n4(a - m.start) }];\n    }\n    if (a >= 0xfffa && !ctx.isCall) { const vs = hwSymbol(a); if (vs && vs.sym.cat === 'Vectors') { if (S.hwInclude === 'none') return [{ t: 'num', s: n4(a), to: a, sym: vs.sym }]; ctx.useHw && ctx.useHw(vs.sym.addr); return [{ t: 'hw', s: vs.text, to: a, sym: vs.sym }]; } }\n    const lb = labelAt(a);\n",
    }],
  },
  {
    why: 'Renaming a zero-page pointer (labels[$fb]) left its high byte as `ptr_fb+1`, a name no longer defined ("Unknown symbol"); the high byte now follows the renamed low byte',
    edits: [{
      find: "  for (const [a, l] of labels) if (a < 0x100 && !loaded(a) && l.user) { zp.set(a, { name: l.name, user: true }); labels.delete(a); }\n",
      replace: "  for (const [a, l] of labels) if (a < 0x100 && !loaded(a) && l.user) { zp.set(a, { name: l.name, user: true }); labels.delete(a); }\n  for (const [a, z] of zp) if (z.off) { const base = zp.get(a - z.off); if (base && base.name !== z.name) zp.set(a, Object.assign({}, z, { name: base.name })); }\n",
    }],
  },
  {
    why: 'Music detection (spec 5.8) missed most players: it needed both JMPs of the table traced, so a snapshot (init ran before it was taken), a play called from an interrupt the trace did not find, play at +6 or play code right after JMP init all went unseen. It was rewritten (decoding from the table, the note table, callers, overlapping tables) and is tested on its own in music.test.ts; the reference calls the production detector, its own is kept unused',
    edits: [
      {
        find: '  // ---- 5.8 music detection ----\n  const music = [];\n',
        replace: '  // ---- 5.8 music detection ----\n  const music = detectMusic({ S, mem, insLen, codeOwner, skip, inlineCalls, xrefs, owner, ovList, loaded, forcedData, L, entryKind });\n  const prototypeMusic = () => {\n  const music = [];\n',
      },
      { find: '\n  // ---- 5.9 VIC-II evidence', replace: '\n  };\n  // ---- 5.9 VIC-II evidence' },
    ],
  },
  {
    why: 'A $d018 write or sprite pointer made every byte still data in its window graphics, so a variable between two routines there became a 1-byte Charset or Screen matrix block (with no reason given): the graphics now need to be most of what is loaded in the window, a piece of them between code shorter than a character or bitmap cell (8 bytes) stays data, and each piece gets the reason of the candidate it is part of',
    edits: [
      {
        find: '      let n = 0;\n      for (let a = g.start; a < g.start + g.size && a < 0x10000; a++) if (tm[a] === T.DATA) { tm[a] = g.type; n++; }\n',
        replace: '      const end = Math.min(0x10000, g.start + g.size);\n      let n = 0, data = 0, other = 0;\n      for (let a = g.start; a < end; a++) if (tm[a] === T.DATA) data++; else if (tm[a]) other++;\n      if (other > data) continue;\n      for (let a = g.start; a < end;) {\n        if (tm[a] !== T.DATA) { a++; continue; }\n        let e = a; while (e < end && tm[e] === T.DATA) e++;\n        if (e - a >= 8) { for (let p = a; p < e; p++) tm[p] = g.type; n += e - a; }\n        a = e;\n      }\n',
      },
      { find: '      const g = gfxBlocks.find(x => x.start === a);\n', replace: '      const g = gfxBlocks.find(x => x.type === t && a >= x.start && a < x.start + x.size);\n' },
    ],
  },
  {
    why: 'A hardware name with an offset (`VIC_IRQ_ENABLE+$c0`, one token) after `<`/`>` in a lo/hi pointer table or an immediate hint lost its parentheses: `>VIC_IRQ_ENABLE+$c0` is `(>VIC_IRQ_ENABLE)+$c0` to KickAss, another byte; found on a real program while adding code islands',
    edits: [
      { find: "          else { opTok.push({ t: 'p', s: '#' + (h.kind === 'lo' ? '<' : '>') }); if (tk.length > 1) opTok.push({ t: 'p', s: '(' }, ...tk, { t: 'p', s: ')' }); else opTok.push(...tk); }", replace: "          else { opTok.push({ t: 'p', s: '#' + (h.kind === 'lo' ? '<' : '>') }); if (tk.length > 1 || /[+-]/.test(tk[0].s)) opTok.push({ t: 'p', s: '(' }, ...tk, { t: 'p', s: ')' }); else opTok.push(...tk); }" },
      { find: "              return tk.length > 1 ? [{ t: 'p', s: (lt.part === 'lo' ? '<' : '>') + '(' }, ...tk, { t: 'p', s: ')' }] : [{ t: 'p', s: lt.part === 'lo' ? '<' : '>' }, ...tk];", replace: "              return tk.length > 1 || /[+-]/.test(tk[0].s) ? [{ t: 'p', s: (lt.part === 'lo' ? '<' : '>') + '(' }, ...tk, { t: 'p', s: ')' }] : [{ t: 'p', s: lt.part === 'lo' ? '<' : '>' }, ...tk];" },
    ],
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReferenceKR = any;

let cached: ReferenceKR | null = null;

export function loadReference(): ReferenceKR {
  if (cached) return cached;
  let src = readFileSync(fileURLToPath(new URL('../reference/core.prototype.cjs', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  for (const d of DEVIATIONS) for (const e of d.edits) {
    const n = src.split(e.find).length - 1;
    if (n !== 1) throw new Error(`reference patch must match exactly once (matched ${n}): ${d.why}`);
    src = src.replace(e.find, () => e.replace);
  }
  // The prototype is an IIFE that installs itself on `window` or `globalThis`: hand it a private root
  // (same realm, so typed arrays and Maps compare normally), and the production music detection.
  const root: { KR?: ReferenceKR } = {};
  new Function('window', 'globalThis', 'detectMusic', src)(undefined, root, detectMusic);
  cached = root.KR;
  return cached;
}
