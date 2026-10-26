/* =====================================================================
 * KickReasm core  (@kickreasm/core in the production monorepo)
 * 6502/6510 disassembly, C64 memory heuristics, Kick Assembler
 * generation and byte-exact round-trip verification.
 * Pure functions, no DOM: runs in the renderer, a Web Worker or Node.
 * ===================================================================== */
(function (root) {
'use strict';
const KR = {};

/* ---------- helpers ---------- */
const h2 = v => (v & 0xff).toString(16).padStart(2, '0');
const h4 = v => (v & 0xffff).toString(16).padStart(4, '0');
const $2 = v => '$' + h2(v);
const $4 = v => '$' + h4(v);
const word = (m, a) => m[a & 0xffff] | (m[(a + 1) & 0xffff] << 8);
KR.h2 = h2; KR.h4 = h4; KR.$4 = $4;

/* =====================================================================
 * 1. OPCODE TABLE — all 256 opcodes.  '*' = undocumented (stable),
 *    '!' = undocumented and unstable on real hardware.
 * ===================================================================== */
const MODE_LEN = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, izx: 2, izy: 2, rel: 2, abs: 3, abx: 3, aby: 3, ind: 3 };
const OPCODE_SRC = [
  'BRK imp,ORA izx,*JAM imp,*SLO izx,*NOP zp,ORA zp,ASL zp,*SLO zp,PHP imp,ORA imm,ASL acc,*ANC imm,*NOP abs,ORA abs,ASL abs,*SLO abs',
  'BPL rel,ORA izy,*JAM imp,*SLO izy,*NOP zpx,ORA zpx,ASL zpx,*SLO zpx,CLC imp,ORA aby,*NOP imp,*SLO aby,*NOP abx,ORA abx,ASL abx,*SLO abx',
  'JSR abs,AND izx,*JAM imp,*RLA izx,BIT zp,AND zp,ROL zp,*RLA zp,PLP imp,AND imm,ROL acc,*ANC imm,BIT abs,AND abs,ROL abs,*RLA abs',
  'BMI rel,AND izy,*JAM imp,*RLA izy,*NOP zpx,AND zpx,ROL zpx,*RLA zpx,SEC imp,AND aby,*NOP imp,*RLA aby,*NOP abx,AND abx,ROL abx,*RLA abx',
  'RTI imp,EOR izx,*JAM imp,*SRE izx,*NOP zp,EOR zp,LSR zp,*SRE zp,PHA imp,EOR imm,LSR acc,*ALR imm,JMP abs,EOR abs,LSR abs,*SRE abs',
  'BVC rel,EOR izy,*JAM imp,*SRE izy,*NOP zpx,EOR zpx,LSR zpx,*SRE zpx,CLI imp,EOR aby,*NOP imp,*SRE aby,*NOP abx,EOR abx,LSR abx,*SRE abx',
  'RTS imp,ADC izx,*JAM imp,*RRA izx,*NOP zp,ADC zp,ROR zp,*RRA zp,PLA imp,ADC imm,ROR acc,*ARR imm,JMP ind,ADC abs,ROR abs,*RRA abs',
  'BVS rel,ADC izy,*JAM imp,*RRA izy,*NOP zpx,ADC zpx,ROR zpx,*RRA zpx,SEI imp,ADC aby,*NOP imp,*RRA aby,*NOP abx,ADC abx,ROR abx,*RRA abx',
  '*NOP imm,STA izx,*NOP imm,*SAX izx,STY zp,STA zp,STX zp,*SAX zp,DEY imp,*NOP imm,TXA imp,!XAA imm,STY abs,STA abs,STX abs,*SAX abs',
  'BCC rel,STA izy,*JAM imp,!AHX izy,STY zpx,STA zpx,STX zpy,*SAX zpy,TYA imp,STA aby,TXS imp,!TAS aby,!SHY abx,STA abx,!SHX aby,!AHX aby',
  'LDY imm,LDA izx,LDX imm,*LAX izx,LDY zp,LDA zp,LDX zp,*LAX zp,TAY imp,LDA imm,TAX imp,!LAX imm,LDY abs,LDA abs,LDX abs,*LAX abs',
  'BCS rel,LDA izy,*JAM imp,*LAX izy,LDY zpx,LDA zpx,LDX zpy,*LAX zpy,CLV imp,LDA aby,TSX imp,!LAS aby,LDY abx,LDA abx,LDX aby,*LAX aby',
  'CPY imm,CMP izx,*NOP imm,*DCP izx,CPY zp,CMP zp,DEC zp,*DCP zp,INY imp,CMP imm,DEX imp,*AXS imm,CPY abs,CMP abs,DEC abs,*DCP abs',
  'BNE rel,CMP izy,*JAM imp,*DCP izy,*NOP zpx,CMP zpx,DEC zpx,*DCP zpx,CLD imp,CMP aby,*NOP imp,*DCP aby,*NOP abx,CMP abx,DEC abx,*DCP abx',
  'CPX imm,SBC izx,*NOP imm,*ISC izx,CPX zp,SBC zp,INC zp,*ISC zp,INX imp,SBC imm,NOP imp,*SBC imm,CPX abs,SBC abs,INC abs,*ISC abs',
  'BEQ rel,SBC izy,*JAM imp,*ISC izy,*NOP zpx,SBC zpx,INC zpx,*ISC zpx,SED imp,SBC aby,*NOP imp,*ISC aby,*NOP abx,SBC abx,INC abx,*ISC abx',
].join(',').split(',');

// Undocumented opcodes that Kick Assembler's default _6502 CPU accepts by mnemonic.
// Everything else undocumented is emitted as .byte so the output stays byte-exact.
const KICK_ILLEGAL = new Set(['SLO', 'RLA', 'SRE', 'RRA', 'SAX', 'LAX', 'DCP', 'ISC', 'ALR', 'ARR', 'AXS', 'ANC']);
const BRANCHES = new Set(['BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BNE', 'BEQ']);
const WRITE_MN = new Set(['STA', 'STX', 'STY', 'SAX', 'AHX', 'SHX', 'SHY', 'TAS']);
const RMW_MN = new Set(['ASL', 'LSR', 'ROL', 'ROR', 'INC', 'DEC', 'SLO', 'RLA', 'SRE', 'RRA', 'DCP', 'ISC']);
const CLOBBER_A = new Set(['ADC', 'SBC', 'AND', 'ORA', 'EOR', 'PLA', 'SLO', 'RLA', 'SRE', 'RRA', 'ISC', 'ANC', 'ALR', 'ARR', 'XAA', 'LAS', 'LAX']);
const SHIFT_MN = new Set(['ASL', 'LSR', 'ROL', 'ROR']);

const OPC = OPCODE_SRC.map((src, op) => {
  let s = src, ill = false, unstable = false;
  if (s[0] === '*') { ill = true; s = s.slice(1); } else if (s[0] === '!') { ill = unstable = true; s = s.slice(1); }
  const [mn, mode] = s.split(' ');
  let flow = 'seq';
  if (mn === 'JSR') flow = 'jsr';
  else if (mn === 'JMP') flow = mode === 'ind' ? 'jmpi' : 'jmp';
  else if (mn === 'RTS' || mn === 'RTI') flow = 'ret';
  else if (mn === 'BRK') flow = 'brk';
  else if (mn === 'JAM') flow = 'jam';
  else if (BRANCHES.has(mn)) flow = 'br';
  const access = WRITE_MN.has(mn) ? 'write' : (RMW_MN.has(mn) && mode !== 'acc') ? 'rmw'
    : (MODE_LEN[mode] > 1 && mode !== 'imm' && mode !== 'rel' && flow === 'seq') ? 'read' : null;
  const kick = !ill || (!unstable && KICK_ILLEGAL.has(mn) && !(mn === 'ANC' && op !== 0x0b));
  return { op, mn, mode, len: MODE_LEN[mode], ill, unstable, jam: mn === 'JAM', flow, access, kick };
});
KR.OPC = OPC;
KR.MODE_LEN = MODE_LEN;

// Assembler encoding table: mnemonic -> mode -> opcode (documented first, then Kick-accepted illegals)
const ENC = {};
for (const pref of [false, true]) for (const o of OPC) {
  if (o.ill !== pref || !o.kick) continue;
  const m = ENC[o.mn] || (ENC[o.mn] = {});
  if (m[o.mode] === undefined) m[o.mode] = o.op;
}
ENC.ISB = ENC.ISC; ENC.ASR = ENC.ALR; ENC.SBX = ENC.AXS; ENC.LXA = undefined;
KR.ENC = ENC;

function decode(mem, pc) {
  const info = OPC[mem[pc]];
  const b1 = mem[(pc + 1) & 0xffff], b2 = mem[(pc + 2) & 0xffff];
  const v = info.len === 2 ? b1 : info.len === 3 ? (b1 | (b2 << 8)) : null;
  let target = null;
  if (info.mode === 'rel') target = (pc + 2 + ((b1 ^ 0x80) - 0x80)) & 0xffff;
  else if (v != null && info.mode !== 'imm') target = v;
  return { pc, info, v, target };
}
KR.decode = decode;

/* =====================================================================
 * 2. C64 SYMBOL DATABASE — VIC-II, SID, CIA 1/2, KERNAL, vectors, ZP
 * ===================================================================== */
const SYM = (() => {
  const exact = new Map();
  const add = (addr, name, desc, cat, size = 1, call = false) => exact.set(addr, { addr, name, desc, cat, size, call });
  for (let i = 0; i < 8; i++) {
    add(0xd000 + i * 2, `VIC_SPR${i}_X`, `Sprite ${i} X position (bits 0-7)`, 'VIC-II');
    add(0xd001 + i * 2, `VIC_SPR${i}_Y`, `Sprite ${i} Y position`, 'VIC-II');
    add(0xd027 + i, `VIC_SPR${i}_COLOR`, `Sprite ${i} color`, 'VIC-II');
  }
  [[0x10, 'SPR_X_MSB', 'Sprite X position bit 8 for all sprites'],
   [0x11, 'SCREEN_CTRL1', 'Control 1: Y-scroll, 25 rows, screen on, bitmap, ECM, raster bit 8'],
   [0x12, 'RASTER', 'Raster line (read) / raster IRQ compare line (write)'],
   [0x13, 'LIGHTPEN_X', 'Light pen X'], [0x14, 'LIGHTPEN_Y', 'Light pen Y'],
   [0x15, 'SPR_ENABLE', 'Sprite enable bits'],
   [0x16, 'SCREEN_CTRL2', 'Control 2: X-scroll, 40 columns, multicolor mode'],
   [0x17, 'SPR_EXPAND_Y', 'Sprite double height'],
   [0x18, 'MEM_SETUP', 'Memory setup: screen and charset/bitmap pointers'],
   [0x19, 'IRQ_STATUS', 'Interrupt status / acknowledge'],
   [0x1a, 'IRQ_ENABLE', 'Interrupt enable mask'],
   [0x1b, 'SPR_PRIORITY', 'Sprite to background priority'],
   [0x1c, 'SPR_MULTICOLOR', 'Sprite multicolor enable'],
   [0x1d, 'SPR_EXPAND_X', 'Sprite double width'],
   [0x1e, 'SPR_SPR_COLL', 'Sprite-sprite collision'],
   [0x1f, 'SPR_BG_COLL', 'Sprite-background collision'],
   [0x20, 'BORDER_COLOR', 'Border color'],
   [0x21, 'BG_COLOR0', 'Background color 0'], [0x22, 'BG_COLOR1', 'Background color 1'],
   [0x23, 'BG_COLOR2', 'Background color 2'], [0x24, 'BG_COLOR3', 'Background color 3'],
   [0x25, 'SPR_MC0', 'Sprite multicolor 0'], [0x26, 'SPR_MC1', 'Sprite multicolor 1'],
  ].forEach(([o, n, d]) => add(0xd000 + o, 'VIC_' + n, d, 'VIC-II'));
  for (let v = 0; v < 3; v++) {
    const b = 0xd400 + v * 7, n = v + 1;
    add(b, `SID_V${n}_FREQ_LO`, `Voice ${n} frequency low`, 'SID');
    add(b + 1, `SID_V${n}_FREQ_HI`, `Voice ${n} frequency high`, 'SID');
    add(b + 2, `SID_V${n}_PW_LO`, `Voice ${n} pulse width low`, 'SID');
    add(b + 3, `SID_V${n}_PW_HI`, `Voice ${n} pulse width high`, 'SID');
    add(b + 4, `SID_V${n}_CTRL`, `Voice ${n} control: waveform, gate, sync, ring`, 'SID');
    add(b + 5, `SID_V${n}_AD`, `Voice ${n} attack/decay`, 'SID');
    add(b + 6, `SID_V${n}_SR`, `Voice ${n} sustain/release`, 'SID');
  }
  [[0x15, 'FC_LO', 'Filter cutoff (bits 0-2)'], [0x16, 'FC_HI', 'Filter cutoff (bits 3-10)'],
   [0x17, 'RES_FILT', 'Filter resonance and voice routing'], [0x18, 'MODE_VOL', 'Filter mode and master volume'],
   [0x19, 'POT_X', 'Paddle X'], [0x1a, 'POT_Y', 'Paddle Y'],
   [0x1b, 'OSC3', 'Voice 3 oscillator output (random source)'], [0x1c, 'ENV3', 'Voice 3 envelope output'],
  ].forEach(([o, n, d]) => add(0xd400 + o, 'SID_' + n, d, 'SID'));
  const cia = (base, n, pra, prb, icr) => [
    [0, 'PRA', pra], [1, 'PRB', prb], [2, 'DDRA', 'Port A data direction'], [3, 'DDRB', 'Port B data direction'],
    [4, 'TA_LO', 'Timer A low'], [5, 'TA_HI', 'Timer A high'], [6, 'TB_LO', 'Timer B low'], [7, 'TB_HI', 'Timer B high'],
    [8, 'TOD_10TH', 'Time of day: 1/10 s'], [9, 'TOD_SEC', 'Time of day: seconds'], [10, 'TOD_MIN', 'Time of day: minutes'],
    [11, 'TOD_HR', 'Time of day: hours'], [12, 'SDR', 'Serial data register'], [13, 'ICR', icr],
    [14, 'CRA', 'Timer A control'], [15, 'CRB', 'Timer B control'],
  ].forEach(([o, r, d]) => add(base + o, `CIA${n}_${r}`, d, `CIA ${n}`));
  cia(0xdc00, 1, 'Port A: keyboard columns / joystick 2', 'Port B: keyboard rows / joystick 1', 'Interrupt control and status (IRQ)');
  cia(0xdd00, 2, 'Port A: VIC bank (bits 0-1), serial bus', 'Port B: user port', 'Interrupt control and status (NMI)');
  [[0xff81, 'CINT', 'Initialize screen editor and VIC'], [0xff84, 'IOINIT', 'Initialize I/O devices'],
   [0xff87, 'RAMTAS', 'RAM test and init'], [0xff8a, 'RESTOR', 'Restore default I/O vectors'],
   [0xff8d, 'VECTOR', 'Read/set I/O vectors'], [0xff90, 'SETMSG', 'Control KERNAL messages'],
   [0xff93, 'SECOND', 'Send secondary address after LISTEN'], [0xff96, 'TKSA', 'Send secondary address after TALK'],
   [0xff99, 'MEMTOP', 'Read/set top of memory'], [0xff9c, 'MEMBOT', 'Read/set bottom of memory'],
   [0xff9f, 'SCNKEY', 'Scan keyboard'], [0xffa2, 'SETTMO', 'Set IEEE timeout'],
   [0xffa5, 'ACPTR', 'Input byte from serial bus'], [0xffa8, 'CIOUT', 'Output byte to serial bus'],
   [0xffab, 'UNTLK', 'Send UNTALK'], [0xffae, 'UNLSN', 'Send UNLISTEN'], [0xffb1, 'LISTEN', 'Send LISTEN'],
   [0xffb4, 'TALK', 'Send TALK'], [0xffb7, 'READST', 'Read I/O status'], [0xffba, 'SETLFS', 'Set logical file parameters'],
   [0xffbd, 'SETNAM', 'Set file name (A=length, X/Y=address)'], [0xffc0, 'OPEN', 'Open logical file'],
   [0xffc3, 'CLOSE', 'Close logical file'], [0xffc6, 'CHKIN', 'Open channel for input'],
   [0xffc9, 'CHKOUT', 'Open channel for output'], [0xffcc, 'CLRCHN', 'Restore default I/O channels'],
   [0xffcf, 'CHRIN', 'Input character'], [0xffd2, 'CHROUT', 'Output character (PETSCII in A)'],
   [0xffd5, 'LOAD', 'Load file into memory'], [0xffd8, 'SAVE', 'Save memory to file'],
   [0xffdb, 'SETTIM', 'Set jiffy clock'], [0xffde, 'RDTIM', 'Read jiffy clock'], [0xffe1, 'STOP', 'Check STOP key'],
   [0xffe4, 'GETIN', 'Get character from keyboard buffer'], [0xffe7, 'CLALL', 'Close all files'],
   [0xffea, 'UDTIM', 'Update jiffy clock'], [0xffed, 'SCREEN', 'Return screen size'],
   [0xfff0, 'PLOT', 'Read/set cursor position'], [0xfff3, 'IOBASE', 'Return I/O base address'],
   [0xe544, 'CLRSCR', 'Clear screen and home cursor'], [0xe566, 'HOME', 'Cursor home'],
   [0xea31, 'IRQ_HANDLER', 'Default KERNAL IRQ handler (keyboard, jiffy clock)'],
   [0xea81, 'IRQ_EXIT', 'Restore registers and RTI'], [0xfce2, 'RESET', 'KERNAL cold start'],
   [0xfe43, 'NMI_ENTRY', 'KERNAL NMI entry'], [0xfebc, 'NMI_EXIT', 'Restore registers and RTI (NMI)'],
   [0xff48, 'IRQ_ENTRY', 'KERNAL IRQ/BRK entry'], [0xab1e, 'STROUT', 'BASIC: print null-terminated string at A/Y'],
   [0xbdcd, 'LINPRT', 'BASIC: print 16-bit integer in X/A'], [0xa474, 'READY', 'BASIC warm start (READY.)'],
  ].forEach(([a, n, d]) => add(a, n, d, a >= 0xe000 ? 'KERNAL' : 'BASIC', 1, true));
  [[0xfffa, 'NMI_VECTOR', 'Hardware NMI vector'], [0xfffc, 'RESET_VECTOR', 'Hardware reset vector'],
   [0xfffe, 'IRQ_VECTOR', 'Hardware IRQ/BRK vector']].forEach(([a, n, d]) => add(a, n, d, 'Vectors', 2));
  [[0x0314, 'CINV', 'IRQ vector (KERNAL)', 2], [0x0316, 'CBINV', 'BRK vector', 2], [0x0318, 'NMINV', 'NMI vector', 2],
   [0x031a, 'IOPEN', 'OPEN vector', 2], [0x0326, 'IBSOUT', 'CHROUT vector', 2], [0x0328, 'ISTOP', 'STOP vector', 2],
   [0x0300, 'IERROR', 'BASIC error vector', 2], [0x0302, 'IMAIN', 'BASIC warm start vector', 2],
   [0x0277, 'KEYD', 'Keyboard buffer', 10], [0x0286, 'COLOR', 'Current text color', 1],
   [0x0288, 'HIBASE', 'Screen page used by KERNAL', 1], [0x028a, 'RPTFLG', 'Key repeat mode', 1],
   [0x028d, 'SHFLAG', 'Shift/C=/CTRL key flags', 1], [0x0291, 'MODE', 'Shift+C= case switch enable', 1],
  ].forEach(([a, n, d, s]) => add(a, n, d, 'System', s));
  [[0x00, 'CPU_DDR', '6510 I/O data direction', 1], [0x01, 'CPU_PORT', '6510 port: memory configuration', 1],
   [0x2b, 'TXTTAB', 'Start of BASIC program', 2], [0x2d, 'VARTAB', 'Start of BASIC variables', 2],
   [0x90, 'STATUS', 'KERNAL I/O status', 1], [0xa0, 'TIME', 'Jiffy clock (3 bytes)', 3],
   [0xc5, 'LSTX', 'Matrix code of current key', 1], [0xc6, 'NDX', 'Keyboard buffer length', 1],
   [0xcb, 'SFDX', 'Key pressed (matrix)', 1], [0xcc, 'BLNSW', 'Cursor blink enable', 1],
   [0xd3, 'PNTR', 'Cursor column', 1], [0xd6, 'TBLX', 'Cursor row', 1],
  ].forEach(([a, n, d, s]) => add(a, n, d, 'Zero page', s));
  add(0x07f8, 'SPRITE_PTRS', 'Sprite data pointers 0-7 (default screen)', 'Screen', 8);
  const regions = [
    { name: 'SCREEN_RAM', start: 0x0400, size: 1000, desc: 'Default screen matrix', cat: 'Screen', grid: true },
    { name: 'COLOR_RAM', start: 0xd800, size: 1000, desc: 'Color RAM', cat: 'Color RAM', grid: true },
  ];
  return { exact, regions };
})();
KR.SYM = SYM;

/* Hardware/ROM symbol for an address -> { sym, off, text } or null */
function hwSymbol(addr) {
  let s = SYM.exact.get(addr);
  if (s) return { sym: s, off: 0, text: s.name };
  for (let k = 1; k < 10; k++) {
    const b = SYM.exact.get(addr - k);
    if (b && b.size > k) return { sym: b, off: k, text: `${b.name}+${k}` };
  }
  const mirror = (base, size, period) => {
    const b = base + ((addr - base) % period); const t = SYM.exact.get(b);
    if (t && b !== addr) return { sym: t, off: addr - b, text: `${t.name}+$${(addr - b).toString(16)}`, mirror: true };
    return null;
  };
  if (addr >= 0xd000 && addr < 0xd400) return mirror(0xd000, 0x400, 0x40);
  if (addr >= 0xd400 && addr < 0xd800) return mirror(0xd400, 0x400, 0x20);
  if (addr >= 0xdc00 && addr < 0xdd00) return mirror(0xdc00, 0x100, 0x10);
  if (addr >= 0xdd00 && addr < 0xde00) return mirror(0xdd00, 0x100, 0x10);
  for (const r of SYM.regions) {
    if (addr >= r.start && addr < r.start + r.size) {
      const o = addr - r.start, row = Math.floor(o / 40), col = o % 40;
      const text = r.name + (row ? `+${row}*40` : '') + (col ? `+${col}` : '');
      return { sym: { name: r.name, desc: `${r.desc} — row ${row}, column ${col}`, cat: r.cat, addr: r.start }, off: o, text };
    }
  }
  return null;
}
KR.hwSymbol = hwSymbol;
const isIO = a => a >= 0xd000 && a < 0xe000;

/* =====================================================================
 * 3. PRG LOADING & BASIC STUB
 * ===================================================================== */
KR.parsePrg = function (name, u8) {
  if (u8.length < 3) throw new Error(`${name}: too short to be a PRG (needs a 2-byte load address and data)`);
  const load = u8[0] | (u8[1] << 8);
  return { name, load, bytes: u8.slice(2) };
};

const BASIC_TOKENS = ('END FOR NEXT DATA INPUT# INPUT DIM READ LET GOTO RUN IF RESTORE GOSUB RETURN REM STOP ON WAIT LOAD SAVE VERIFY DEF POKE PRINT# PRINT CONT LIST CLR CMD SYS OPEN CLOSE GET NEW TAB( TO FN SPC( THEN NOT STEP + - * / ^ AND OR > = < SGN INT ABS USR FRE POS SQR RND LOG EXP COS SIN TAN ATN PEEK LEN STR$ VAL ASC CHR$ LEFT$ RIGHT$ MID$ GO').split(' ');

function parseBasic(mem, owner, start) {
  const lines = [];
  let a = start;
  for (let guard = 0; guard < 64; guard++) {
    if (owner[a] < 0 || owner[a + 1] < 0) return null;
    const link = word(mem, a);
    if (link === 0) {
      const end = a + 2;
      let sys = null, sysLine = null;
      for (const l of lines) {
        const i = l.toks.indexOf(0x9e);
        if (i < 0) continue;
        let j = i + 1, digits = '';
        while (l.toks[j] === 0x20 || l.toks[j] === 0x28) j++;
        while (l.toks[j] >= 0x30 && l.toks[j] <= 0x39) digits += String.fromCharCode(l.toks[j++]);
        if (digits) { sys = parseInt(digits, 10) & 0xffff; sysLine = l; break; }
      }
      const one = lines.length === 1 && lines[0];
      const upstart = !!(one && start === 0x0801 && one.num === 10 && sys != null &&
        one.toks.length === 1 + String(sys).length && one.toks[0] === 0x9e &&
        one.toks.slice(1).map(c => String.fromCharCode(c)).join('') === String(sys) && word(mem, start) === end - 2);
      return { start, end, lines, sys, sysLine, upstart };
    }
    if (link <= a + 4 || link > a + 260) return null;
    const num = word(mem, a + 2), toks = [];
    let p = a + 4;
    while (p < link - 1 && mem[p] !== 0) toks.push(mem[p++]);
    if (p !== link - 1 || mem[p] !== 0) return null;
    lines.push({ addr: a, num, toks, text: num + ' ' + toks.map(t => t >= 0x80 && t <= 0xcb ? BASIC_TOKENS[t - 0x80] : t >= 0x20 && t < 0x60 ? String.fromCharCode(t) : `{${h2(t)}}`).join('') });
    a = link;
  }
  return null;
}

/* =====================================================================
 * 4. TYPES
 * ===================================================================== */
const T = { NONE: 0, DATA: 1, CODE: 2, BASIC: 3, TEXT: 4, TABLE: 5, LOHI: 6, WORDS: 7, SPRITE: 8, CHARSET: 9, BITMAP: 10, SCREEN: 11, MUSIC: 12, FILL: 13 };
const TYPE_INFO = {
  [T.DATA]: { key: 'data', label: 'Data', group: 'data' },
  [T.CODE]: { key: 'code', label: 'Code', group: 'code' },
  [T.BASIC]: { key: 'basic', label: 'BASIC', group: 'basic' },
  [T.TEXT]: { key: 'text', label: 'Text', group: 'text' },
  [T.TABLE]: { key: 'table', label: 'Table', group: 'table' },
  [T.LOHI]: { key: 'lohi', label: 'Lo/Hi table', group: 'table' },
  [T.WORDS]: { key: 'words', label: 'Word table', group: 'table' },
  [T.SPRITE]: { key: 'sprite', label: 'Sprites', group: 'gfx' },
  [T.CHARSET]: { key: 'charset', label: 'Charset', group: 'gfx' },
  [T.BITMAP]: { key: 'bitmap', label: 'Bitmap', group: 'gfx' },
  [T.SCREEN]: { key: 'screen', label: 'Screen matrix', group: 'gfx' },
  [T.MUSIC]: { key: 'music', label: 'Music (SID)', group: 'music' },
  [T.FILL]: { key: 'fill', label: 'Fill', group: 'fill' },
};
const TYPE_BY_KEY = Object.fromEntries(Object.entries(TYPE_INFO).map(([id, i]) => [i.key, +id]));
KR.T = T; KR.TYPE_INFO = TYPE_INFO; KR.TYPE_BY_KEY = TYPE_BY_KEY;
// user-facing "Mark as" choices -> type + props
KR.MARK_AS = [
  { id: 'code', label: 'Code', key: 'C', type: T.CODE },
  { id: 'bytes', label: 'Bytes (.byte)', key: 'D', type: T.DATA },
  { id: 'words', label: 'Words (.word)', key: 'W', type: T.WORDS },
  { id: 'text', label: 'Text (PETSCII)', key: 'T', type: T.TEXT, props: { enc: 'petscii' } },
  { id: 'textsc', label: 'Text (screen codes)', type: T.TEXT, props: { enc: 'screen' } },
  { id: 'table', label: 'Table (curve/values)', type: T.TABLE, props: { sub: 'table' } },
  { id: 'sprite', label: 'Sprite data', type: T.SPRITE },
  { id: 'charset', label: 'Charset', type: T.CHARSET },
  { id: 'bitmap', label: 'Bitmap', type: T.BITMAP },
  { id: 'screen', label: 'Screen matrix', type: T.SCREEN },
  { id: 'music', label: 'Music (SID binary)', type: T.MUSIC },
  { id: 'fill', label: 'Fill', type: T.FILL },
];

KR.DEFAULT_SETTINGS = {
  // analysis
  illegal: true, detectMusic: true, detectGfx: true, detectText: true,
  // output
  mnemonicCase: 'lower', hexCase: 'lower', bytesPerRow: 8, indent: 8, commentCol: 40,
  basicUpstart: true, hwInclude: 'import', hwComments: true, musicAsSid: true, gfxBinary: true, addrComments: false,
  // toolchain (used by the Electron main process)
  javaPath: 'java', kickJar: 'C:\\C64\\KickAssembler\\KickAss.jar', vicePath: 'C:\\C64\\VICE\\bin\\x64sc.exe',
  outDir: 'out', kickArgs: '-vicesymbols -showmem', viceArgs: '-autostartprgmode 1',
};

/* =====================================================================
 * 5. ANALYSIS ENGINE
 * ===================================================================== */
const PRI = { entry: 9, irq: 8, nmi: 8, brk: 7, user: 7, sub: 6, ptr: 5, jmp: 3, branch: 2 };
const VECTORS = { 0x0314: 'irq', 0x0316: 'brk', 0x0318: 'nmi', 0xfffe: 'irq', 0xfffa: 'nmi' };
const PET_CTRL = new Set([0x05, 0x0d, 0x0e, 0x11, 0x12, 0x13, 0x1c, 0x1d, 0x1e, 0x1f, 0x81, 0x8e, 0x90, 0x91, 0x92, 0x93, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f]);

KR.analyze = function analyze(project) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const S = Object.assign({}, KR.DEFAULT_SETTINGS, project.settings || {});
  const files = project.files;
  const mem = new Uint8Array(0x10000);
  const owner = new Int16Array(0x10000).fill(-1);
  const log = [];
  const logged = new Set();
  const L = (lvl, msg, addr = null, cat = 'analysis') => {
    const key = lvl + msg; if (logged.has(key)) return; logged.add(key);
    log.push({ lvl, msg, addr, cat });
  };
  const loaded = a => a >= 0 && a < 0x10000 && owner[a] >= 0;

  // ---- 5.1 memory image ----
  files.forEach((f, i) => {
    const end = Math.min(0x10000, f.load + f.bytes.length);
    let overlap = 0;
    for (let a = f.load; a < end; a++) { if (owner[a] >= 0) overlap++; mem[a] = f.bytes[a - f.load]; owner[a] = i; }
    L('info', `Loaded ${f.name}: ${$4(f.load)}-${$4(end - 1)}, ${end - f.load} bytes`, f.load, 'load');
    if (f.load + f.bytes.length > 0x10000) L('warn', `${f.name} runs past $ffff and was truncated`, f.load, 'load');
    if (overlap) L('warn', `${f.name} overlaps ${overlap} bytes of an earlier file; the later file wins`, f.load, 'load');
  });

  // ---- 5.2 user overrides (later wins) ----
  const ov = new Uint8Array(0x10000);
  const ovList = (project.overrides || []).filter(o => o.type !== 'auto');
  const ovProps = new Map();
  for (const o of project.overrides || []) {
    for (let a = o.start; a < o.end && a < 0x10000; a++) ov[a] = o.type === 'auto' ? 0 : (TYPE_BY_KEY[o.type] || T.DATA);
    if (o.type !== 'auto') ovProps.set(o.start, o);
  }
  const forcedData = a => ov[a] !== 0 && ov[a] !== T.CODE;

  // ---- 5.3 BASIC stub ----
  const basics = [];
  files.forEach((f, i) => {
    if (f.load !== 0x0801 || ov[0x0801]) return;
    const b = parseBasic(mem, owner, 0x0801);
    if (b) {
      b.file = i; basics.push(b);
      L('ok', `BASIC stub: ${b.lines.map(l => l.text).join(' : ')}` + (b.sys != null ? ` → entry ${$4(b.sys)}` : ''), 0x0801, 'entry');
    }
  });

  // ---- 5.4 recursive-descent code tracing ----
  const insLen = new Uint8Array(0x10000);
  const codeOwner = new Int32Array(0x10000).fill(-1);
  const skip = new Set();
  const xrefs = new Map();
  const addX = (to, from, kind) => {
    to &= 0xffff; let l = xrefs.get(to);
    if (!l) xrefs.set(to, l = []);
    if (!l.some(x => x.from === from && x.kind === kind)) l.push({ from, kind });
  };
  const entryKind = new Map();
  const queue = [];
  const enqueue = (a, kind) => {
    a &= 0xffff;
    if (!loaded(a)) return;
    const k = entryKind.get(a);
    if (!k || PRI[kind] > PRI[k]) entryKind.set(a, kind);
    if (!insLen[a]) queue.push(a);
  };
  const ijumps = [];
  const inlineCalls = new Set();
  let entry = null;
  for (const b of basics) if (b.sys != null) { enqueue(b.sys, 'entry'); entry = entry ?? b.sys; }
  if (files.length && !basics.some(b => b.file === 0) && !ov[files[0].load]) {
    enqueue(files[0].load, 'entry'); entry = entry ?? files[0].load;
    L('info', `No BASIC stub in ${files[0].name}; using load address ${$4(files[0].load)} as entry point`, files[0].load, 'entry');
  }
  for (const a of project.entries || []) enqueue(a, 'user');
  for (const o of ovList) if (o.type === 'code') enqueue(o.start, 'user');

  function trace() {
    while (queue.length) {
      let pc = queue.pop();
      for (;;) {
        if (!loaded(pc)) break;
        if (insLen[pc]) break;
        if (codeOwner[pc] >= 0) {
          const s = codeOwner[pc], op = mem[s];
          if ((op === 0x2c || op === 0x24) && pc === s + 1 && !skip.has(s)) {
            skip.add(s); insLen[s] = 1;
            for (let k = 1; k < OPC[op].len; k++) codeOwner[s + k] = -1;
            L('info', `BIT-skip idiom at ${$4(s)}: $${h2(op)} hides the instruction at ${$4(pc)}`, s, 'code');
          } else {
            L('warn', `Jump into the middle of the instruction at ${$4(s)} (target ${$4(pc)}); overlapping code is not traced`, pc, 'code');
            break;
          }
        }
        if (forcedData(pc)) { L('warn', `Code path runs into user-defined data at ${$4(pc)}`, pc, 'code'); break; }
        const info = OPC[mem[pc]];
        if (info.jam) { L('err', `JAM opcode $${h2(mem[pc])} reached at ${$4(pc)}; the path probably runs into data`, pc, 'code'); break; }
        if (info.ill && !S.illegal) { L('warn', `Undocumented opcode $${h2(mem[pc])} at ${$4(pc)} stops tracing (undocumented opcodes are disabled)`, pc, 'code'); break; }
        let ok = true;
        for (let k = 1; k < info.len; k++) {
          const b = (pc + k) & 0xffff;
          if (!loaded(b) || insLen[b] || codeOwner[b] >= 0 || forcedData(b)) { ok = false; break; }
        }
        if (!ok && (mem[pc] === 0x2c || mem[pc] === 0x24) && insLen[(pc + 1) & 0xffff]) {
          skip.add(pc); insLen[pc] = 1;
          L('info', `BIT-skip idiom at ${$4(pc)}: $${h2(mem[pc])} hides the instruction at ${$4(pc + 1)}`, pc, 'code');
          break;
        }
        if (!ok) { L('warn', `Instruction at ${$4(pc)} would overlap other code or leave the file; tracing stopped`, pc, 'code'); break; }
        insLen[pc] = info.len;
        for (let k = 1; k < info.len; k++) codeOwner[(pc + k) & 0xffff] = pc;
        const d = decode(mem, pc), next = (pc + info.len) & 0xffff;
        if (info.flow === 'br') { addX(d.target, pc, 'branch'); enqueue(d.target, 'branch'); pc = next; continue; }
        if (info.flow === 'jmp') { addX(d.target, pc, 'jump'); enqueue(d.target, 'jmp'); break; }
        if (info.flow === 'jmpi') { addX(d.v, pc, 'ptr'); ijumps.push({ pc, ptr: d.v }); break; }
        if (info.flow === 'jsr') {
          addX(d.target, pc, 'call'); enqueue(d.target, 'sub');
          const t = d.target;
          if (loaded(t) && mem[t] === 0x68 && mem[(t + 1) & 0xffff] === 0x85 && mem[(t + 3) & 0xffff] === 0x68) {
            inlineCalls.add(pc);
            L('warn', `JSR ${$4(t)} pops its return address; inline data follows ${$4(next)}`, pc, 'code');
            break;
          }
          pc = next; continue;
        }
        if (info.flow === 'ret') break;
        if (info.flow === 'brk') { L('warn', `BRK at ${$4(pc)} ends the code path`, pc, 'code'); break; }
        pc = next;
      }
    }
  }

  // ---- 5.5 evidence pass: constant propagation over linear runs ----
  let writes, hints, ptrTargets, lohi, dataEv, wordPtrs, textPtrs, smc;
  const evTag = (a, tag) => { let s = dataEv.get(a); if (!s) dataEv.set(a, s = new Set()); s.add(tag); };

  function evidence() {
    writes = []; hints = new Map(); ptrTargets = new Map(); lohi = []; dataEv = new Map(); wordPtrs = new Set(); textPtrs = new Map(); smc = new Map();
    const starts = [];
    for (let a = 0; a < 0x10000; a++) if (insLen[a]) starts.push(a);
    let A = null, X = null, Y = null, recent = new Map(), idxStores = [];
    const reset = () => { A = X = Y = null; recent = new Map(); idxStores = []; };
    const clearWritten = (from, to) => {
      for (let a = from; a <= to; a++) {
        if (!insLen[a]) continue;
        const o = OPC[mem[a]];
        if (o.mn === 'LDA' || o.mn === 'TXA' || o.mn === 'TYA' || CLOBBER_A.has(o.mn) || (SHIFT_MN.has(o.mn) && o.mode === 'acc')) A = null;
        if (['LDX', 'TAX', 'TSX', 'INX', 'DEX', 'LAX', 'AXS', 'LAS'].includes(o.mn)) X = null;
        if (['LDY', 'TAY', 'INY', 'DEY'].includes(o.mn)) Y = null;
        if (o.flow === 'jsr') A = X = Y = null;
      }
    };
    let prevEnd = -1, prevBreak = true;
    const pair = (dest, lo, hi) => {
      const value = lo.v | (hi.v << 8);
      if (dest >= 0 && !VECTORS[dest] && (isIO(dest) || dest >= 0xff00 || dest < 2)) return;
      const sym = SYM.exact.get(value);
      if (loaded(value) || (sym && sym.call)) {
        hints.set(lo.src, { kind: 'lo', target: value });
        hints.set(hi.src, { kind: 'hi', target: value });
      }
      if (loaded(dest)) wordPtrs.add(dest);
      const vk = VECTORS[dest];
      if (vk && loaded(value)) { enqueue(value, vk); L('ok', `${vk.toUpperCase()} vector ${$4(dest)} set to ${$4(value)} at ${$4(lo.src)}`, lo.src, 'entry'); }
      else if (loaded(value)) ptrTargets.set(value, dest);
    };
    for (const pc of starts) {
      const xs = xrefs.get(pc);
      const isTarget = entryKind.has(pc) || (xs && xs.some(x => x.kind === 'branch' || x.kind === 'jump' || x.kind === 'call'));
      if (pc !== prevEnd || prevBreak) reset();
      else if (isTarget) {
        const flowIn = xs ? xs.filter(x => x.kind === 'branch' || x.kind === 'jump' || x.kind === 'call') : [];
        const tight = !entryKind.has(pc) || entryKind.get(pc) === 'branch';
        if (tight && flowIn.length && flowIn.every(x => x.kind === 'branch' && x.from > pc && x.from - pc <= 24)) {
          clearWritten(pc, Math.max(...flowIn.map(x => x.from)));
        } else reset();
      }
      const info = OPC[mem[pc]], d = decode(mem, pc), mn = info.mn, mode = info.mode;
      prevEnd = (pc + insLen[pc]) & 0xffff;
      prevBreak = info.flow === 'jmp' || info.flow === 'jmpi' || info.flow === 'ret' || info.flow === 'brk' || inlineCalls.has(pc);
      if (skip.has(pc)) { reset(); continue; }
      // data references
      if (info.access && d.target != null) {
        const tgt = d.target;
        const kind = (mode === 'izx' || mode === 'izy') ? 'ptr' : info.access;
        addX(tgt, pc, kind);
        if (kind === 'ptr') addX(tgt + 1, pc, 'ptr');
        if ((info.access === 'write' || info.access === 'rmw') && loaded(tgt) && (insLen[tgt] || codeOwner[tgt] >= 0)) {
          const s = insLen[tgt] ? tgt : codeOwner[tgt];
          smc.set(s, pc);
          L('info', `Self-modifying code: ${$4(pc)} writes into the instruction at ${$4(s)}`, pc, 'code');
        }
      }
      const idxOf = () => (mode === 'abx' || mode === 'aby') && loaded(d.v) && !insLen[d.v] && codeOwner[d.v] < 0 ? { t: d.v, r: mode === 'abx' ? 'x' : 'y', pc } : null;
      switch (mn) {
        case 'LDA': A = mode === 'imm' ? { v: d.v, src: pc } : (idxOf() ? { v: null, idx: idxOf() } : null); break;
        case 'LDX': X = mode === 'imm' ? { v: d.v, src: pc } : null; break;
        case 'LDY': Y = mode === 'imm' ? { v: d.v, src: pc } : null; break;
        case 'TAX': X = A && A.v != null ? { v: A.v, src: null } : null; break;
        case 'TAY': Y = A && A.v != null ? { v: A.v, src: null } : null; break;
        case 'TXA': A = X && X.v != null ? { v: X.v, src: null } : null; break;
        case 'TYA': A = Y && Y.v != null ? { v: Y.v, src: null } : null; break;
        case 'INX': case 'DEX': X = X && X.v != null ? { v: (X.v + (mn === 'INX' ? 1 : 255)) & 255, src: null } : null; break;
        case 'INY': case 'DEY': Y = Y && Y.v != null ? { v: (Y.v + (mn === 'INY' ? 1 : 255)) & 255, src: null } : null; break;
        case 'BEQ': case 'BNE': if (A && A.idx) evTag(A.idx.t, 'zt'); break;
        case 'STA': case 'STX': case 'STY': case 'SAX': {
          const R = mn === 'STA' ? A : mn === 'STX' ? X : mn === 'STY' ? Y : null;
          const dest = d.target;
          if (mode === 'zp' || mode === 'abs') {
            writes.push({ pc, dest, v: R ? R.v : null });
            if (R && R.v != null && R.src != null) {
              recent.set(dest, R);
              const lo = recent.get((dest - 1) & 0xffff), hi = recent.get((dest + 1) & 0xffff);
              if (lo && lo.src !== R.src) pair((dest - 1) & 0xffff, lo, R);
              if (hi && hi.src !== R.src) pair(dest, R, hi);
            }
            if (R && R.idx) {
              for (const s of idxStores) {
                if (s.r !== R.idx.r || s.t === R.idx.t) continue;
                if (s.dest === dest - 1) lohi.push({ lo: s.t, hi: R.idx.t, dest: dest - 1, r: s.r, pc });
                else if (s.dest === dest + 1) lohi.push({ lo: R.idx.t, hi: s.t, dest, r: s.r, pc });
              }
              idxStores.push({ dest, t: R.idx.t, r: R.idx.r });
              const t = R.idx.t;
              if (dest >= 0xd020 && dest <= 0xd02e) evTag(t, 'color');
              else if (dest >= 0xd000 && dest <= 0xd00f) evTag(t, 'spritepos');
              else if (dest === 0xd012) evTag(t, 'raster');
              else if (dest >= 0xd400 && dest <= 0xd418) evTag(t, 'sid');
              else if (dest === 0xd016 || dest === 0xd011) evTag(t, 'scroll');
            }
          } else if (R && R.idx && (mode === 'abx' || mode === 'aby')) {
            if (dest >= 0x0400 && dest < 0x0800 && !loaded(dest)) evTag(R.idx.t, 'screen');
            else if (dest >= 0xd800 && dest < 0xdc00) evTag(R.idx.t, 'colorram');
          } else if (R && R.v != null && (mode === 'abx' || mode === 'aby')) {
            writes.push({ pc, dest, v: R.v, indexed: true });
          }
          break;
        }
        case 'JSR': {
          const t = d.target;
          if (t === 0xffd2 && A && A.idx) evTag(A.idx.t, 'petscii');
          if (t === 0xab1e && A && A.v != null && A.src != null && Y && Y.v != null && Y.src != null) {
            pair(-1, A, Y); const v = A.v | (Y.v << 8); if (loaded(v)) { textPtrs.set(v, 'petscii'); ptrTargets.delete(v); }
          }
          if (t === 0xffbd && X && X.v != null && X.src != null && Y && Y.v != null && Y.src != null) {
            pair(-1, X, Y); const v = X.v | (Y.v << 8); if (loaded(v)) { textPtrs.set(v, 'petscii'); ptrTargets.delete(v); }
          }
          A = X = Y = null; break;
        }
        default:
          if (CLOBBER_A.has(mn) || (SHIFT_MN.has(mn) && mode === 'acc')) A = null;
          if (mn === 'TSX' || mn === 'AXS' || mn === 'LAS' || mn === 'LAX') X = null;
          if (mn === 'LAX') A = null;
      }
    }
  }

  // ---- 5.6 resolve lo/hi pointer tables, indirect jumps; iterate until stable ----
  const lohiTabs = new Map();
  function resolveTables() {
    let added = 0;
    for (const p of lohi) {
      if (lohiTabs.has(p.lo)) continue;
      const runLen = t => { let n = 0; while (n < 256 && loaded(t + n) && !insLen[t + n] && codeOwner[t + n] < 0 && !(n > 0 && (t + n === p.lo || t + n === p.hi))) n++; return n; };
      const len = Math.min(runLen(p.lo), runLen(p.hi));
      if (!len) continue;
      let hits = 0;
      const targets = [];
      for (let i = 0; i < len; i++) { const v = mem[p.lo + i] | (mem[p.hi + i] << 8); targets.push(v); if (loaded(v)) hits++; }
      const isPtr = hits >= Math.max(1, Math.ceil(len * 0.75));
      let useLen = len;
      if (isPtr) { useLen = 0; while (useLen < len && loaded(targets[useLen])) useLen++; }
      const viaJmp = ijumps.some(j => j.ptr === p.dest);
      const vk = VECTORS[p.dest];
      const t = { lo: p.lo, hi: p.hi, len: useLen, ptr: isPtr, dest: p.dest, code: isPtr && (viaJmp || !!vk), targets: targets.slice(0, useLen) };
      lohiTabs.set(p.lo, Object.assign({ part: 'lo', partner: p.hi }, t));
      lohiTabs.set(p.hi, Object.assign({ part: 'hi', partner: p.lo }, t));
      L(isPtr ? 'ok' : 'info', `${isPtr ? 'Pointer' : 'Lo/hi value'} table pair: lo ${$4(p.lo)} / hi ${$4(p.hi)}, ${useLen} entries` + (t.code ? (vk ? ` (${vk.toUpperCase()} handlers)` : ` (jump table via (${$2(p.dest)}))`) : ''), p.lo, 'data');
      if (isPtr) for (const v of t.targets) {
        if (t.code) { enqueue(v, vk || 'ptr'); added++; } else ptrTargets.set(v, p.dest);
      }
    }
    return added;
  }

  for (let iter = 0; iter < 8; iter++) {
    trace(); evidence();
    resolveTables();
    if (!queue.length) break;
  }
  trace(); evidence();
  for (const j of ijumps) {
    if (![...lohiTabs.values()].some(t => t.dest === j.ptr && t.code) && !VECTORS[j.ptr])
      L('warn', `Indirect JMP (${$4(j.ptr)}) at ${$4(j.pc)}: target unknown at analysis time`, j.pc, 'code');
  }

  // ---- 5.7 forced code (user "mark as code"): linear sweep ----
  for (const o of ovList) {
    if (o.type !== 'code') continue;
    let a = o.start;
    while (a < o.end) {
      if (insLen[a]) { a += insLen[a]; continue; }
      const info = OPC[mem[a]];
      let ok = loaded(a + info.len - 1) && a + info.len <= o.end;
      for (let k = 1; ok && k < info.len; k++) if (insLen[a + k] || codeOwner[a + k] >= 0) ok = false;
      if (!ok) break;
      insLen[a] = info.len; for (let k = 1; k < info.len; k++) codeOwner[a + k] = a;
      a += info.len;
    }
  }
  evidence();

  // ---- 5.8 music detection ----
  const music = [];
  const subgraph = (starts) => {
    const seen = new Set(), stack = [...starts];
    while (stack.length) {
      const pc = stack.pop();
      if (seen.has(pc) || !insLen[pc] || seen.size > 4096) continue;
      seen.add(pc);
      const o = OPC[mem[pc]], d = decode(mem, pc), next = (pc + insLen[pc]) & 0xffff;
      if (skip.has(pc)) { stack.push(next); continue; }
      if (o.flow === 'seq' || o.flow === 'br' || o.flow === 'jsr') stack.push(next);
      if (o.flow === 'br' || o.flow === 'jmp' || o.flow === 'jsr') stack.push(d.target);
    }
    return seen;
  };
  if (S.detectMusic) {
    for (let a = 0; a < 0xfffa; a++) {
      if (!(insLen[a] === 3 && mem[a] === 0x4c && insLen[a + 3] === 3 && mem[a + 3] === 0x4c)) continue;
      if (music.some(m => a >= m.start && a < m.end)) continue;
      const t1 = word(mem, a + 1), t2 = word(mem, a + 4);
      const sub = subgraph([t1, t2]);
      if (sub.size < 4) continue;
      let score = 2;
      const why = ['JMP init / JMP play table'];
      const outside = x => x.from < a || x.from > a + 0x2000;
      const callsA = (xrefs.get(a) || []).filter(x => x.kind === 'call' && outside(x)).length;
      const callsB = (xrefs.get(a + 3) || []).filter(x => x.kind === 'call' && outside(x)).length;
      if (callsA && callsB) { score += 2; why.push('init and play both called from outside'); }
      else if (callsA || callsB) { score += 1; why.push('called from outside'); }
      if ((a & 0xff) === 0) { score += 1; why.push('page aligned'); }
      const regs = new Set();
      let hi = a + 6;
      for (const pc of sub) {
        hi = Math.max(hi, pc + insLen[pc]);
        const o = OPC[mem[pc]], d = decode(mem, pc);
        if ((o.access === 'write' || o.access === 'rmw') && d.target != null && d.target >= 0xd400 && d.target <= 0xd41c) {
          regs.add(d.target);
          if (o.mode === 'abx' || o.mode === 'aby') { regs.add(d.target + 1); regs.add(d.target + 2); }
        }
        if (o.access && d.target != null && loaded(d.target) && d.target > hi && d.target < a + 0x2000) hi = Math.max(hi, d.target + 1);
      }
      if (regs.size >= 4) { score += 3; why.push(`writes ${regs.size} SID registers`); }
      else if (regs.size >= 1) score += 1;
      if (score < 5) continue;
      let foreign = 0;
      for (let p = a; p < hi; p++) if (insLen[p] && !sub.has(p) && !skip.has(p)) foreign++;
      if (foreign > 8) continue;
      const refFromOutside = p => (xrefs.get(p) || []).some(x => x.from < a || x.from >= hi);
      let e = hi;
      while (e < 0x10000 && loaded(e) && !insLen[e] && codeOwner[e] < 0 && !refFromOutside(e) && e - a < 0x3000 && !forcedData(e)) {
        let z = 0; while (z < 32 && mem[e + z] === mem[e] && loaded(e + z)) z++;
        if (z >= 32) break;
        e++;
      }
      const m = { start: a, end: e, init: a, play: a + 3, sidRegs: regs.size, score, why, file: owner[a] };
      music.push(m);
      L('ok', `Music detected at ${$4(a)}-${$4(e - 1)} (score ${score}: ${why.join(', ')})`, a, 'music');
    }
  }
  for (const o of ovList) if (o.type === 'music' && !music.some(m => m.start === o.start))
    music.push({ start: o.start, end: o.end, init: o.props?.init ?? o.start, play: o.props?.play ?? o.start + 3, sidRegs: 0, score: 0, why: ['marked by user'], file: owner[o.start], user: true });

  // ---- 5.9 VIC-II evidence: banks, $d018, sprite pointers ----
  const vic = { banks: new Set(), d018: new Set(), bitmap: false, multicolor: false, sprites: [] };
  for (const w of writes) {
    if (w.v == null) continue;
    if (w.dest === 0xdd00) vic.banks.add(3 - (w.v & 3));
    if (w.dest === 0xd018) vic.d018.add(w.v);
    if (w.dest === 0xd011 && (w.v & 0x20)) vic.bitmap = true;
    if (w.dest === 0xd016 && (w.v & 0x10)) vic.multicolor = true;
  }
  if (!vic.banks.size) vic.banks.add(0);
  const gfx = [];
  const romChars = (bank, a) => (bank === 0 || bank === 2) && (a & 0x3fff) >= 0x1000 && (a & 0x3fff) < 0x2000;
  const screens = new Set([0x0400]);
  for (const bank of vic.banks) {
    const bb = bank * 0x4000;
    for (const v of vic.d018) {
      const scr = bb + ((v >> 4) & 15) * 0x400;
      screens.add(scr);
      if (vic.bitmap) gfx.push({ type: T.BITMAP, start: bb + ((v >> 3) & 1) * 0x2000, size: 8000, why: `$d011 bitmap mode + $d018=${$2(v)}` });
      else {
        const cs = bb + ((v >> 1) & 7) * 0x800;
        if (!romChars(bank, cs)) gfx.push({ type: T.CHARSET, start: cs, size: 2048, why: `$d018=${$2(v)} selects charset at ${$4(cs)}` });
      }
      if (scr !== 0x0400 && loaded(scr)) gfx.push({ type: T.SCREEN, start: scr, size: 1000, why: `$d018=${$2(v)} selects screen at ${$4(scr)}` });
    }
    for (const w of writes) {
      if (w.v == null) continue;
      for (const scr of screens) {
        if ((scr & 0xc000) !== bb) continue;
        if (w.dest >= scr + 0x3f8 && w.dest <= scr + 0x3ff) {
          const sa = bb + w.v * 64;
          vic.sprites.push({ n: w.dest - scr - 0x3f8, ptr: w.v, addr: sa });
          gfx.push({ type: T.SPRITE, start: sa, size: 64, why: `sprite pointer ${$4(w.dest)} = ${$2(w.v)}` });
        }
      }
    }
  }

  // ---- 5.10 classification map ----
  const tm = new Uint8Array(0x10000);
  const props = new Map();
  for (let a = 0; a < 0x10000; a++) if (owner[a] >= 0) tm[a] = T.DATA;
  for (const b of basics) for (let a = b.start; a < b.end; a++) tm[a] = T.BASIC;
  for (let a = 0; a < 0x10000; a++) if (insLen[a] || codeOwner[a] >= 0) tm[a] = T.CODE;
  for (const m of music) for (let a = m.start; a < m.end; a++) tm[a] = T.MUSIC;
  const gfxBlocks = [];
  if (S.detectGfx) {
    const merged = new Map();
    for (const g of gfx) {
      const k = g.type + ':' + g.start;
      if (!merged.has(k)) merged.set(k, g);
    }
    for (const g of [...merged.values()].sort((x, y) => x.start - y.start)) {
      let n = 0;
      for (let a = g.start; a < g.start + g.size && a < 0x10000; a++) if (tm[a] === T.DATA) { tm[a] = g.type; n++; }
      if (n) { gfxBlocks.push(g); L('ok', `${TYPE_INFO[g.type].label} at ${$4(g.start)} (${g.why})`, g.start, 'gfx'); }
    }
  }
  for (let a = 0; a < 0x10000; a++) if (ov[a] && owner[a] >= 0 && ov[a] !== T.CODE) tm[a] = ov[a];

  // ---- 5.11 data objects & classification of remaining data ----
  const offsetOf = new Map();
  for (const p of wordPtrs) offsetOf.set((p + 1) & 0xffff, p);
  for (const j of ijumps) if (loaded(j.ptr)) offsetOf.set(j.ptr + 1, j.ptr);
  const refTargets = new Set();
  for (const [to, l] of xrefs) if (loaded(to) && l.some(x => x.kind !== 'branch' && x.kind !== 'jump' && x.kind !== 'call') && !offsetOf.has(to)) refTargets.add(to);
  const objStarts = new Set([...refTargets, ...ptrTargets.keys(), ...textPtrs.keys(), ...lohiTabs.keys()]);
  const written = a => (xrefs.get(a) || []).some(x => x.kind === 'write' || x.kind === 'rmw');
  const indexedRef = a => (xrefs.get(a) || []).some(x => { const o = OPC[mem[x.from]]; return o.mode === 'abx' || o.mode === 'aby'; });

  const blocks = [];
  const pushBlock = (start, end, type, p = {}, conf = 1, reason = '') => { if (end > start) blocks.push({ start, end, type, props: p, conf, reason, file: owner[start] }); };
  const validChar = (b, enc) => enc === 'petscii' ? ((b >= 0x20 && b <= 0x5f) || PET_CTRL.has(b) || (b >= 0xc1 && b <= 0xda)) : (b >= 0x01 && b <= 0x3f) || (b >= 0x41 && b <= 0x5a);
  const textLen = (s, e, enc) => {
    let n = 0;
    while (s + n < e) { const b = mem[s + n]; if (b === 0) { n++; break; } if (!validChar(b, enc)) break; n++; }
    return n;
  };
  const smooth = (s, n) => {
    if (n < 16) return false;
    let min = 255, max = 0, sum = 0, ch = 0, psg = 0, maxd = 0;
    for (let i = 0; i < n; i++) {
      const v = mem[s + i]; min = Math.min(min, v); max = Math.max(max, v);
      if (i) { const dd = v - mem[s + i - 1]; sum += Math.abs(dd); maxd = Math.max(maxd, Math.abs(dd)); if (dd) { const sg = Math.sign(dd); if (psg && sg !== psg) ch++; psg = sg; } }
    }
    const range = max - min;
    return range >= 8 && sum / (n - 1) <= range / 6 && ch <= Math.max(3, n / 24) && maxd <= range / 3 + 1;
  };
  const glyphLike = (s, n) => {
    let good = 0; const cells = Math.floor(n / 8);
    for (let c = 0; c < cells; c++) {
      let zeros = 0; const d = new Set();
      for (let i = 0; i < 8; i++) { const b = mem[s + c * 8 + i]; if (!b) zeros++; d.add(b); }
      if (d.size <= 6) good++;
      void zeros;
    }
    return cells && good / cells > 0.8;
  };
  const classifySpan = (s, e, isObj) => {
    if (e <= s) return;
    const ev = dataEv.get(s) || new Set();
    const lt = lohiTabs.get(s);
    if (isObj && lt) {
      const n = Math.min(lt.len, e - s);
      if (n > 0) { pushBlock(s, s + n, T.LOHI, { part: lt.part, partner: lt.partner, ptr: lt.ptr, code: lt.code }, 0.95, `indexed loads stored to ${$4(lt.dest)}/${$4(lt.dest + 1)}`); classifySpan(s + n, e, false); return; }
    }
    const enc = textPtrs.get(s) || (ev.has('petscii') ? 'petscii' : ev.has('screen') ? 'screen' : null);
    if (isObj && enc && S.detectText) {
      const n = textLen(s, e, enc);
      if (n >= 2) { pushBlock(s, s + n, T.TEXT, { enc }, 0.9, enc === 'petscii' ? 'printed through KERNAL/BASIC output' : 'copied to screen memory'); classifySpan(s + n, e, false); return; }
    }
    // fill runs
    let a = s;
    const first = mem[s];
    let same = true; for (let i = s; i < e; i++) if (mem[i] !== first) { same = false; break; }
    if (same && (e - s) >= (isObj ? 8 : 3)) { pushBlock(s, e, T.FILL, { value: first }, 0.9, `${e - s} × ${$2(first)}`); return; }
    for (let i = s + 1; i < e; i++) {
      let z = 0; while (i + z < e && mem[i + z] === mem[i]) z++;
      if (z >= 32) { classifySpan(s, i, isObj); pushBlock(i, i + z, T.FILL, { value: mem[i] }, 0.9, `${z} × ${$2(mem[i])}`); classifySpan(i + z, e, false); return; }
      i += Math.max(0, z - 1);
    }
    void a;
    const n = e - s;
    if (ev.has('color') || ev.has('colorram')) { let ok = true; for (let i = s; i < e; i++) if (mem[i] > 15) { ok = false; break; } if (ok) { pushBlock(s, e, T.TABLE, { sub: 'colors' }, 0.85, 'loaded and stored to VIC color registers'); return; } }
    if (smooth(s, n)) { pushBlock(s, e, T.TABLE, { sub: 'sine' }, ev.size ? 0.9 : 0.7, ev.has('spritepos') ? 'smooth curve used for sprite positions' : 'smooth curve (sine/ramp)'); return; }
    if (isObj && n >= 4 && n % 2 === 0 && n <= 128) {
      let ok = true; for (let i = s; i < e; i += 2) if (!insLen[word(mem, i)]) { ok = false; break; }
      if (ok) { pushBlock(s, e, T.WORDS, { code: true }, 0.8, 'every word points at an instruction'); return; }
    }
    if (!isObj && S.detectText && n >= 8) {
      let letters = 0, bad = 0;
      for (let i = s; i < e; i++) { const b = mem[i]; if ((b >= 0x41 && b <= 0x5a) || b === 0x20) letters++; else if (!validChar(b, 'petscii') && b !== 0) bad++; }
      if (bad === 0 && letters / n > 0.6) { pushBlock(s, e, T.TEXT, { enc: 'petscii' }, 0.5, 'looks like PETSCII text'); return; }
    }
    if (S.detectGfx && !refInside(s, e)) {
      if (n >= 7990 && (s & 0x1fff) === 0) { pushBlock(s, s + Math.min(n, 8000), T.BITMAP, {}, 0.5, '8000 bytes at an 8K boundary'); classifySpan(s + Math.min(n, 8000), e, false); return; }
      if (n >= 2048 && (s & 0x7ff) === 0 && glyphLike(s, 2048)) { pushBlock(s, s + 2048, T.CHARSET, {}, 0.5, '2048 glyph-like bytes at a 2K boundary'); classifySpan(s + 2048, e, false); return; }
    }
    const isVar = isObj && written(s) && n <= 4;
    pushBlock(s, e, T.DATA, { var: isVar, indexed: isObj && indexedRef(s) }, isObj ? 0.75 : 0.3, isVar ? 'read and written by code' : isObj ? 'referenced by code' : 'not referenced by any traced code');
  };
  const refInside = (s, e) => { for (let a = s + 1; a < e; a++) if (objStarts.has(a)) return true; return false; };

  // walk the map
  const routineKinds = new Set(['entry', 'irq', 'nmi', 'brk', 'user', 'sub', 'ptr']);
  let a = 0;
  while (a < 0x10000) {
    const t = tm[a];
    if (!t) { a++; continue; }
    let e = a + 1;
    const fileA = owner[a];
    if (t === T.CODE) {
      while (e < 0x10000 && tm[e] === T.CODE && owner[e] === fileA && !(insLen[e] && routineKinds.has(entryKind.get(e)))) e++;
      pushBlock(a, e, T.CODE, {}, 1, entryKind.get(a) ? `entry: ${entryKind.get(a)}` : 'reached by code flow');
    } else if (t === T.DATA) {
      while (e < 0x10000 && tm[e] === T.DATA && owner[e] === fileA) e++;
      // split at object starts
      const cuts = [a];
      for (let p = a + 1; p < e; p++) if (objStarts.has(p)) cuts.push(p);
      cuts.push(e);
      for (let i = 0; i < cuts.length - 1; i++) classifySpan(cuts[i], cuts[i + 1], objStarts.has(cuts[i]));
    } else {
      while (e < 0x10000 && tm[e] === t && owner[e] === fileA && !(ovProps.has(e) && e !== a)) e++;
      const o = ovProps.get(a);
      const p = Object.assign({}, o ? o.props : {});
      if (t === T.TEXT && !p.enc) p.enc = 'petscii';
      if (t === T.FILL) p.value = mem[a];
      if (t === T.MUSIC) { const m = music.find(x => x.start === a); if (m) Object.assign(p, { init: m.init, play: m.play }); }
      const g = gfxBlocks.find(x => x.start === a);
      pushBlock(a, e, t, p, o ? 1 : g ? 0.9 : 1, o ? 'user override' : g ? g.why : t === T.BASIC ? 'BASIC program lines' : t === T.MUSIC ? 'SID player heuristics' : '');
    }
    a = e;
  }
  // mark user blocks, keep block types in sync with tm for split blocks
  for (const b of blocks) {
    b.user = !!(ov[b.start] && (ov[b.start] === b.type || (b.type === T.CODE && ov[b.start] === T.CODE)));
    for (let p = b.start; p < b.end; p++) tm[p] = b.type;
    const o = ovProps.get(b.start); if (o && o.props) b.props = Object.assign({}, b.props, o.props);
  }
  blocks.sort((x, y) => x.start - y.start);
  // adjacent small variables read better as one "Variables" block with a label per variable
  for (let i = 1; i < blocks.length; i++) {
    const p = blocks[i - 1], c = blocks[i];
    if (p.type === T.DATA && c.type === T.DATA && p.props.var && c.props.var && p.end === c.start && p.file === c.file && !p.user && !c.user) {
      p.end = c.end; blocks.splice(i, 1); i--;
    }
  }
  blocks.forEach((b, i) => { b.id = i; });

  // ---- 5.12 automatic labels ----
  const labels = new Map();
  const setLabel = (addr, name, kind) => { if (!labels.has(addr)) labels.set(addr, { name, kind }); };
  const blockAt = addr => { let lo = 0, hi = blocks.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (blocks[m].end <= addr) lo = m + 1; else if (blocks[m].start > addr) hi = m - 1; else return blocks[m]; } return null; };
  for (const b of basics) if (b.sys != null) setLabel(b.sys, 'start', 'entry');
  const kindPrefix = { entry: 'entry', irq: 'irq', nmi: 'nmi', brk: 'brk', user: 'code', sub: 'sub', ptr: 'fx' };
  for (const [addr, kind] of [...entryKind].sort((x, y) => PRI[y[1]] - PRI[x[1]])) {
    if (!insLen[addr] || tm[addr] === T.MUSIC) continue;
    if (kind === 'branch' || kind === 'jmp') continue;
    setLabel(addr, kind === 'entry' && addr === entry ? 'start' : `${kindPrefix[kind]}_${h4(addr)}`, kind);
  }
  for (const [to, l] of xrefs) {
    if (!insLen[to] || labels.has(to) || tm[to] === T.MUSIC) continue;
    const fl = l.filter(x => (x.kind === 'branch' || x.kind === 'jump') && x.from !== to);
    if (!fl.length) continue;
    const back = fl.some(x => x.kind === 'branch' && x.from >= to), fwd = fl.some(x => x.kind === 'branch' && x.from < to);
    const jmp = fl.some(x => x.kind === 'jump');
    setLabel(to, `${jmp || (back && fwd) ? 'l' : back ? 'loop' : 'skip'}_${h4(to)}`, 'branch');
  }
  for (const s of smc.keys()) if (tm[s] !== T.MUSIC) setLabel(s, `smc_${h4(s)}`, 'smc');
  const dataName = (addr) => {
    const b = blockAt(addr);
    if (!b) return `data_${h4(addr)}`;
    const p = b.props;
    switch (b.type) {
      case T.TEXT: return `txt_${h4(addr)}`;
      case T.TABLE: return `${p.sub === 'sine' ? 'sine' : p.sub === 'colors' ? 'colors' : 'tbl'}_${h4(addr)}`;
      case T.LOHI: return `${p.ptr ? 'ptr' : 'tbl'}${p.part}_${h4(addr)}`;
      case T.WORDS: return `ptrs_${h4(addr)}`;
      case T.SPRITE: return `spr_${h4(addr)}`;
      case T.CHARSET: return `charset_${h4(addr)}`;
      case T.BITMAP: return `bitmap_${h4(addr)}`;
      case T.SCREEN: return `screen_${h4(addr)}`;
      case T.FILL: return `buf_${h4(addr)}`;
      case T.CODE: return `l_${h4(addr)}`;
      default: return `${written(addr) ? 'var' : indexedRef(addr) ? 'tbl' : 'data'}_${h4(addr)}`;
    }
  };
  for (const addr of [...objStarts].sort((x, y) => x - y)) {
    if (!loaded(addr) || tm[addr] === T.MUSIC || codeOwner[addr] >= 0) continue;
    setLabel(addr, dataName(addr), 'data');
  }
  for (const b of blocks) {
    if (b.type === T.LOHI || b.type === T.TEXT || b.type === T.SPRITE || b.type === T.CHARSET || b.type === T.BITMAP || b.type === T.SCREEN || b.type === T.TABLE || b.type === T.WORDS || (b.type === T.CODE && b.user)) setLabel(b.start, dataName(b.start), 'data');
  }
  for (const b of blocks) if (b.type === T.SPRITE) for (let s = b.start + 64; s < b.end; s += 64) if (vic.sprites.some(x => x.addr === s)) setLabel(s, `spr_${h4(s)}`, 'data');
  // zero-page variables
  const zp = new Map();
  for (const [to, l] of xrefs) {
    if (to >= 0x100 || loaded(to)) continue;
    if (!l.some(x => x.kind !== 'branch' && x.kind !== 'jump' && x.kind !== 'call')) continue;
    if (hwSymbol(to)) continue;
    const isPtr = l.some(x => x.kind === 'ptr') || wordPtrs.has(to);
    zp.set(to, { name: `${isPtr ? 'ptr' : 'zp'}_${h2(to)}`, ptr: isPtr });
  }
  for (const p of wordPtrs) if (p < 0x100 && !loaded(p) && !hwSymbol(p)) { zp.set(p, { name: `ptr_${h2(p)}`, ptr: true }); if (zp.get(p + 1) && !zp.get(p + 1).user) zp.set(p + 1, { name: `ptr_${h2(p)}`, ptr: true, off: 1 }); }
  for (const j of ijumps) if (j.ptr < 0x100 && !hwSymbol(j.ptr)) { zp.set(j.ptr, { name: `ptr_${h2(j.ptr)}`, ptr: true }); zp.set(j.ptr + 1, { name: `ptr_${h2(j.ptr)}`, ptr: true, off: 1 }); }

  // ---- 5.13 heuristics: unreached code islands, compression ----
  for (const b of blocks) {
    if (b.type !== T.DATA || b.end - b.start < 12) continue;
    let p = b.start, n = 0, end = false;
    while (p < b.end && n < 64) {
      const o = OPC[mem[p]];
      if (o.ill || p + o.len > b.end) break;
      n++; p += o.len;
      if (o.flow === 'ret' || o.flow === 'jmp') { end = true; break; }
    }
    if (end && n >= 6) { b.hint = 'code'; L('hint', `Possible unreached code at ${$4(b.start)} (${n} valid instructions ending in ${OPC[mem[p - OPC[mem[p - 1]].len]]?.mn || 'RTS'}). Select it and press C to disassemble.`, b.start, 'data'); }
  }
  const entropy = (s, e) => { const c = new Uint32Array(256); for (let i = s; i < e; i++) c[mem[i]]++; let H = 0; const n = e - s; for (const k of c) if (k) { const p = k / n; H -= p * Math.log2(p); } return H; };
  for (const b of blocks) b.entropy = entropy(b.start, b.end);
  let dataBytes = 0, dataH = 0;
  for (const b of blocks) if (b.type === T.DATA && b.end - b.start >= 256) { dataBytes += b.end - b.start; dataH += b.entropy * (b.end - b.start); }
  if (dataBytes >= 2048 && dataH / dataBytes > 7.2) L('warn', `Unclassified data has very high entropy (${(dataH / dataBytes).toFixed(2)} bits/byte). The program is probably crunched; unpack it (for example with unp64) and load the result.`, null, 'data');

  // ---- 5.14 statistics ----
  const stats = { mn: {}, modes: {}, illegal: 0, illegalList: [], ins: 0, bytesByType: {}, codeBytes: 0, total: 0, xrefs: 0, entries: entryKind.size, labels: labels.size };
  for (let p = 0; p < 0x10000; p++) {
    if (owner[p] >= 0) { stats.total++; stats.bytesByType[tm[p]] = (stats.bytesByType[tm[p]] || 0) + 1; }
    if (!insLen[p] || skip.has(p)) continue;
    const o = OPC[mem[p]];
    stats.ins++; stats.mn[o.mn] = (stats.mn[o.mn] || 0) + 1; stats.modes[o.mode] = (stats.modes[o.mode] || 0) + 1;
    if (o.ill) { stats.illegal++; if (stats.illegalList.length < 100) stats.illegalList.push(p); }
  }
  for (const l of xrefs.values()) stats.xrefs += l.length;
  stats.ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
  const codeCount = stats.bytesByType[T.CODE] || 0;
  L('ok', `Analysis finished in ${stats.ms.toFixed(1)} ms: ${stats.ins} instructions, ${blocks.length} blocks, ${labels.size} labels, ${stats.xrefs} cross-references, ${Math.round(100 * codeCount / Math.max(1, stats.total))}% code`, null, 'analysis');

  return { S, files, mem, owner, insLen, codeOwner, skip, xrefs, entryKind, entry, basics, music, vic, gfx: gfxBlocks, tm, blocks, labels, zp, hints, smc, offsetOf, lohiTabs, ijumps, inlineCalls, log, stats, blockAt, textPtrs };
};

