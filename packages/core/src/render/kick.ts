/* =====================================================================
 * Rendering — one line model drives both the listing view and the
 * Kick Assembler export (single source of truth).
 * ===================================================================== */
import type {
  Addr, AnalysisResult, Block, BlockKind, ForcedMode, Line, ListingLine, MusicInfo, NumberFormat,
  ProjectInput, RenderLabel, RenderProblem, RenderResult, TextEncoding, Token, ZpVar, ExcludedRange, LoaderPart } from '../types';
import { kindInfo, TYPE_BY_KEY } from '../model';
import { ENC, MODE_LEN, OPC } from '../cpu/opcodes';
import { decode } from '../cpu/decode';
import { SYM, hwSymbol, isIO } from '../c64/symbols';
import { textEncoding } from '../c64/text';
import { ALL_BANKS, ALL_PORTS, areaAt, bankRange, banked, banksOf, describePorts, portsOf, reaches, reachesForName } from '../c64/memconfig';
import { makePsid } from '../c64/psid';
import { findBlock } from '../analyze/classify';
import { h4 } from '../util/hex';
import { kickMnemonic, lineText } from './lines';
import { hardwareInclude } from './include';

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A valid, non-mnemonic Kick Assembler identifier. */
export const validLabel = (name: string): boolean => ID_RE.test(name) && !ENC[name.toUpperCase()] && name.length <= 64;

/** Per-file render state, also passed to operand formatting. */
interface RenderCtx {
  fileIdx?: number;
  usedMusic?: Set<MusicInfo>;
  prevType?: BlockKind | null;
  needSeg?: boolean;
  useLabel?: (a: Addr) => void;
  useZp?: (a: Addr) => void;
  useHw?: (a: Addr) => void;
  isCall?: boolean;
  zpWidth?: boolean;
  /** the instruction whose operand this is, and how it uses the address (bank tracking names by what it reaches) */
  pc?: Addr;
  write?: boolean;
}

interface DataRowOptions {
  row?: number;
  fmt?: NumberFormat;
  dir?: '.byte' | '.word' | '.text';
  item?: (i: Addr) => Token | Token[];
  cmt?: (p: Addr) => string;
  noLabels?: boolean;
}

export interface RenderOptions {
  /** listing only: every block that is not code is shown disassembled (a linear sweep from its start), to find
   *  code that was classified as data. The files, fileLines and verification do not change. */
  dataAsCode?: boolean;
}

/** loader parts that span code or data: their end gets a mark too */
const LOADER_SPANS: Partial<Record<LoaderPart['role'], string>> = { resident: 'its part on the C64', drivecode: 'its drive code', install: 'its installer', tape: 'the tape loader' };