/* =====================================================================
 * 6. RENDERING — one line model drives both the listing view and the
 *    Kick Assembler export (single source of truth).
 * ===================================================================== */
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
KR.validLabel = (name) => ID_RE.test(name) && !ENC[name.toUpperCase()] && name.length <= 64;

KR.render = function render(A, project) {
  const S = A.S;
  const up = S.hexCase === 'upper';
  const hx = (v, w) => { const s = v.toString(16).padStart(w, '0'); return up ? s.toUpperCase() : s; };
  const n2 = v => '$' + hx(v & 0xff, 2), n4 = v => '$' + hx(v & 0xffff, 4);
  const mnc = m => S.mnemonicCase === 'upper' ? m : m.toLowerCase();
  const loaded = a => a >= 0 && a < 0x10000 && A.owner[a] >= 0;
  const { mem, insLen, codeOwner } = A;

  // final labels: auto + user (user wins)
  const labels = new Map();
  for (const [a, l] of A.labels) labels.set(a, { name: l.name, kind: l.kind, user: false });
  for (const [k, name] of Object.entries(project.labels || {})) { const a = +k; if (name) labels.set(a, { name, kind: (labels.get(a) || {}).kind || 'user', user: true }); else labels.delete(a); }
  const zp = new Map(A.zp);
  for (const [a, l] of labels) if (a < 0x100 && !loaded(a) && l.user) { zp.set(a, { name: l.name, user: true }); labels.delete(a); }
  const labelAt = a => labels.get(a);
  const fileOf = a => A.owner[a];
  const musicFor = a => S.musicAsSid ? A.music.find(m => a >= m.start && a < m.end) : null;
  const musicVar = m => A.music.length > 1 ? `music_${h4(m.start)}` : 'music';
  const blocksSorted = A.blocks;

  // duplicate label detection
  const byName = new Map(); const dupes = new Set();
  for (const [a, l] of labels) { if (byName.has(l.name) && byName.get(l.name) !== a) dupes.add(l.name); byName.set(l.name, a); }

  function addrTokens(a, ctx) {
    a &= 0xffff;
    const m = musicFor(a);
    if (m) {
      const v = musicVar(m);
      ctx.usedMusic && ctx.usedMusic.add(m);
      if (a === m.init) return [{ t: 'kw', s: `${v}.init`, to: a }];
      if (a === m.play) return [{ t: 'kw', s: `${v}.play`, to: a }];
      return [{ t: 'kw', s: `${v}.location`, to: m.start }, { t: 'p', s: '+' }, { t: 'num', s: n4(a - m.start) }];
    }
    const lb = labelAt(a);
    if (lb && loaded(a)) { ctx.useLabel && ctx.useLabel(a); return [{ t: 'lbl', s: lb.name, to: a }]; }
    if (loaded(a)) {
      const base = A.offsetOf.get(a);
      if (base != null && labelAt(base)) { ctx.useLabel && ctx.useLabel(base); return [{ t: 'lbl', s: labelAt(base).name, to: base }, { t: 'p', s: '+' }, { t: 'num', s: '1' }]; }
      const s = codeOwner[a] >= 0 ? codeOwner[a] : -1;
      if (s >= 0 && labelAt(s)) { ctx.useLabel && ctx.useLabel(s); return [{ t: 'lbl', s: labelAt(s).name, to: s }, { t: 'p', s: '+' }, { t: 'num', s: String(a - s) }]; }
      const b = A.blockAt(a);
      if (b) for (let p = a - 1; p >= b.start && a - p < 256; p--) {
        const l = labelAt(p);
        if (l) { ctx.useLabel && ctx.useLabel(p); return [{ t: 'lbl', s: l.name, to: p }, { t: 'p', s: '+' }, { t: 'num', s: String(a - p) }]; }
      }
    }
    if (!loaded(a) || (isIO(a) && !ctx.isCall)) {
      if (a < 0x100 && zp.has(a)) {
        const z = zp.get(a); ctx.useZp && ctx.useZp(z.off ? a - 1 : a);
        return z.off ? [{ t: 'lbl', s: z.name, to: a - 1, zp: true }, { t: 'p', s: '+' }, { t: 'num', s: '1' }] : [{ t: 'lbl', s: z.name, to: a, zp: true }];
      }
      const hs = S.hwInclude !== 'none' ? hwSymbol(a) : null;
      if (hs && (!ctx.isCall || hs.sym.call || hs.off)) { ctx.useHw && ctx.useHw(hs.sym.addr); return [{ t: 'hw', s: hs.text, to: a, sym: hs.sym }]; }
    }
    return [{ t: 'num', s: a < 0x100 && ctx.zpWidth ? n2(a) : n4(a), to: loaded(a) ? a : undefined }];
  }

  function insLine(pc, ctx) {
    const o = OPC[mem[pc]];
    const n = insLen[pc];
    const bytes = [...mem.subarray(pc, pc + n)];
    const line = { k: 'ins', a: pc, n, mn: o.mn, ill: o.ill, tok: [], cmt: '' };
    if (A.skip.has(pc)) {
      return Object.assign(line, { k: 'dat', dir: '.byte', tok: [{ t: 'num', s: n2(mem[pc]) }], cmt: `bit ${o.mode === 'abs' ? 'abs' : 'zp'}: skips the next ${o.len - 1}-byte instruction` });
    }
    const d = decode(mem, pc);
    const opTok = [];
    let ext = '';
    const c = Object.assign({}, ctx, { isCall: o.flow === 'jsr' || o.flow === 'jmp', zpWidth: MODE_LEN[o.mode] === 2 });
    switch (o.mode) {
      case 'imp': case 'acc': break;
      case 'imm': {
        const h = A.hints.get(pc);
        if (h) {
          const tk = addrTokens(h.target, c);
          if (tk[0].t === 'num') opTok.push({ t: 'p', s: '#' }, { t: 'num', s: n2(d.v) });
          else { opTok.push({ t: 'p', s: '#' + (h.kind === 'lo' ? '<' : '>') }); if (tk.length > 1) opTok.push({ t: 'p', s: '(' }, ...tk, { t: 'p', s: ')' }); else opTok.push(...tk); }
        } else opTok.push({ t: 'p', s: '#' }, { t: 'num', s: n2(d.v) });
        break;
      }
      case 'rel': opTok.push(...addrTokens(d.target, c)); break;
      case 'zp': case 'zpx': case 'zpy': case 'izx': case 'izy': {
        const tk = addrTokens(d.v, c);
        if (tk[0].t === 'lbl' && !tk[0].zp && loaded(tk[0].to)) ext = '.zp';
        if (o.mode === 'izx') opTok.push({ t: 'p', s: '(' }, ...tk, { t: 'p', s: ',x)' });
        else if (o.mode === 'izy') opTok.push({ t: 'p', s: '(' }, ...tk, { t: 'p', s: '),y' });
        else opTok.push(...tk, ...(o.mode === 'zpx' ? [{ t: 'p', s: ',x' }] : o.mode === 'zpy' ? [{ t: 'p', s: ',y' }] : []));
        break;
      }
      case 'abs': case 'abx': case 'aby': case 'ind': {
        if (o.flow === 'jmp' && d.target === pc) { opTok.push({ t: 'p', s: '*' }); break; }
        const tk = addrTokens(d.v, Object.assign({}, c, { zpWidth: false }));
        if (d.v < 0x100 && o.mode !== 'ind') { ext = '.abs'; if (tk[0].t === 'num') tk[0].s = n4(d.v); }
        if (o.mode === 'ind') opTok.push({ t: 'p', s: '(' }, ...tk, { t: 'p', s: ')' });
        else opTok.push(...tk, ...(o.mode === 'abx' ? [{ t: 'p', s: ',x' }] : o.mode === 'aby' ? [{ t: 'p', s: ',y' }] : []));
        break;
      }
    }
    if (!o.kick) {
      const shown = opTok.map(t => t.s).join('');
      return Object.assign(line, { k: 'dat', dir: '.byte', tok: joinList(bytes.map(b => ({ t: 'num', s: n2(b) }))), cmt: `${mnc(o.mn)}${shown ? ' ' + shown : ''} (undocumented${o.unstable ? ', unstable' : ''})`, ill: true });
    }
    line.ext = ext; line.tok = opTok;
    const cm = [];
    if (A.smc.has(pc)) cm.push(`self-modified by ${n4(A.smc.get(pc))}`);
    if (o.flow === 'jmpi') { const t = [...A.lohiTabs.values()].find(t => t.dest === d.v && t.code); cm.push(t ? `jump table: ${t.len} targets` : 'indirect jump'); }
    if (A.inlineCalls.has(pc)) cm.push('inline data follows');
    if (S.hwComments) { const hsTok = opTok.find(t => t.t === 'hw'); if (hsTok && hsTok.sym && hsTok.sym.desc) cm.push(hsTok.sym.desc); }
    if (o.ill) cm.push('undocumented opcode');
    line.cmt = cm.join('; ');
    return line;
  }

  function joinList(items) { const out = []; items.forEach((it, i) => { if (i) out.push({ t: 'p', s: ', ' }); out.push(it); }); return out; }
  const numTok = (v, fmt) => ({ t: 'num', s: fmt === 'bin' ? '%' + v.toString(2).padStart(8, '0') : fmt === 'dec' ? String(v) : n2(v) });

  function dataRows(out, s, e, ctx, opt = {}) {
    const row = opt.row || S.bytesPerRow, fmt = opt.fmt || 'hex';
    let p = s;
    while (p < e) {
      if (p !== s && labelAt(p) && !opt.noLabels) out.push({ k: 'lbl', a: p, name: labelAt(p).name });
      let q = p + 1;
      while (q < e && q - p < row && !(labelAt(q) && !opt.noLabels)) q++;
      const items = [];
      for (let i = p; i < q; i++) items.push(opt.item ? opt.item(i) : numTok(mem[i], fmt));
      out.push({ k: 'dat', a: p, n: q - p, dir: opt.dir || '.byte', tok: joinList(items).flat(), cmt: opt.cmt ? opt.cmt(p) : '' });
      p = q;
    }
  }

  function textRows(out, s, e, enc) {
    const ok = enc === 'petscii' ? (b => b >= 0x20 && b <= 0x5d && b !== 0x22 && b !== 0x5c) : (b => (b >= 0x01 && b <= 0x1a) || b === 0x1b || b === 0x1d || (b >= 0x20 && b <= 0x3f && b !== 0x22));
    const ch = enc === 'petscii' ? (b => String.fromCharCode(b)) : (b => b <= 0x1d ? String.fromCharCode(b + 0x40) : String.fromCharCode(b));
    out.push({ k: 'dir', a: s, n: 0, tok: [{ t: 'dir', s: '.encoding' }, { t: 'p', s: ' ' }, { t: 'str', s: enc === 'petscii' ? '"petscii_upper"' : '"screencode_upper"' }] });
    let p = s;
    while (p < e) {
      if (p !== s && labelAt(p)) out.push({ k: 'lbl', a: p, name: labelAt(p).name });
      if (ok(mem[p])) {
        let q = p; while (q < e && ok(mem[q]) && q - p < 48 && !(q !== p && labelAt(q))) q++;
        out.push({ k: 'dat', a: p, n: q - p, dir: '.text', tok: [{ t: 'str', s: '"' + [...mem.subarray(p, q)].map(ch).join('') + '"' }], cmt: '' });
        p = q;
      } else {
        let q = p; while (q < e && !ok(mem[q]) && q - p < S.bytesPerRow && !(q !== p && labelAt(q))) q++;
        const names = { 0x0d: 'RETURN', 0x00: 'end', 0x93: 'CLR', 0x13: 'HOME', 0x11: 'DOWN', 0x05: 'WHITE', 0x0e: 'lower case', 0x8e: 'upper case' };
        const c = enc === 'petscii' ? [...mem.subarray(p, q)].map(b => names[b]).filter(Boolean).join(', ') : (mem[p] === 0 && q - p === 1 ? 'end' : '');
        out.push({ k: 'dat', a: p, n: q - p, dir: '.byte', tok: joinList([...mem.subarray(p, q)].map(b => numTok(b))), cmt: c });
        p = q;
      }
    }
  }

  const binFiles = {};
  const blockTitle = b => {
    const info = TYPE_INFO[b.type], p = b.props;
    let t = info.label;
    if (b.type === T.TEXT) t += p.enc === 'screen' ? ' (screen codes)' : ' (PETSCII)';
    if (b.type === T.TABLE) t = p.sub === 'sine' ? 'Curve table' : p.sub === 'colors' ? 'Color table' : 'Table';
    if (b.type === T.LOHI) t = `${p.ptr ? 'Pointer' : 'Value'} table (${p.part} bytes)`;
    if (b.type === T.DATA && p.var) t = 'Variables';
    return t;
  };

  function renderBlock(out, b, ctx) {
    const lb = labelAt(b.start);
    const len = b.end - b.start;
    const title = blockTitle(b);
    const userCmt = (project.blockComments || {})[b.start];
    out.push({ k: 'hdr', a: b.start, blk: b.id, type: b.type, text: `${title}${lb ? ' · ' + lb.name : ''} · ${n4(b.start)}-${n4(b.end - 1)} (${len} byte${len === 1 ? '' : 's'})` });
    if (userCmt) out.push({ k: 'cmt', a: b.start, text: userCmt });
    const seg = (name) => out.push({ k: 'dir', a: b.start, n: 0, tok: [{ t: 'dir', s: '.pc' }, { t: 'p', s: ' = ' }, { t: 'num', s: n4(b.start) }, { t: 'p', s: ' ' }, { t: 'str', s: `"${name}"` }] });
    const segName = { [T.CODE]: 'Code', [T.SPRITE]: 'Sprites', [T.CHARSET]: 'Charset', [T.BITMAP]: 'Bitmap', [T.SCREEN]: 'Screen', [T.DATA]: 'Data' };
    if (ctx.needSeg || [T.SPRITE, T.CHARSET, T.BITMAP, T.SCREEN].includes(b.type) || (b.type === T.CODE && ctx.prevType !== T.CODE) || (b.type !== T.CODE && ctx.prevType === T.CODE)) {
      if (b.type !== T.BASIC && !(b.type === T.MUSIC && S.musicAsSid)) seg(segName[b.type] || (b.type === T.CODE ? 'Code' : 'Data'));
    }
    ctx.needSeg = false;
    const label = (a) => { const l = labelAt(a); if (l) out.push({ k: 'lbl', a, name: l.name }); };
    switch (b.type) {
      case T.BASIC: {
        const bs = A.basics.find(x => x.start === b.start);
        if (bs && bs.upstart && S.basicUpstart && b.end === bs.end) {
          const tk = bs.sys != null ? addrTokens(bs.sys, ctx) : [{ t: 'num', s: '0' }];
          out.push({ k: 'dir', a: b.start, n: b.end - b.start, tok: [{ t: 'kw', s: 'BasicUpstart2' }, { t: 'p', s: '(' }, ...tk, { t: 'p', s: ')' }], cmt: bs.lines.map(l => l.text).join(' : ') });
          ctx.needSeg = true;
        } else {
          seg('Basic');
          label(b.start);
          dataRows(out, b.start, b.end, ctx, { cmt: p => { const l = bs && bs.lines.find(x => x.addr === p); return l ? l.text : ''; }, row: S.bytesPerRow });
        }
        break;
      }
      case T.CODE: {
        let p = b.start;
        while (p < b.end) {
          if (insLen[p]) { label(p); out.push(insLine(p, ctx)); p += insLen[p]; }
          else { label(p); out.push({ k: 'dat', a: p, n: 1, dir: '.byte', tok: [{ t: 'num', s: n2(mem[p]) }], cmt: 'orphan byte' }); p++; }
        }
        break;
      }
      case T.MUSIC: {
        const m = A.music.find(x => x.start === b.start) || { start: b.start, end: b.end, init: b.start, play: b.start + 3 };
        if (S.musicAsSid) {
          const v = musicVar(m);
          const path = `music/music_${h4(m.start)}.sid`;
          binFiles[path] = KR.makePsid(mem.slice(m.start, m.end), m.start, m.init, m.play, `${project.name || 'music'} ${h4(m.start)}`);
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
      case T.TEXT: label(b.start); textRows(out, b.start, b.end, b.props.enc || 'petscii'); break;
      case T.LOHI: {
        label(b.start);
        const lt = A.lohiTabs.get(b.start);
        if (lt && lt.ptr) {
          const other = lt.part === 'lo' ? lt.hi : lt.lo;
          dataRows(out, b.start, b.end, ctx, {
            item: i => {
              const v = mem[lt.lo + (i - b.start)] | (mem[lt.hi + (i - b.start)] << 8);
              const tk = addrTokens(v, ctx);
              if (tk[0].t === 'num') return numTok(mem[i]);
              return tk.length > 1 ? [{ t: 'p', s: (lt.part === 'lo' ? '<' : '>') + '(' }, ...tk, { t: 'p', s: ')' }] : [{ t: 'p', s: lt.part === 'lo' ? '<' : '>' }, ...tk];
            }, row: 4,
          });
          void other;
        } else dataRows(out, b.start, b.end, ctx, {});
        break;
      }
      case T.WORDS: {
        label(b.start);
        let p = b.start;
        for (; p + 1 < b.end; p += 2) {
          if (p !== b.start) label(p);
          const v = mem[p] | (mem[p + 1] << 8);
          out.push({ k: 'dat', a: p, n: 2, dir: '.word', tok: addrTokens(v, Object.assign({}, ctx, { zpWidth: false })).map(t => t.t === 'num' ? Object.assign({}, t, { s: n4(v) }) : t), cmt: '' });
        }
        if (p < b.end) { label(p); dataRows(out, p, b.end, ctx, {}); }
        break;
      }
      case T.FILL: {
        label(b.start);
        let mixed = false; for (let p = b.start + 1; p < b.end; p++) if (labelAt(p) || mem[p] !== mem[b.start]) { mixed = true; break; }
        if (mixed) { dataRows(out, b.start, b.end, ctx, {}); break; }
        out.push({ k: 'dir', a: b.start, n: len, tok: [{ t: 'dir', s: '.fill' }, { t: 'p', s: ' ' }, { t: 'num', s: String(len) }, { t: 'p', s: ', ' }, { t: 'num', s: n2(mem[b.start]) }] });
        break;
      }
      case T.SPRITE: {
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
      case T.CHARSET: case T.BITMAP: case T.SCREEN: {
        label(b.start);
        const hasInner = (() => { for (let p = b.start + 1; p < b.end; p++) if (labelAt(p)) return true; return false; })();
        if (S.gfxBinary && b.type !== T.SCREEN && !hasInner) {
          const path = `gfx/${TYPE_INFO[b.type].key}_${h4(b.start)}.bin`;
          binFiles[path] = mem.slice(b.start, b.end);
          out.push({ k: 'dir', a: b.start, n: len, tok: [{ t: 'dir', s: '.import binary' }, { t: 'p', s: ' ' }, { t: 'str', s: `"${path}"` }], cmt: `${len} bytes` });
        } else if (b.type === T.CHARSET) {
          dataRows(out, b.start, b.end, ctx, { row: 8, cmt: p => ((p - b.start) % 8 === 0 ? `char ${n2((p - b.start) >> 3)}` : '') });
        } else dataRows(out, b.start, b.end, ctx, { row: b.type === T.SCREEN ? 40 : 8 });
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

  // ---- per file ----
  const outFiles = {};
  const fileLines = {};
  const listing = [];
  const fileNames = A.files.map((f, i) => {
    let base = (f.name || `file${i}`).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_') || `file${i}`;
    return base;
  });
  const used = new Set();
  fileNames.forEach((n, i) => { let m = n, k = 2; while (used.has(m)) m = `${n}_${k++}`; used.add(m); fileNames[i] = m; });
  const allUsedHw = new Set();
  const problems = [];
  for (const name of dupes) problems.push({ lvl: 'err', msg: `Label "${name}" is defined more than once`, addr: byName.get(name) });

  A.files.forEach((f, fi) => {
    const body = [];
    const usedZp = new Set(), usedExt = new Set(), usedHw = new Set();
    const ctx = {
      fileIdx: fi, usedMusic: new Set(), prevType: null, needSeg: true,
      useLabel: a => { if (fileOf(a) !== fi) usedExt.add(a); },
      useZp: a => usedZp.add(a), useHw: a => usedHw.add(a),
    };
    const fb = blocksSorted.filter(b => b.file === fi);
    for (const b of fb) { renderBlock(body, b, ctx); body.push({ k: 'blank', a: b.end }); }
    usedHw.forEach(a => allUsedHw.add(a));
    const head = [];
    const end = Math.min(0x10000, f.load + f.bytes.length);
    head.push({ k: 'cmt', a: f.load, text: `${f.name} — re-assembled by KickReasm Studio` });
    head.push({ k: 'cmt', a: f.load, text: `load ${n4(f.load)}-${n4(end - 1)} (${end - f.load} bytes)${A.entry != null && fileOf(A.entry) === fi ? ` · entry ${labelAt(A.entry) ? labelAt(A.entry).name : n4(A.entry)}` : ''} · Kick Assembler 5.x` });
    head.push({ k: 'blank', a: f.load });
    if (S.hwInclude === 'import') head.push({ k: 'dir', a: f.load, n: 0, tok: [{ t: 'dir', s: '#import' }, { t: 'p', s: ' ' }, { t: 'str', s: '"include/c64-hardware.asm"' }] });
    else if (S.hwInclude === 'inline' && usedHw.size) {
      head.push({ k: 'cmt', a: f.load, text: 'hardware and KERNAL symbols' });
      for (const a of [...usedHw].sort((x, y) => x - y)) { const s = SYM.exact.get(a) || SYM.regions.find(r => r.start === a); if (s && !/\+/.test(s.name)) head.push({ k: 'dir', a: f.load, n: 0, tok: [{ t: 'dir', s: '.label' }, { t: 'p', s: ' ' }, { t: 'def', s: s.name }, { t: 'p', s: ' = ' }, { t: 'num', s: n4(s.addr ?? s.start) }] }); }
    }
    if (usedZp.size) {
      head.push({ k: 'blank', a: f.load });
      head.push({ k: 'cmt', a: f.load, text: 'zero page' });
      for (const a of [...usedZp].sort((x, y) => x - y)) head.push({ k: 'dir', a: f.load, n: 0, zp: a, tok: [{ t: 'dir', s: '.label' }, { t: 'p', s: ' ' }, { t: 'def', s: zp.get(a).name, zp: a }, { t: 'p', s: ' = ' }, { t: 'num', s: n2(a) }] });
    }
    if (usedExt.size) {
      head.push({ k: 'blank', a: f.load });
      head.push({ k: 'cmt', a: f.load, text: 'labels defined in other files' });
      for (const a of [...usedExt].sort((x, y) => x - y)) head.push({ k: 'dir', a: f.load, n: 0, tok: [{ t: 'dir', s: '.label' }, { t: 'p', s: ' ' }, { t: 'def', s: labelAt(a).name }, { t: 'p', s: ' = ' }, { t: 'num', s: n4(a) }] });
    }
    if (ctx.usedMusic.size) {
      head.push({ k: 'blank', a: f.load });
      for (const m of ctx.usedMusic) head.push({ k: 'dir', a: f.load, n: 0, tok: [{ t: 'dir', s: '.var' }, { t: 'p', s: ' ' }, { t: 'def', s: musicVar(m) }, { t: 'p', s: ' = ' }, { t: 'kw', s: 'LoadSid' }, { t: 'p', s: '(' }, { t: 'str', s: `"music/music_${h4(m.start)}.sid"` }, { t: 'p', s: ')' }] });
    }
    head.push({ k: 'blank', a: f.load });
    const lines = head.concat(body);
    while (lines.length && lines[lines.length - 1].k === 'blank') lines.pop();
    const userCmt = project.comments || {}, done = new Set();
    for (const l of lines) {
      if ((l.k === 'ins' || l.k === 'dat' || (l.k === 'dir' && l.n > 0)) && userCmt[l.a] && !done.has(l.a)) { l.cmt = userCmt[l.a]; l.userCmt = true; done.add(l.a); }
    }
    const path = `${fileNames[fi]}.asm`;
    outFiles[path] = lines.map(l => KR.lineText(l, S)).join('\n') + '\n';
    fileLines[path] = lines;
    listing.push({ k: 'file', a: f.load, text: path, fi });
    for (const l of lines) listing.push(l);
  });
  Object.assign(outFiles, binFiles);
  outFiles['include/c64-hardware.asm'] = KR.hardwareInclude(S);
  return { lines: listing, files: outFiles, fileLines, labels, zp, fileNames, problems, usedHw: allUsedHw };
};

KR.lineText = function lineText(l, S) {
  const ind = ' '.repeat(S.indent);
  const tokS = tk => tk.map(t => t.s).join('');
  const withCmt = (s, c) => { if (!c) return s; const pad = Math.max(1, S.commentCol - s.length); return s + ' '.repeat(pad) + '// ' + c; };
  const mnc = m => S.mnemonicCase === 'upper' ? m : m.toLowerCase();
  const adr = l.a != null && S.addrComments && (l.k === 'ins' || l.k === 'dat') ? `${'$' + h4(l.a)}` : '';
  const cc = c => [adr, c].filter(Boolean).join('  ');
  switch (l.k) {
    case 'lbl': return `${l.name}:`;
    case 'ins': return withCmt(ind + mnc(l.mn) + (l.ext || '') + (l.tok.length ? ' ' + tokS(l.tok) : ''), cc(l.cmt));
    case 'dat': return withCmt(ind + l.dir + ' ' + tokS(l.tok), cc(l.cmt));
    case 'dir': return withCmt((l.tok[0] && (l.tok[0].s === '#import' || l.tok[0].s === '.label' || l.tok[0].s === '.var' || l.tok[0].s === '.pc' || l.tok[0].s === 'BasicUpstart2') ? '' : ind) + tokS(l.tok), l.cmt);
    case 'cmt': return `// ${l.text}`;
    case 'hdr': return `// ${('---- ' + l.text + ' ').padEnd(66, '-')}`;
    case 'file': return `// ===== ${l.text} =====`;
    default: return '';
  }
};

KR.hardwareInclude = function (S) {
  const out = ['// C64 hardware, KERNAL and system symbols', '// generated by KickReasm Studio for Kick Assembler 5.x', ''];
  const cats = new Map();
  for (const s of SYM.exact.values()) { if (/\+/.test(s.name)) continue; if (!cats.has(s.cat)) cats.set(s.cat, []); cats.get(s.cat).push(s); }
  for (const r of SYM.regions) { if (!cats.has(r.cat)) cats.set(r.cat, []); cats.get(r.cat).push({ name: r.name, addr: r.start, desc: r.desc }); }
  for (const [cat, list] of cats) {
    out.push(`// ---- ${cat} ----`);
    for (const s of list.sort((x, y) => x.addr - y.addr)) {
      const left = `.label ${s.name.padEnd(18)} = $${S.hexCase === 'upper' ? h4(s.addr).toUpperCase() : h4(s.addr)}`;
      out.push(`${left.padEnd(36)}// ${s.desc}`);
    }
    out.push('');
  }
  return out.join('\n');
};

/* PSID v2 file: 0x7C byte header + load address + data */
KR.makePsid = function (data, load, init, play, name) {
  const out = new Uint8Array(0x7c + 2 + data.length);
  const be16 = (o, v) => { out[o] = (v >> 8) & 0xff; out[o + 1] = v & 0xff; };
  out.set([0x50, 0x53, 0x49, 0x44], 0);
  be16(4, 2); be16(6, 0x7c); be16(8, 0); be16(0x0a, init); be16(0x0c, play); be16(0x0e, 1); be16(0x10, 1);
  const str = (o, s) => { for (let i = 0; i < 31 && i < s.length; i++) out[o + i] = s.charCodeAt(i) & 0x7f; };
  str(0x16, name || 'Ripped music'); str(0x36, '<?>'); str(0x56, 'Ripped with KickReasm Studio');
  be16(0x76, 0x14);
  out[0x7c] = load & 0xff; out[0x7d] = load >> 8;
  out.set(data, 0x7e);
  return out;
};
KR.parsePsid = function (u8) {
  if (u8.length < 0x7c || String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'PSID' && String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'RSID') throw new Error('not a PSID/RSID file');
  const be = o => (u8[o] << 8) | u8[o + 1];
  const off = be(6);
  let load = be(8), data = u8.subarray(off);
  if (load === 0) { load = data[0] | (data[1] << 8); data = data.subarray(2); }
  const str = o => String.fromCharCode(...u8.subarray(o, o + 32)).replace(/\0.*$/, '');
  return { location: load, init: be(0x0a) || load, play: be(0x0c), size: data.length, songs: be(0x0e), startSong: be(0x10), name: str(0x16), author: str(0x36), data };
};

/* =====================================================================
 * 7. VERIFIER — assembles the Kick Assembler subset that the exporter
 *    emits (plus #import, LoadSid, .import binary, BasicUpstart2) and
 *    compares the result with the original PRG byte by byte. In the
 *    desktop app this step runs the real KickAss.jar instead.
 * ===================================================================== */
KR.assemble = function assemble(vfs, entryPath) {
  const errors = [];
  const E = (msg, st) => errors.push({ msg, file: st ? st.file : entryPath, line: st ? st.line : 0 });
  const stmts = [];
  const loadFile = (path, depth) => {
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
      const st = { file: path, line: i + 1, src: s };
      const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:(?!:)\s*(.*)$/);
      if (m && !/^[A-Za-z_]\w*\s*:\s*=/.test(s)) { st.label = m[1]; s = m[2]; }
      st.body = s;
      if (/^#import\s+"([^"]+)"/.test(s)) { const p = s.match(/^#import\s+"([^"]+)"/)[1]; if (st.label) stmts.push({ file: path, line: i + 1, label: st.label, body: '' }); loadFile(p, depth + 1); return; }
      stmts.push(st);
    });
  };
  loadFile(entryPath, 0);

  // ---- expressions ----
  const tokenize = s => {
    const out = []; let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '$') { const m = s.slice(i + 1).match(/^[0-9a-fA-F]+/); if (!m) throw new Error(`bad hex number in "${s}"`); out.push({ t: 'n', v: parseInt(m[0], 16) }); i += 1 + m[0].length; continue; }
      if (c === '%') { const m = s.slice(i + 1).match(/^[01]+/); if (m) { out.push({ t: 'n', v: parseInt(m[0], 2) }); i += 1 + m[0].length; continue; } }
      if (/[0-9]/.test(c)) { const m = s.slice(i).match(/^[0-9]+/); out.push({ t: 'n', v: parseInt(m[0], 10) }); i += m[0].length; continue; }
      if (/[A-Za-z_]/.test(c)) { const m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/); out.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
      if (c === '"') { const j = s.indexOf('"', i + 1); if (j < 0) throw new Error('unterminated string'); out.push({ t: 's', v: s.slice(i + 1, j) }); i = j + 1; continue; }
      if (s.startsWith('<<', i) || s.startsWith('>>', i)) { out.push({ t: 'op', v: s.slice(i, i + 2) }); i += 2; continue; }
      if ('+-*/&|^<>(),.'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
      throw new Error(`unexpected "${c}" in expression "${s}"`);
    }
    return out;
  };
  const BIN = { '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6 };
  const parseExpr = s => {
    const tk = tokenize(s); let p = 0;
    const peek = () => tk[p], next = () => tk[p++];
    const primary = () => {
      const t = next();
      if (!t) throw new Error(`incomplete expression "${s}"`);
      if (t.t === 'n') return { k: 'n', v: t.v };
      if (t.t === 's') return { k: 's', v: t.v };
      if (t.t === 'op' && t.v === '*') return { k: 'pc' };
      if (t.t === 'op' && t.v === '(') { const e = expr(0); const c = next(); if (!c || c.v !== ')') throw new Error(`missing ) in "${s}"`); return e; }
      if (t.t === 'op' && (t.v === '<' || t.v === '>' || t.v === '-')) return { k: 'u', op: t.v, a: unary() };
      if (t.t === 'id') {
        let node = { k: 'id', v: t.v };
        for (;;) {
          const q = peek();
          if (q && q.t === 'op' && q.v === '.') { next(); const id = next(); if (!id || id.t !== 'id') throw new Error(`bad member access in "${s}"`); node = { k: 'mem', o: node, v: id.v }; continue; }
          if (q && q.t === 'op' && q.v === '(') {
            next(); const args = [];
            if (!(peek() && peek().v === ')')) { for (;;) { args.push(expr(0)); const c = next(); if (c && c.v === ')') break; if (!c || c.v !== ',') throw new Error(`bad argument list in "${s}"`); } } else next();
            node = { k: 'call', f: node, args }; continue;
          }
          break;
        }
        return node;
      }
      throw new Error(`unexpected "${t.v}" in "${s}"`);
    };
    const unary = () => primary();
    const expr = (minP) => {
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
  const cache = new Map();
  const P = s => { if (!cache.has(s)) cache.set(s, parseExpr(s)); return cache.get(s); };

  let syms = new Map(), pc = 0, pass = 0, unresolved = [];
  const builtins = {
    toIntString: v => String(v),
    LoadSid: path => { const u = vfs[path]; if (!(u instanceof Uint8Array)) throw new Error(`LoadSid: can't open "${path}"`); const sid = KR.parsePsid(u); return Object.assign({}, sid, { getData: i => sid.data[i] }); },
  };
  const ev = (node, env) => {
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
      }
    }
    return null;
  };
  const splitArgs = s => { const out = []; let depth = 0, q = false, cur = ''; for (const c of s) { if (c === '"') q = !q; if (!q && c === '(') depth++; if (!q && c === ')') depth--; if (!q && depth === 0 && c === ',') { out.push(cur.trim()); cur = ''; continue; } cur += c; } if (cur.trim()) out.push(cur.trim()); return out; };
  const ENCODINGS = {
    screencode_upper: c => { const k = c.charCodeAt(0); if (c === '@') return 0; if (k >= 65 && k <= 90) return k - 64; if (k >= 97 && k <= 122) return k - 96; if (c === '[') return 0x1b; if (c === ']') return 0x1d; return k & 0x3f; },
    screencode_mixed: c => { const k = c.charCodeAt(0); if (c === '@') return 0; if (k >= 97 && k <= 122) return k - 96; if (k >= 65 && k <= 90) return k; if (c === '[') return 0x1b; if (c === ']') return 0x1d; return k & 0x3f; },
    petscii_upper: c => { const k = c.charCodeAt(0); if (k >= 97 && k <= 122) return k - 32; return k; },
    petscii_mixed: c => { const k = c.charCodeAt(0); if (k >= 97 && k <= 122) return k - 32; if (k >= 65 && k <= 90) return k + 0x80; return k; },
  };
  let mem, written, blocks;
  const emit = (b, st) => { b &= 0xff; if (pc > 0xffff) { E('program counter past $ffff', st); return; } if (written[pc] && pass === 'final') E(`memory at $${h4(pc)} written twice`, st); mem[pc] = b; written[pc] = 1; pc++; };
  const IMPLIED_ACC = new Set(['ASL', 'LSR', 'ROL', 'ROR']);

  const runPass = (final) => {
    mem = new Uint8Array(0x10000); written = new Uint8Array(0x10000); blocks = [];
    pc = 0; let enc = 'screencode_mixed'; unresolved = []; let changed = false;
    const define = (name, v, st) => { if (final && syms.has(name) && syms.get(name) !== v && typeof v === 'number') E(`symbol "${name}" changed value in the final pass`, st); if (syms.get(name) !== v) changed = true; syms.set(name, v); };
    const defs = new Set();
    for (const st of stmts) {
      try {
        if (st.label) { if (defs.has(st.label)) E(`label "${st.label}" defined twice`, st); defs.add(st.label); define(st.label, pc, st); }
        let s = st.body;
        if (!s) continue;
        let m;
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
          const modes = ENC[mn];
          let mode, ex = null;
          if (!arg) mode = IMPLIED_ACC.has(mn) ? 'acc' : 'imp';
          else if (arg[0] === '#') { mode = 'imm'; ex = arg.slice(1); }
          else if ((m = arg.match(/^\((.+),\s*[xX]\s*\)$/))) { mode = 'izx'; ex = m[1]; }
          else if ((m = arg.match(/^\((.+)\)\s*,\s*[yY]$/))) { mode = 'izy'; ex = m[1]; }
          else if ((m = arg.match(/^\((.+)\)$/)) && mn === 'JMP') { mode = 'ind'; ex = m[1]; }
          else if ((m = arg.match(/^(.+),\s*([xXyY])$/))) { ex = m[1]; mode = m[2].toLowerCase(); }
          else { ex = arg; mode = 'plain'; }
          const v = ex != null ? ev(P(ex)) : null;
          if (BRANCHES.has(mn)) mode = 'rel';
          else if (mode === 'plain' || mode === 'x' || mode === 'y') {
            const suf = mode === 'plain' ? '' : mode;
            const forceZp = ext === 'zp' || ext === 'z', forceAbs = ext === 'abs' || ext === 'a';
            const zpOk = modes['zp' + suf] !== undefined, absOk = modes['ab' + (suf || 's')] !== undefined;
            const wantZp = forceZp || (!forceAbs && v != null && v >= 0 && v < 0x100);
            mode = (wantZp && zpOk) ? 'zp' + suf : absOk ? (suf ? 'ab' + suf : 'abs') : 'zp' + suf;
          }
          const op = modes[mode];
          if (op === undefined) { E(`${mn.toLowerCase()} does not support this addressing mode (${mode})`, st); continue; }
          emit(op, st);
          const len = MODE_LEN[mode];
          if (mode === 'rel') {
            const off = v == null ? 0 : v - (pc + 1);
            if (final && (off < -128 || off > 127)) E(`branch out of range (${off})`, st);
            emit(off & 0xff, st);
          } else if (len === 2) { if (final && v != null && (v < -128 || v > 255)) E(`value $${(v >>> 0).toString(16)} does not fit in a byte`, st); emit(v ?? 0, st); }
          else if (len === 3) { emit((v ?? 0) & 0xff, st); emit(((v ?? 0) >> 8) & 0xff, st); }
          continue;
        }
        E(`unsupported statement: ${s}`, st);
      } catch (err) { E(err.message, st); }
    }
    return changed;
  };
  for (pass = 1; pass <= 12; pass++) { const ch = runPass(false); if (!ch && !unresolved.length && pass > 1) break; }
  pass = 'final';
  runPass(true);
  for (const u of new Set(unresolved)) E(`Unknown symbol "${u}"`);
  let min = -1, max = -1;
  for (let a = 0; a < 0x10000; a++) if (written[a]) { if (min < 0) min = a; max = a; }
  const blockList = blocks.filter(b => b.name).map((b, i, arr) => ({ start: b.start, name: b.name, end: i + 1 < arr.length ? arr[i + 1].start - 1 : max }));
  let prg = null;
  if (min >= 0) { prg = new Uint8Array(max - min + 3); prg[0] = min & 0xff; prg[1] = min >> 8; prg.set(mem.subarray(min, max + 1), 2); }
  return { mem, written, min, max, errors, prg, blocks: blockList, symbols: syms };
};

/* Round trip: render -> assemble every file -> compare with the original PRG */
KR.verify = function verify(A, R) {
  const results = A.files.map((f, fi) => {
    const path = `${R.fileNames[fi]}.asm`;
    const asm = KR.assemble(R.files, path);
    const end = Math.min(0x10000, f.load + f.bytes.length);
    const diffs = [];
    let same = 0;
    if (asm.min !== f.load) diffs.push({ addr: asm.min, msg: `output starts at $${h4(Math.max(0, asm.min))}, original at $${h4(f.load)}` });
    if (asm.max !== end - 1) diffs.push({ addr: asm.max, msg: `output ends at $${h4(Math.max(0, asm.max))}, original at $${h4(end - 1)}` });
    for (let a = f.load; a < end; a++) {
      if (asm.mem[a] === f.bytes[a - f.load] && asm.written[a]) same++;
      else if (diffs.length < 40) diffs.push({ addr: a, exp: f.bytes[a - f.load], got: asm.written[a] ? asm.mem[a] : null });
    }
    return { file: f.name, path, ok: !asm.errors.length && !diffs.length, same, total: end - f.load, diffs, errors: asm.errors, prg: asm.prg, blocks: asm.blocks };
  });
  return { ok: results.every(r => r.ok), results };
};

/* =====================================================================
 * 8. DEMO PROGRAM — built from source with the verifier's assembler so
 *    the first launch shows a realistic, fully analysable PRG.
 * ===================================================================== */
KR.makeDemo = function () {
  const rows = (arr, n = 16) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push('.byte ' + arr.slice(i, i + n).map(v => '$' + h2(v)).join(',')); return out.join('\n'); };
  const sine = Array.from({ length: 256 }, (_, i) => Math.round(172 + 80 * Math.sin(2 * Math.PI * i / 256)));
  const notes = Array.from({ length: 24 }, (_, i) => Math.round(130.81 * Math.pow(2, i / 12) * 16777216 / 985248));
  const song = [1, 5, 8, 13, 8, 5, 1, 5, 3, 7, 10, 15, 10, 7, 3, 7, 6, 10, 13, 18, 13, 10, 6, 10, 8, 12, 15, 20, 15, 12, 8, 12, 0];
  const ball = [
    '.........######.........', '......############......', '....################....', '...##################...',
    '..########..##########..', '..#######....#########..', '.########....##########.', '.#########..###########.',
    '.######################.', '########################', '########################', '########################',
    '.######################.', '.######################.', '.######################.', '..####################..',
    '..####################..', '...##################...', '....################....', '......############......',
    '.........######.........'];
  const sprite = [];
  for (const r of ball) for (let b = 0; b < 3; b++) sprite.push(parseInt(r.slice(b * 8, b * 8 + 8).replace(/#/g, '1').replace(/\./g, '0'), 2));
  sprite.push(0);
  // a small blocky font designed for the demo (screen-code order), then generated pattern tiles
  const G = {
    '@': '7cc6dededcc07c00', A: '7cc6c6fec6c6c600', B: 'fcc6c6fcc6c6fc00', C: '7cc6c0c0c0c67c00', D: 'f8ccc6c6c6ccf800',
    E: 'fec0c0fcc0c0fe00', F: 'fec0c0fcc0c0c000', G: '7cc6c0cec6c67e00', H: 'c6c6c6fec6c6c600', I: '7830303030307800',
    J: '1e060606c6c67c00', K: 'c6ccd8f0d8ccc600', L: 'c0c0c0c0c0c0fe00', M: 'c6eefed6c6c6c600', N: 'c6e6f6decec6c600',
    O: '7cc6c6c6c6c67c00', P: 'fcc6c6fcc0c0c000', Q: '7cc6c6c6d6cc7600', R: 'fcc6c6fcd8ccc600', S: '7cc6c07c06c67c00',
    T: 'fe30303030303000', U: 'c6c6c6c6c6c67c00', V: 'c6c6c6c66c381000', W: 'c6c6c6d6feeec600', X: 'c66c3838386cc600',
    Y: 'cccccc7830303000', Z: 'fe0c183060c0fe00', ' ': '0000000000000000', '!': '3030303030003000', "'": '3030600000000000',
    '+': '003030fc30300000', ',': '0000000030306000', '-': '000000fe00000000', '.': '0000000000303000', ':': '0030300030300000',
    '=': '0000fe00fe000000', '?': '7cc60c1830003000', 0: '7ccedef6e6c67c00', 1: '307030303030fc00', 2: '7cc6061c70c0fe00',
    3: '7cc6063c06c67c00', 4: '1c3c6cccfe0c0c00', 5: 'fec0fc0606c67c00', 6: '7cc0fcc6c6c67c00', 7: 'fe060c1830303000',
    8: '7cc6c67cc6c67c00', 9: '7cc6c67e06067c00',
  };
  const sc = c => c === '@' ? 0 : c >= 'A' && c <= 'Z' ? c.charCodeAt(0) - 64 : c.charCodeAt(0);
  const charset = new Array(2048).fill(0);
  for (const [c, hex] of Object.entries(G)) for (let i = 0; i < 8; i++) charset[sc(String(c)) * 8 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  for (let ch = 0; ch < 64; ch++) for (let y = 0; y < 8; y++) {
    let v = 0;
    for (let x = 0; x < 8; x++) {
      const kind = ch >> 4, lvl = ch & 15;
      const on = kind === 0 ? bayer[y & 3][x & 3] < lvl : kind === 1 ? ((x + y + lvl) & 7) < 3 : kind === 2 ? (7 - y) < (lvl >> 1) : ((x - 3.5) ** 2 + (y - 3.5) ** 2) < (lvl / 15) * 18;
      if (on) v |= 0x80 >> x;
    }
    charset[(0x40 + ch) * 8 + y] = v;
  }
  for (let i = 0; i < 1024; i++) charset[1024 + i] = charset[i] ^ 0xff;
  const src = `
.pc = $0801 "Basic"
.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$34,$00,$00,$00
.pc = $0810 "Code"
start:
  sei
  jsr $e544
  jsr init_screen
  lda #$00
  jsr $1000
  lda #$7f
  sta $dc0d
  sta $dd0d
  lda $dc0d
  lda $dd0d
  lda #$01
  sta $d01a
  lda #$1b
  sta $d011
  lda #$32
  sta $d012
  lda #<irq_top
  sta $0314
  lda #>irq_top
  sta $0315
  lda #$80
  sta $07f8
  lda #$01
  sta $d015
  lda #$07
  sta $d027
  lda #$90
  sta $d001
  lda #$1c
  sta $d018
  jsr border_red
  jsr border_blue
  cli
  jmp *
init_screen:
  lda #$00
  sta $d020
  sta $d021
  ldx #$00
is_col:
  lda #$0e
  sta $d800,x
  sta $d900,x
  sta $da00,x
  sta $dae8,x
  inx
  bne is_col
  lda #<title
  ldy #>title
  jsr $ab1e
  ldx #$00
is_msg:
  lda message,x
  beq is_scroll
  jsr $ffd2
  inx
  bne is_msg
is_scroll:
  ldx #$00
is_s2:
  lda scrolltext,x
  beq is_bar
  sta $05e0,x
  inx
  bne is_s2
is_bar:
  ldx #$27
is_b2:
  txa
  ora #$40
  sta $0658,x
  dex
  bpl is_b2
  rts
border_red:
  lda #$02
  .byte $2c
border_blue:
  lda #$06
  sta $d020
  rts
irq_top:
  inc $d019
  ldy #$00
bars:
  lda colors,y
  ldx $d012
bars_w:
  cpx $d012
  beq bars_w
  sta $d020
  sta $d021
  iny
  cpy #$10
  bne bars
  lda #$00
  sta $d020
  sta $d021
  ldx sine_pos
  lda sine,x
  sta $d000
  inc sine_pos
  lax frame
  sax temp
  dcp countdown
smc_color:
  lda #$00
  sta $d027
  inc smc_color+1
  lda frame
  lsr
  lsr
  lsr
  and #$03
  tax
  lda fx_lo,x
  sta $fb
  lda fx_hi,x
  sta $fc
  jsr call_fx
  inc frame
  jsr $1003
  jmp $ea31
call_fx:
  jmp ($00fb)
fx_none:
  rts
fx_spin:
  inc $0427
  rts
fx_flash:
  lda $d41b
  and #$0f
  sta $dbe7
  rts
fx_key:
  lda $c5
  sta $0426
  rts
sine_pos: .byte $00
frame: .byte $00
temp: .byte $00
countdown: .byte $ff
fx_lo: .byte <fx_none,<fx_spin,<fx_flash,<fx_key
fx_hi: .byte >fx_none,>fx_spin,>fx_flash,>fx_key
colors: .byte $06,$0e,$03,$01,$03,$0e,$06,$00,$09,$08,$07,$01,$07,$08,$09,$00
.encoding "petscii_upper"
title: .text "KICKREASM STUDIO DEMO"
.byte $0d,$00
message: .text "RE-ASSEMBLE ME INTO KICK ASSEMBLER!"
.byte $0d,$00
.encoding "screencode_upper"
scrolltext: .text "HELLO FROM THE KICKREASM DEMO: 6502 + C64 = FUN"
.byte $00
sine:
${rows(sine)}
.pc = $1000 "Music"
  jmp m_init
  jmp m_play
m_init:
  ldx #$18
  lda #$00
mi_clr:
  sta $d400,x
  dex
  bpl mi_clr
  lda #$0f
  sta $d418
  lda #$00
  sta m_pos
  sta m_timer
  lda #$09
  sta $d405
  lda #$a0
  sta $d406
  rts
m_play:
  dec m_timer
  bpl m_done
  lda #$06
  sta m_timer
  ldx m_pos
  lda song,x
  bne m_note
  ldx #$00
  stx m_pos
  lda song
m_note:
  tay
  lda freq_lo,y
  sta $d400
  lda freq_hi,y
  sta $d401
  lda #$20
  sta $d404
  lda #$21
  sta $d404
  inc m_pos
m_done:
  rts
m_timer: .byte $00
m_pos: .byte $00
song:
${rows(song)}
freq_lo:
${rows(notes.map(v => v & 0xff))}
freq_hi:
${rows(notes.map(v => v >> 8))}
.pc = $2000 "Sprite"
${rows(sprite, 3)}
.pc = $3000 "Charset"
${rows(charset, 16)}
`;
  const r = KR.assemble({ 'demo.asm': src }, 'demo.asm');
  if (r.errors.length) throw new Error('demo build failed: ' + r.errors.map(e => `${e.line}: ${e.msg}`).join('; '));
  return { name: 'raster-demo.prg', prg: r.prg, source: src };
};

root.KR = KR;
})(typeof window !== 'undefined' ? window : globalThis);