export function render(A: AnalysisResult, project: ProjectInput, opts: RenderOptions = {}): RenderResult {
  const S = A.S;
  const up = S.hexCase === 'upper';
  const hx = (v: number, w: number) => { const s = v.toString(16).padStart(w, '0'); return up ? s.toUpperCase() : s; };
  const n2 = (v: number) => '$' + hx(v & 0xff, 2), n4 = (v: number) => '$' + hx(v & 0xffff, 4);
  const mnc = kickMnemonic;
  const loaded = (a: number) => a >= 0 && a < 0x10000 && A.owner[a] >= 0;
  const { mem, insLen, codeOwner } = A;

  // final labels: auto + user (user wins)
  const labels = new Map<Addr, RenderLabel>();
  for (const [a, l] of A.labels) labels.set(a, { name: l.name, kind: l.kind, user: false });
  for (const [k, name] of Object.entries(project.labels || {})) { const a = +k; if (name) labels.set(a, { name, kind: (labels.get(a) || { kind: 'user' }).kind || 'user', user: true }); else labels.delete(a); }
  const zp = new Map<Addr, ZpVar>(A.zp);
  for (const [a, l] of labels) if (a < 0x100 && !loaded(a) && l.user) { zp.set(a, { name: l.name, user: true }); labels.delete(a); }
  // a pointer's high byte is written `<name>+1`: it follows the name of its low byte when that is renamed
  for (const [a, z] of zp) if (z.off) { const base = zp.get(a - z.off); if (base && base.name !== z.name) zp.set(a, { ...z, name: base.name }); }
  const labelAt = (a: Addr) => labels.get(a);
  // comment lines and blocks the user inserted above an address; data and text rows break there like at labels
  const notes = project.notes || {};
  const noteAt = (a: Addr) => !!notes[a]?.text;
  // the loaders the analysis found: a comment line where each part starts, and where a longer one ends
  const loaderStarts = new Map<Addr, string[]>(), loaderEnds = new Map<Addr, string[]>();
  const markAt = (m: Map<Addr, string[]>, a: Addr, text: string) => { if (loaded(a)) m.set(a, [...(m.get(a) ?? []), text]); };
  for (const f of A.loaders ?? []) for (const p of f.parts) {
    markAt(loaderStarts, p.start, `==== ${f.name}: ${p.what} ====`);
    if (LOADER_SPANS[p.role] && p.end - p.start > 8) markAt(loaderEnds, p.end, `==== end of ${f.name}: ${LOADER_SPANS[p.role]} ====`);
  }
  const marked = (a: Addr) => loaderStarts.has(a) || loaderEnds.has(a);
  /** data and text rows break at notes and loader marks like at labels */
  const breakAt = (a: Addr) => noteAt(a) || marked(a);
  /** comment text on lines of its own: `//` per line, or one block comment (a `*` `/` pair inside would end it early) */
  const commentLines = (a: Addr, text: string, block = false, note = false): Line[] => {
    const ls = text.replace(/\r\n?/g, '\n').split('\n').map(x => x.trimEnd());
    const tag = note ? { note } : {};
    if (!block) return ls.map((x): Line => ({ k: 'cmt', a, text: x, ...tag }));
    return [
      { k: 'cmt', a, text: '/*', raw: true, ...tag },
      ...ls.map((x): Line => ({ k: 'cmt', a, text: x.replace(/\*\//g, '* /'), raw: true, ...tag })),
      { k: 'cmt', a, text: '*/', raw: true, ...tag },
    ];
  };
  const fileOf = (a: Addr) => A.owner[a];
  /** blocks the user saves to a file of their own: `data/<label>.bin`, loaded back with .import binary */
  const binaryStarts = new Set(project.binary || []);
  // music saved as a binary file is not loaded with LoadSid, so references to it cannot use music.init/play
  const musicFor = (a: Addr) => S.musicAsSid ? A.music.find(m => a >= m.start && a < m.end && !binaryStarts.has(findBlock(A.blocks, m.start)?.start ?? -1)) : null;
  const musicVar = (m: MusicInfo) => A.music.length > 1 ? `music_${h4(m.start)}` : 'music';
  const blocksSorted = A.blocks;

  // duplicate label detection
  const byName = new Map<string, Addr>(); const dupes = new Set<string>();
  for (const [a, l] of labels) { if (byName.has(l.name) && byName.get(l.name) !== a) dupes.add(l.name); byName.set(l.name, a); }

  function addrTokens(a: Addr, ctx: RenderCtx): Token[] {
    a &= 0xffff;
    const m = musicFor(a);
    if (m) {
      const v = musicVar(m);
      ctx.usedMusic && ctx.usedMusic.add(m);
      if (a === m.init) return [{ t: 'kw', s: `${v}.init`, to: a }];
      if (a === m.play) return [{ t: 'kw', s: `${v}.play`, to: a }];
      return [{ t: 'kw', s: `${v}.location`, to: m.start }, { t: 'p', s: '+' }, { t: 'num', s: n4(a - m.start) }];
    }
    // bank tracking: an instruction that always reaches I/O or ROM here gets the hardware/ROM name (or the bare
    // address), never the label of the RAM bytes below; one that always reaches RAM never gets a hardware name.
    // Where the configuration cannot be told, $d000-$dfff is I/O
    const seen = A.mcfg && ctx.pc != null ? reachesForName(a, A.mcfg.port[ctx.pc], !!ctx.write) : null;
    if (seen === 'hw') {
      const hs = hwSymbol(a);
      if (hs && (!ctx.isCall || hs.sym.call || hs.off)) {
        // "raw addresses": the address itself, with the symbol kept for the comment and the listing's tooltip
        if (S.hwInclude === 'none') return [{ t: 'num', s: n4(a), to: a, sym: hs.sym }];
        ctx.useHw && ctx.useHw(hs.sym.addr); return [{ t: 'hw', s: hs.text, to: a, sym: hs.sym }];
      }
      return [{ t: 'num', s: n4(a), to: loaded(a) ? a : undefined }];
    }
    // the CPU's NMI/reset/IRQ vectors: writing them sets the handler (in RAM when the KERNAL is banked out), so they
    // keep their names even when the program's own bytes cover $fffa-$ffff (a memory dump, say)
    if (a >= 0xfffa && !ctx.isCall) {
      const hs = hwSymbol(a);
      if (hs && hs.sym.cat === 'Vectors') {
        if (S.hwInclude === 'none') return [{ t: 'num', s: n4(a), to: a, sym: hs.sym }];
        ctx.useHw && ctx.useHw(hs.sym.addr); return [{ t: 'hw', s: hs.text, to: a, sym: hs.sym }];
      }
    }
    const lb = labelAt(a);
    if (lb && loaded(a)) { ctx.useLabel && ctx.useLabel(a); return [{ t: 'lbl', s: lb.name, to: a }]; }
    if (loaded(a)) {
      const base = A.offsetOf.get(a);
      if (base != null && labelAt(base)) { ctx.useLabel && ctx.useLabel(base); return [{ t: 'lbl', s: labelAt(base)!.name, to: base }, { t: 'p', s: '+' }, { t: 'num', s: '1' }]; }
      const s = codeOwner[a] >= 0 ? codeOwner[a] : -1;
      if (s >= 0 && labelAt(s)) { ctx.useLabel && ctx.useLabel(s); return [{ t: 'lbl', s: labelAt(s)!.name, to: s }, { t: 'p', s: '+' }, { t: 'num', s: String(a - s) }]; }
      const b = findBlock(A.blocks, a);
      if (b) for (let p = a - 1; p >= b.start && a - p < 256; p--) {
        const l = labelAt(p);
        if (l) { ctx.useLabel && ctx.useLabel(p); return [{ t: 'lbl', s: l.name, to: p }, { t: 'p', s: '+' }, { t: 'num', s: String(a - p) }]; }
      }
    }
    if (!loaded(a) || (isIO(a) && !ctx.isCall)) {
      if (a < 0x100 && zp.has(a)) {
        const z = zp.get(a)!; ctx.useZp && ctx.useZp(z.off ? a - 1 : a);
        return z.off ? [{ t: 'lbl', s: z.name, to: a - 1, zp: true }, { t: 'p', s: '+' }, { t: 'num', s: '1' }] : [{ t: 'lbl', s: z.name, to: a, zp: true }];
      }
      const hs = hwSymbol(a);
      // the CPU vectors at $fffa-$ffff are RAM exactly when the KERNAL is banked out: they keep their names
      if (hs && (!ctx.isCall || hs.sym.call || hs.off) && (seen !== 'ram' || hs.sym.cat === 'Vectors')) {
        if (S.hwInclude === 'none') return [{ t: 'num', s: a < 0x100 && ctx.zpWidth ? n2(a) : n4(a), to: a, sym: hs.sym }];
        ctx.useHw && ctx.useHw(hs.sym.addr); return [{ t: 'hw', s: hs.text, to: a, sym: hs.sym }];
      }
    }
    return [{ t: 'num', s: a < 0x100 && ctx.zpWidth ? n2(a) : n4(a), to: loaded(a) ? a : undefined }];
  }

  function insLine(pc: Addr, ctx: RenderCtx, len?: number): Line {
    const o = OPC[mem[pc]];
    const n = len ?? insLen[pc];
    const bytes = [...mem.subarray(pc, pc + n)];
    if (A.skip.has(pc)) {
      return { k: 'dat', a: pc, n, mn: o.mn, ill: o.ill, dir: '.byte', tok: [{ t: 'num', s: n2(mem[pc]) }], cmt: `bit ${o.mode === 'abs' ? 'abs' : 'zp'}: skips the next ${o.len - 1}-byte instruction` };
    }
    if (o.mode === 'rel') {
      // the CPU wraps at $ffff/$0000, an assembler cannot express such a branch with a mnemonic
      const raw = pc + 2 + ((mem[(pc + 1) & 0xffff] ^ 0x80) - 0x80);
      if (raw < 0 || raw > 0xffff) return { k: 'dat', a: pc, n, mn: o.mn, ill: o.ill, dir: '.byte', tok: joinList(bytes.map(b => ({ t: 'num', s: n2(b) }))), cmt: `${mnc(o.mn)} ${n4(raw & 0xffff)} (branch wraps around the address space)` };
    }
    const d = decode(mem, pc);
    const opTok: Token[] = [];
    let ext: ForcedMode = '';
    const c: RenderCtx = Object.assign({}, ctx, { isCall: o.flow === 'jsr' || o.flow === 'jmp', zpWidth: MODE_LEN[o.mode] === 2, pc, write: o.access === 'write' });
    switch (o.mode) {
      case 'imp': case 'acc': break;
      case 'imm': {
        const h = A.hints.get(pc);
        if (h) {
          // an address used as a value, not accessed by this instruction
          const tk = addrTokens(h.target, Object.assign({}, c, { pc: undefined }));
          if (tk[0].t === 'num') opTok.push({ t: 'p', s: '#' }, { t: 'num', s: n2(d.v!) });
          else { opTok.push({ t: 'p', s: '#' + (h.kind === 'lo' ? '<' : '>') }); if (tk.length > 1 || /[+-]/.test(tk[0].s)) opTok.push({ t: 'p', s: '(' }, ...tk, { t: 'p', s: ')' }); else opTok.push(...tk); }
        } else opTok.push({ t: 'p', s: '#' }, { t: 'num', s: n2(d.v!) });
        break;
      }
      case 'rel': opTok.push(...addrTokens(d.target!, c)); break;
      case 'zp': case 'zpx': case 'zpy': case 'izx': case 'izy': {
        const tk = addrTokens(d.v!, c);
        // A program label may be defined later in the source, so Kick's first pass would pick the
        // 16-bit form: force zero page. KickAss 5.25 rejects `.zp` on `(zp),y` ("Cannot force zeropage
        // mode on an argument of type indirectZeropageY"); that mode has no 16-bit form and needs no suffix.
        if (tk[0].t === 'lbl' && !tk[0].zp && loaded(tk[0].to!) && o.mode !== 'izy') ext = '.zp';
        if (o.mode === 'izx') opTok.push({ t: 'p', s: '(' }, ...tk, { t: 'p', s: ',x)' });
        else if (o.mode === 'izy') opTok.push({ t: 'p', s: '(' }, ...tk, { t: 'p', s: '),y' });
        else opTok.push(...tk, ...(o.mode === 'zpx' ? [{ t: 'p', s: ',x' } as Token] : o.mode === 'zpy' ? [{ t: 'p', s: ',y' } as Token] : []));
        break;
      }
      case 'abs': case 'abx': case 'aby': case 'ind': {
        if (o.flow === 'jmp' && d.target === pc) { opTok.push({ t: 'p', s: '*' }); break; }
        const tk = addrTokens(d.v!, Object.assign({}, c, { zpWidth: false }));
        if (d.v! < 0x100 && o.mode !== 'ind') { ext = '.abs'; if (tk[0].t === 'num') tk[0].s = n4(d.v!); }
        if (o.mode === 'ind') opTok.push({ t: 'p', s: '(' }, ...tk, { t: 'p', s: ')' });
        else opTok.push(...tk, ...(o.mode === 'abx' ? [{ t: 'p', s: ',x' } as Token] : o.mode === 'aby' ? [{ t: 'p', s: ',y' } as Token] : []));
        break;
      }
    }
    if (!o.kick) {
      const shown = opTok.map(t => t.s).join('');
      return { k: 'dat', a: pc, n, mn: o.mn, ill: true, dir: '.byte', tok: joinList(bytes.map(b => ({ t: 'num', s: n2(b) }))), cmt: `${mnc(o.mn)}${shown ? ' ' + shown : ''} (undocumented${o.unstable ? ', unstable' : ''})` };
    }
    const cm: string[] = [];
    if (A.smc.has(pc)) cm.push(`self-modified by ${n4(A.smc.get(pc)!)}`);
    if (o.flow === 'jmpi') { const t = [...A.lohiTabs.values()].find(t => t.dest === d.v && t.code); cm.push(t ? `jump table: ${t.len} targets` : 'indirect jump'); }
    if (A.inlineCalls.has(pc)) cm.push('inline data follows');
    // the register's description, also when the operand is written as the raw address
    if (S.hwComments) { const hsTok = opTok.find(t => (t.t === 'hw' || t.t === 'num') && t.sym); if (hsTok && hsTok.sym && hsTok.sym.desc) cm.push(hsTok.sym.desc); }
    if (S.hwComments && A.mcfg) {
      // what this instruction sets, and accesses whose target depends on a configuration that varies here
      const ch = A.mcfg.changes.get(pc);
      if (ch && ch.port != null) cm.push(ch.port === ALL_PORTS ? 'sets $01 to a value the analysis cannot follow' : `memory ${describePorts(ch.port)}`);
      else if (ch && ch.vic != null && ch.vic !== ALL_BANKS) cm.push(`VIC bank ${banksOf(ch.vic).map(b => `${b} (${bankRange(b)})`).join(' or ')}`);
      const m = A.mcfg.port[pc], at = d.v;
      if (at != null && o.mode !== 'imm' && o.mode !== 'rel' && banked(at) && m && m !== ALL_PORTS && reaches(at, m, o.access === 'write') === null) {
        const names: Record<string, string> = { ram: 'RAM', io: 'I/O', basic: 'BASIC ROM', kernal: 'KERNAL ROM', char: 'character ROM' };
        const seen = [...new Set(portsOf(m).map(cf => names[areaAt(at, cf, o.access === 'write')]))];
        if (seen.length > 1) cm.push(`${seen.join(' or ')}: $01 is ${describePorts(m)} here`);
      }
    }
    if (o.ill) cm.push('undocumented opcode');
    return { k: 'ins', a: pc, n, mn: o.mn, ill: o.ill, ext, tok: opTok, cmt: cm.join('; ') };
  }

  function joinList(items: (Token | Token[])[]): Token[] { const out: (Token | Token[])[] = []; items.forEach((it, i) => { if (i) out.push({ t: 'p', s: ', ' }); out.push(it); }); return out.flat(); }
  const numTok = (v: number, fmt?: NumberFormat): Token => ({ t: 'num', s: fmt === 'bin' ? '%' + v.toString(2).padStart(8, '0') : fmt === 'dec' ? String(v) : n2(v) });

  function dataRows(out: Line[], s: Addr, e: Addr, _ctx: RenderCtx, opt: DataRowOptions = {}) {
    const row = opt.row || S.bytesPerRow, fmt = opt.fmt || 'hex';
    let p = s;
    while (p < e) {
      if (p !== s && labelAt(p) && !opt.noLabels) out.push({ k: 'lbl', a: p, name: labelAt(p)!.name });
      let q = p + 1;
      while (q < e && q - p < row && !(labelAt(q) && !opt.noLabels) && !breakAt(q)) q++;
      const items: (Token | Token[])[] = [];
      for (let i = p; i < q; i++) items.push(opt.item ? opt.item(i) : numTok(mem[i], fmt));
      out.push({ k: 'dat', a: p, n: q - p, dir: opt.dir || '.byte', tok: joinList(items), cmt: opt.cmt ? opt.cmt(p) : '' });
      p = q;
    }
  }

  function textRows(out: Line[], s: Addr, e: Addr, enc: TextEncoding) {
    const te = textEncoding(enc), pet = enc === 'petscii' || enc === 'petscii-mixed';
    // a screen code $00 is '@' inside a text; at its end it stays `.byte $00 // end` (a terminator)
    const ok = (a: Addr) => te.char(mem[a]) != null && (mem[a] !== 0 || (a + 1 < e && mem[a + 1] !== 0 && te.char(mem[a + 1]) != null));
    out.push({ k: 'dir', a: s, n: 0, tok: [{ t: 'dir', s: '.encoding' }, { t: 'p', s: ' ' }, { t: 'str', s: `"${te.kick}"` }] });
    let p = s;
    while (p < e) {
      if (p !== s && labelAt(p)) out.push({ k: 'lbl', a: p, name: labelAt(p)!.name });
      if (ok(p)) {
        let q = p; while (q < e && ok(q) && q - p < 48 && !(q !== p && (labelAt(q) || breakAt(q)))) q++;
        out.push({ k: 'dat', a: p, n: q - p, dir: '.text', tok: [{ t: 'str', s: '"' + [...mem.subarray(p, q)].map(b => te.char(b)).join('') + '"' }], cmt: '' });
        p = q;
      } else {
        let q = p; while (q < e && !ok(q) && q - p < S.bytesPerRow && !(q !== p && (labelAt(q) || breakAt(q)))) q++;
        const names: Record<number, string> = { 0x0d: 'RETURN', 0x00: 'end', 0x93: 'CLR', 0x13: 'HOME', 0x11: 'DOWN', 0x05: 'WHITE', 0x0e: 'lower case', 0x8e: 'upper case' };
        const c = pet ? [...mem.subarray(p, q)].map(b => names[b]).filter(Boolean).join(', ') : (mem[p] === 0 && q - p === 1 ? 'end' : '');
        out.push({ k: 'dat', a: p, n: q - p, dir: '.byte', tok: joinList([...mem.subarray(p, q)].map(b => numTok(b))), cmt: c });
        p = q;
      }
    }
  }

  const binFiles: Record<string, Uint8Array> = {};
  // not bin/: that is the output folder of many C64 setups, and the Sublime Text Kick Assembler package empties it
  // before every build ("kickass_empty_bin_folder_before_build")
  /** the .label lines of binary blocks: a label the analysis made but the source never uses (an I/O register the
   *  code reaches as VIC_..., say) is dropped once the whole file is written */
  const binaryDefs = new WeakSet<Line>();
  const binaryPath = (b: Block) => { const l = labelAt(b.start); return `data/${l ? l.name : `block_${h4(b.start)}`}.bin`; };
  const blockTitle = (b: Block) => {
    const info = kindInfo(b.type), p = b.props;
    let t = info.label;
    if (b.type === 'text') t += ` (${textEncoding(p.enc).label})`;
    if (b.type === 'table') t = p.sub === 'sine' ? 'Curve table' : p.sub === 'colors' ? 'Color table' : 'Table';
    if (b.type === 'lohi') t = `${p.ptr ? 'Pointer' : 'Value'} table (${p.part} bytes)`;
    if (b.type === 'data' && p.var) t = 'Variables';
    return t;
  };
  const SEG_NAME: Partial<Record<BlockKind, string>> = { code: 'Code', sprite: 'Sprites', charset: 'Charset', bitmap: 'Bitmap', screen: 'Screen', data: 'Data' };

  function renderBlock(out: Line[], b: Block, ctx: RenderCtx & { usedMusic: Set<MusicInfo> }) {
    const lb = labelAt(b.start);
    const len = b.end - b.start;
    const title = blockTitle(b);
    const userCmt = (project.blockComments || {})[b.start];
    const binary = binaryStarts.has(b.start) ? binaryPath(b) : null;
    out.push({ k: 'hdr', a: b.start, blk: b.id, type: TYPE_BY_KEY[b.type], text: `${title}${lb ? ' · ' + lb.name : ''} · ${n4(b.start)}-${n4(b.end - 1)} (${len} byte${len === 1 ? '' : 's'})${binary ? ` · ${binary}` : ''}`, ...(binary ? { binary } : {}) });
    if (userCmt) out.push(...commentLines(b.start, userCmt));
    const seg = (name: string) => out.push({ k: 'dir', a: b.start, n: 0, tok: [{ t: 'dir', s: '.pc' }, { t: 'p', s: ' = ' }, { t: 'num', s: n4(b.start) }, { t: 'p', s: ' ' }, { t: 'str', s: `"${name}"` }] });
    if (ctx.needSeg || (['sprite', 'charset', 'bitmap', 'screen'] as BlockKind[]).includes(b.type) || (b.type === 'code' && ctx.prevType !== 'code') || (b.type !== 'code' && ctx.prevType === 'code')) {
      if (binary || (b.type !== 'basic' && !(b.type === 'music' && S.musicAsSid))) seg(SEG_NAME[b.type] || (b.type === 'code' ? 'Code' : 'Data'));
    }
    ctx.needSeg = false;
    const label = (a: Addr) => { const l = labelAt(a); if (l) out.push({ k: 'lbl', a, name: l.name }); };
    if (binary) {
      // the bytes go to their own file; labels inside the block stay defined for the code that uses them
      label(b.start);
      binFiles[binary] = mem.slice(b.start, b.end);
      out.push({ k: 'dir', a: b.start, n: len, tok: [{ t: 'dir', s: '.import binary' }, { t: 'p', s: ' ' }, { t: 'str', s: `"${binary}"` }], cmt: `${len} bytes · ${title}` });
      for (let p = b.start + 1; p < b.end; p++) {
        const l = labelAt(p);
        if (!l) continue;
        const def: Line = { k: 'dir', a: p, n: 0, tok: [{ t: 'dir', s: '.label' }, { t: 'p', s: ' ' }, { t: 'def', s: l.name }, { t: 'p', s: ' = ' }, { t: 'num', s: n4(p) }] };
        binaryDefs.add(def); // kept only if the file refers to the label (see the file loop)
        out.push(def);
      }
      ctx.prevType = b.type;
      return;
    }
    // A label the block layout cannot write (inside a word, a sprite row or the BasicUpstart2 stub)
    // would be referenced but never defined: such blocks fall back to plain .byte rows.
    const hiddenLabel = (from: Addr, to: Addr, every = 0) => { for (let p = from; p < to; p++) if (labelAt(p) && !(every && (p - b.start) % every === 0)) return true; return false; };
    switch (b.type) {
      case 'basic': {
        const bs = A.basics.find(x => x.start === b.start);
        if (bs && bs.upstart && S.basicUpstart && b.end === bs.end && !hiddenLabel(b.start, b.end)) {
          const tk: Token[] = bs.sys != null ? addrTokens(bs.sys, ctx) : [{ t: 'num', s: '0' }];
          out.push({ k: 'dir', a: b.start, n: b.end - b.start, tok: [{ t: 'kw', s: 'BasicUpstart2' }, { t: 'p', s: '(' }, ...tk, { t: 'p', s: ')' }], cmt: bs.lines.map(l => l.text).join(' : ') });
          ctx.needSeg = true;
        } else {
          seg('Basic');
          label(b.start);
          dataRows(out, b.start, b.end, ctx, { cmt: p => { const l = bs && bs.lines.find(x => x.addr === p); return l ? l.text : ''; }, row: S.bytesPerRow });
        }
        break;
      }
      case 'code': {
        let p = b.start;
        while (p < b.end) {
          if (insLen[p]) { label(p); out.push(insLine(p, ctx)); p += insLen[p]; }
          else { label(p); out.push({ k: 'dat', a: p, n: 1, dir: '.byte', tok: [{ t: 'num', s: n2(mem[p]) }], cmt: 'orphan byte' }); p++; }
        }
        break;
      }
      case 'music': {
        const m: MusicInfo = A.music.find(x => x.start === b.start) || { start: b.start, end: b.end, init: b.start, play: b.start + 3, sidRegs: 0, score: 0, why: [], file: b.file };
        if (S.musicAsSid) {
          const v = musicVar(m);
          const path = `music/music_${h4(m.start)}.sid`;
          binFiles[path] = makePsid(mem.slice(m.start, m.end), m.start, m.init, m.play, `${project.name || 'music'} ${h4(m.start)}`);
          ctx.usedMusic.add(m);
          out.push({ k: 'dir', a: b.start, n: 0, tok: [{ t: 'dir', s: '.pc' }, { t: 'p', s: ' = ' }, { t: 'kw', s: `${v}.location`, to: m.start }, { t: 'p', s: ' ' }, { t: 'str', s: '"Music"' }] });
          out.push({ k: 'dir', a: b.start, n: b.end - b.start, tok: [{ t: 'dir', s: '.fill' }, { t: 'p', s: ' ' }, { t: 'kw', s: `${v}.size` }, { t: 'p', s: ', ' }, { t: 'kw', s: `${v}.getData(i)` }], cmt: `${path}: init ${n4(m.init)}, play ${n4(m.play)}` });
          ctx.needSeg = true;
        } else {
          seg('Music'); label(b.start);
          dataRows(out, b.start, b.end, ctx, {});
        }
        break;
      }
      case 'text': label(b.start); textRows(out, b.start, b.end, b.props.enc || 'petscii'); break;
      case 'lohi': {
        label(b.start);
        const lt = A.lohiTabs.get(b.start);
        if (lt && lt.ptr) {
          dataRows(out, b.start, b.end, ctx, {
            item: i => {
              const v = mem[lt.lo + (i - b.start)] | (mem[lt.hi + (i - b.start)] << 8);
              const tk = addrTokens(v, ctx);
              if (tk[0].t === 'num') return numTok(mem[i]);
              return tk.length > 1 || /[+-]/.test(tk[0].s) ? [{ t: 'p', s: (lt.part === 'lo' ? '<' : '>') + '(' }, ...tk, { t: 'p', s: ')' }] : [{ t: 'p', s: lt.part === 'lo' ? '<' : '>' }, ...tk];
            }, row: 4,
          });
        } else dataRows(out, b.start, b.end, ctx, {});
        break;
      }
      case 'words': {
        label(b.start);
        if (hiddenLabel(b.start + 1, b.start + ((b.end - b.start) & ~1), 2)) { dataRows(out, b.start, b.end, ctx, {}); break; }
        // without a number format the words are addresses (labels where they point into the program), one a row
        const fmt = b.props.fmt, row = b.props.row || 1;
        const word = (q: Addr): Token[] => {
          const v = mem[q] | (mem[q + 1] << 8);
          if (fmt) return [{ t: 'num', s: fmt === 'bin' ? '%' + v.toString(2).padStart(16, '0') : fmt === 'dec' ? String(v) : n4(v) }];
          // a bare number is widened to 4 digits; offsets in `label+n` must stay as they are
          const tk = addrTokens(v, Object.assign({}, ctx, { zpWidth: false }));
          return tk.length === 1 && tk[0].t === 'num' ? [Object.assign({}, tk[0], { s: n4(v) })] : tk;
        };
        let p = b.start;
        while (p + 1 < b.end) {
          if (p !== b.start) label(p);
          const items: Token[][] = [];
          let q = p;
          while (q + 1 < b.end && items.length < row && !(q !== p && (labelAt(q) || breakAt(q)))) { items.push(word(q)); q += 2; }
          out.push({ k: 'dat', a: p, n: q - p, dir: '.word', tok: joinList(items), cmt: '' });
          p = q;
        }
        // an odd trailing byte (or a 1-byte block, whose label was already written above)
        if (p < b.end) { if (p !== b.start) label(p); dataRows(out, p, b.end, ctx, {}); }
        break;
      }
      case 'fill': {
        label(b.start);
        let mixed = false; for (let p = b.start + 1; p < b.end; p++) if (labelAt(p) || mem[p] !== mem[b.start]) { mixed = true; break; }
        if (mixed) { dataRows(out, b.start, b.end, ctx, {}); break; }
        out.push({ k: 'dir', a: b.start, n: len, tok: [{ t: 'dir', s: '.fill' }, { t: 'p', s: ' ' }, { t: 'num', s: String(len) }, { t: 'p', s: ', ' }, { t: 'num', s: n2(mem[b.start]) }] });
        break;
      }
      case 'sprite': {
        if (hiddenLabel(b.start + 1, b.start + (b.end - b.start) - ((b.end - b.start) % 64), 64)) { label(b.start); dataRows(out, b.start, b.end, ctx, {}); break; }
        let p = b.start;
        while (p + 64 <= b.end) {
          label(p);
          const sp = A.vic.sprites.find(x => x.addr === p);
          out.push({ k: 'cmt', a: p, text: `sprite ${n4(p)}${sp ? ` · pointer ${n2(sp.ptr)} (sprite ${sp.n})` : ''} · 24×21` });
          for (let r = 0; r < 21; r++) out.push({ k: 'dat', a: p + r * 3, n: 3, dir: '.byte', tok: joinList([0, 1, 2].map(i => numTok(mem[p + r * 3 + i], 'bin'))), cmt: '' });
          out.push({ k: 'dat', a: p + 63, n: 1, dir: '.byte', tok: [numTok(mem[p + 63])], cmt: 'padding / sprite mode byte' });
          p += 64;
        }
        if (p < b.end) { label(p); dataRows(out, p, b.end, ctx, {}); }
        break;
      }
      case 'charset': case 'bitmap': case 'screen': {
        label(b.start);
        const hasInner = (() => { for (let p = b.start + 1; p < b.end; p++) if (labelAt(p)) return true; return false; })();
        if (S.gfxBinary && b.type !== 'screen' && !hasInner) {
          const path = `gfx/${b.type}_${h4(b.start)}.bin`;
          binFiles[path] = mem.slice(b.start, b.end);
          out.push({ k: 'dir', a: b.start, n: len, tok: [{ t: 'dir', s: '.import binary' }, { t: 'p', s: ' ' }, { t: 'str', s: `"${path}"` }], cmt: `${len} bytes` });
        } else if (b.type === 'charset') {
          dataRows(out, b.start, b.end, ctx, { row: 8, cmt: p => ((p - b.start) % 8 === 0 ? `char ${n2((p - b.start) >> 3)}` : '') });
        } else dataRows(out, b.start, b.end, ctx, { row: b.type === 'screen' ? 40 : 8 });
        break;
      }
      default: {
        label(b.start);
        const p = b.props || {};
        dataRows(out, b.start, b.end, ctx, { fmt: p.fmt, row: p.row });
      }
    }
    ctx.prevType = b.type;
  }

  // ---- "data as code" (listing only) ----
  /** a block's bytes swept as instructions from its start; a byte that ends no instruction inside the block is .byte */
  function previewLines(b: Block): Line[] {
    const out: Line[] = [];
    const ctx: RenderCtx = {}; // no use* callbacks: the preview must not change what the files import
    let p = b.start;
    while (p < b.end) {
      if (noteAt(p)) out.push(...commentLines(p, notes[p].text, !!notes[p].block, true));
      const lb = labelAt(p);
      if (lb) out.push({ k: 'lbl', a: p, name: lb.name });
      const o = OPC[mem[p]];
      if (!o.jam && p + o.len <= b.end) { out.push({ ...insLine(p, ctx, o.len), preview: true } as Line); p += o.len; }
      else { out.push({ k: 'dat', a: p, n: 1, dir: '.byte', tok: [numTok(mem[p])], cmt: o.jam ? `${mnc(o.mn)} (halts the CPU)` : '', preview: true }); p++; }
    }
    return out;
  }
  /** a file's lines with every non-code block replaced by its preview; headers, block comments and .pc stay.
   *  Fill blocks (one byte repeated) stay as they are: as code they would only be a column of the same instruction. */
  function asCode(src: Line[]): Line[] {
    const out: Line[] = [];
    for (let i = 0; i < src.length; i++) {
      const l = src[i];
      const b = l.k === 'hdr' ? A.blocks[l.blk] : null;
      if (!b || b.type === 'code' || b.type === 'fill') { out.push(l); continue; }
      out.push({ ...l, preview: true } as Line);
      let j = i + 1, body = false;
      for (; j < src.length && src[j].k !== 'hdr' && src[j].k !== 'blank'; j++) {
        const x = src[j];
        if (x.k === 'lbl' || x.k === 'ins' || x.k === 'dat' || (x.k === 'cmt' && x.note) || (x.k === 'dir' && x.n > 0)) body = true;
        else if (!body && (x.k === 'cmt' || (x.k === 'dir' && x.tok[0]?.s === '.pc'))) out.push(x);
      }
      out.push(...previewLines(b));
      i = j - 1;
    }
    return out;
  }

  // ---- per file ----
  const outFiles: Record<string, string | Uint8Array> = {};
  const fileLines: Record<string, Line[]> = {};
  const listing: ListingLine[] = [];
  const fileNames = A.files.map((f, i) => (f.name || `file${i}`).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_') || `file${i}`);
  const used = new Set<string>();
  fileNames.forEach((n, i) => { let m = n, k = 2; while (used.has(m)) m = `${n}_${k++}`; used.add(m); fileNames[i] = m; });
  const allUsedHw = new Set<Addr>();
  const problems: RenderProblem[] = [];
  const excludedStarts = new Set(project.excluded || []);
  const excludedAll: ExcludedRange[] = [];
  for (const name of dupes) problems.push({ lvl: 'err', msg: `Label "${name}" is defined more than once`, addr: byName.get(name) });

  A.files.forEach((f, fi) => {
    const body: Line[] = [];
    const usedZp = new Set<Addr>(), usedExt = new Set<Addr>(), usedHw = new Set<Addr>(), usedHere = new Set<Addr>();
    const ctx: RenderCtx & { usedMusic: Set<MusicInfo> } = {
      fileIdx: fi, usedMusic: new Set(), prevType: null, needSeg: true,
      useLabel: a => { if (fileOf(a) !== fi) usedExt.add(a); else usedHere.add(a); },
      useZp: a => usedZp.add(a), useHw: a => usedHw.add(a),
    };
    const fb = blocksSorted.filter(b => b.file === fi);
    const fileExcluded: ExcludedRange[] = [];
    for (const b of fb) {
      if (!excludedStarts.has(b.start)) { renderBlock(body, b, ctx); body.push({ k: 'blank', a: b.end }); continue; }
      // left out of the build: the block stays in the source under #if, and its labels stay defined for the code using them
      const lb = labelAt(b.start), name = `INCLUDE_${lb ? lb.name : h4(b.start)}`;
      const inner: Line[] = [];
      renderBlock(inner, b, ctx);
      const hdr = inner.shift()!;
      body.push({ ...hdr, text: `${(hdr as { text: string }).text} · excluded from the build`, excluded: true } as Line);
      body.push({ k: 'dir', a: b.start, n: 0, tok: [{ t: 'dir', s: '#if' }, { t: 'p', s: ' ' }, { t: 'def', s: name }] });
      body.push(...inner);
      const lbls = inner.filter((l): l is Extract<Line, { k: 'lbl' }> => l.k === 'lbl');
      // a binary block defines the labels inside it with .label: those are needed in the #else branch too
      const defs = inner.filter(l => l.k === 'dir' && l.n === 0 && l.tok[0]?.s === '.label');
      if (lbls.length || defs.length) {
        body.push({ k: 'dir', a: b.start, n: 0, tok: [{ t: 'dir', s: '#else' }] });
        for (const l of lbls) body.push({ k: 'dir', a: l.a, n: 0, tok: [{ t: 'dir', s: '.label' }, { t: 'p', s: ' ' }, { t: 'def', s: l.name }, { t: 'p', s: ' = ' }, { t: 'num', s: n4(l.a) }] });
        body.push(...defs);
      }
      body.push({ k: 'dir', a: b.end, n: 0, tok: [{ t: 'dir', s: '#endif' }] }, { k: 'blank', a: b.end });
      ctx.needSeg = true; // the next block cannot continue from these bytes
      fileExcluded.push({ start: b.start, end: b.end, file: fi, name });
    }
    excludedAll.push(...fileExcluded);
    // labels inside binary blocks stay defined only where this file refers to them (other files define their own)
    if (binaryStarts.size) body.splice(0, body.length, ...body.filter(l => !binaryDefs.has(l) || usedHere.has(l.a)));
    // notes go above the line holding their address, and above its labels; a loader part's marks above them
    const noteAddrs = [...new Set([...Object.keys(notes).map(Number).filter(noteAt), ...loaderStarts.keys(), ...loaderEnds.keys()])].filter(a => loaded(a) && fileOf(a) === fi).sort((x, y) => x - y);
    if (noteAddrs.length) {
      const withNotes: Line[] = [];
      let k = 0;
      const put = (a: Addr) => {
        for (const text of [...(loaderEnds.get(a) ?? []), ...(loaderStarts.get(a) ?? [])]) withNotes.push({ k: 'cmt', a, text, mark: true });
        if (noteAt(a)) withNotes.push(...commentLines(a, notes[a].text, !!notes[a].block, true));
      };
      for (const l of body) {
        const last = l.k === 'lbl' ? l.a : 'n' in l && l.n > 0 ? l.a + l.n - 1 : -1;
        while (k < noteAddrs.length && noteAddrs[k] <= last) put(noteAddrs[k++]);
        withNotes.push(l);
      }
      while (k < noteAddrs.length) put(noteAddrs[k++]);
      body.splice(0, body.length, ...withNotes);
    }
    usedHw.forEach(a => allUsedHw.add(a));
    const head: Line[] = [];
    const end = Math.min(0x10000, f.load + f.bytes.length);
    head.push({ k: 'cmt', a: f.load, text: `${f.name} — re-assembled by KickReasm Studio` });
    head.push({ k: 'cmt', a: f.load, text: `load ${n4(f.load)}-${n4(end - 1)} (${end - f.load} bytes)${A.entry != null && fileOf(A.entry) === fi ? ` · entry ${labelAt(A.entry) ? labelAt(A.entry)!.name : n4(A.entry)}` : ''} · Kick Assembler 5.x` });
    // the loaders found in this file (spec 8.11c); their parts are marked where they start and end
    const fileLoaders = (A.loaders ?? []).filter(l => l.parts.some(p => fileOf(p.start) === fi));
    if (fileLoaders.length) {
      head.push({ k: 'cmt', a: f.load, text: `loader${fileLoaders.length > 1 ? 's' : ''} found by KickReasm Studio (the ==== lines mark their parts):`, mark: true });
      for (const l of fileLoaders) head.push({ k: 'cmt', a: f.load, text: `  ${l.name}${l.sure === 'likely' ? ' (by its traits)' : ''}: ${l.how}`, mark: true });
    }
    if (fileExcluded.length) {
      head.push({ k: 'cmt', a: f.load, text: 'blocks left out of the build; remove the // in front of a #define to build it again:' });
      for (const x of fileExcluded) head.push({ k: 'cmt', a: f.load, text: `#define ${x.name}` });
    }
    head.push({ k: 'blank', a: f.load });
    if (S.hwInclude === 'import') head.push({ k: 'dir', a: f.load, n: 0, tok: [{ t: 'dir', s: '#import' }, { t: 'p', s: ' ' }, { t: 'str', s: '"include/c64-hardware.asm"' }] });
    else if (S.hwInclude === 'inline' && usedHw.size) {
      head.push({ k: 'cmt', a: f.load, text: 'hardware and KERNAL symbols' });
      for (const a of [...usedHw].sort((x, y) => x - y)) {
        const s = SYM.exact.get(a) || SYM.regions.find(r => r.start === a);
        if (s && !/\+/.test(s.name)) head.push({ k: 'dir', a: f.load, n: 0, tok: [{ t: 'dir', s: '.label' }, { t: 'p', s: ' ' }, { t: 'def', s: s.name }, { t: 'p', s: ' = ' }, { t: 'num', s: n4('addr' in s ? s.addr : s.start) }] });
      }
    }
    if (usedZp.size) {
      head.push({ k: 'blank', a: f.load });
      head.push({ k: 'cmt', a: f.load, text: 'zero page' });
      for (const a of [...usedZp].sort((x, y) => x - y)) {
        // the user's comment lines on a zero-page variable go above its .label line (Project.notes at its address)
        if (noteAt(a)) head.push(...commentLines(a, notes[a].text, !!notes[a].block, true).map((l): Line => ({ ...l, a: f.load, zp: a } as Line)));
        head.push({ k: 'dir', a: f.load, n: 0, zp: a, tok: [{ t: 'dir', s: '.label' }, { t: 'p', s: ' ' }, { t: 'def', s: zp.get(a)!.name, zp: a }, { t: 'p', s: ' = ' }, { t: 'num', s: n2(a) }] });
      }
    }
    if (usedExt.size) {
      head.push({ k: 'blank', a: f.load });
      head.push({ k: 'cmt', a: f.load, text: 'labels defined in other files' });
      for (const a of [...usedExt].sort((x, y) => x - y)) head.push({ k: 'dir', a: f.load, n: 0, tok: [{ t: 'dir', s: '.label' }, { t: 'p', s: ' ' }, { t: 'def', s: labelAt(a)!.name }, { t: 'p', s: ' = ' }, { t: 'num', s: n4(a) }] });
    }
    if (ctx.usedMusic.size) {
      head.push({ k: 'blank', a: f.load });
      for (const m of ctx.usedMusic) head.push({ k: 'dir', a: f.load, n: 0, tok: [{ t: 'dir', s: '.var' }, { t: 'p', s: ' ' }, { t: 'def', s: musicVar(m) }, { t: 'p', s: ' = ' }, { t: 'kw', s: 'LoadSid' }, { t: 'p', s: '(' }, { t: 'str', s: `"music/music_${h4(m.start)}.sid"` }, { t: 'p', s: ')' }] });
    }
    head.push({ k: 'blank', a: f.load });
    const lines = head.concat(body);
    while (lines.length && lines[lines.length - 1].k === 'blank') lines.pop();
    const userCmt = project.comments || {}, done = new Set<Addr>();
    for (const l of lines) {
      // a zero-page variable's comment (Project.comments at its address) goes at the end of its .label line
      const at = l.k === 'dir' && l.zp != null ? l.zp : l.a;
      if ((l.k === 'ins' || l.k === 'dat' || (l.k === 'dir' && (l.n > 0 || l.zp != null))) && userCmt[at] && !done.has(at)) { l.cmt = userCmt[at].replace(/\s*\r?\n\s*/g, ' '); l.userCmt = true; done.add(at); }
    }
    const path = `${fileNames[fi]}.asm`;
    outFiles[path] = lines.map(l => lineText(l, S)).join('\n') + '\n';
    fileLines[path] = lines;
    listing.push({ k: 'file', a: f.load, text: path, fi });
    for (const l of opts.dataAsCode ? asCode(lines) : lines) listing.push(l);
  });
  Object.assign(outFiles, binFiles);
  // with raw addresses nothing refers to the symbol file, so it is not written
  if (S.hwInclude !== 'none') outFiles['include/c64-hardware.asm'] = hardwareInclude(S);
  return { lines: listing, files: outFiles, fileLines, labels, zp, fileNames, problems, usedHw: allUsedHw, excluded: excludedAll };
}
