/* =====================================================================
 * 6502/6510 opcode table — all 256 opcodes. '*' = undocumented (stable),
 * '!' = undocumented and unstable on real hardware.
 * ===================================================================== */

export type AddrMode = 'imp' | 'acc' | 'imm' | 'zp' | 'zpx' | 'zpy' | 'izx' | 'izy' | 'rel' | 'abs' | 'abx' | 'aby' | 'ind';
export type Flow = 'seq' | 'br' | 'jmp' | 'jmpi' | 'jsr' | 'ret' | 'brk' | 'jam';
export type Access = 'read' | 'write' | 'rmw' | null;

export interface OpcodeInfo {
  op: number;
  mn: string;
  mode: AddrMode;
  len: 1 | 2 | 3;
  /** undocumented */
  ill: boolean;
  /** undocumented and unstable on real hardware */
  unstable: boolean;
  jam: boolean;
  flow: Flow;
  access: Access;
  /** Kick Assembler can express it with a mnemonic (round-trip safe) */
  kick: boolean;
}

export const MODE_LEN: Record<AddrMode, 1 | 2 | 3> = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, izx: 2, izy: 2, rel: 2, abs: 3, abx: 3, aby: 3, ind: 3 };

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

/**
 * Undocumented opcodes that Kick Assembler's default _6502 CPU accepts by mnemonic.
 * Everything else undocumented is emitted as .byte so the output stays byte-exact.
 * (Checked against KickAss 5.25: every opcode below assembles to the same byte.)
 */
export const KICK_ILLEGAL = new Set(['SLO', 'RLA', 'SRE', 'RRA', 'SAX', 'LAX', 'DCP', 'ISC', 'ALR', 'ARR', 'AXS', 'ANC']);
export const BRANCHES = new Set(['BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BNE', 'BEQ']);
export const WRITE_MN = new Set(['STA', 'STX', 'STY', 'SAX', 'AHX', 'SHX', 'SHY', 'TAS']);
export const RMW_MN = new Set(['ASL', 'LSR', 'ROL', 'ROR', 'INC', 'DEC', 'SLO', 'RLA', 'SRE', 'RRA', 'DCP', 'ISC']);
export const CLOBBER_A = new Set(['ADC', 'SBC', 'AND', 'ORA', 'EOR', 'PLA', 'SLO', 'RLA', 'SRE', 'RRA', 'ISC', 'ANC', 'ALR', 'ARR', 'XAA', 'LAS', 'LAX']);
export const SHIFT_MN = new Set(['ASL', 'LSR', 'ROL', 'ROR']);

export const OPC: readonly OpcodeInfo[] = OPCODE_SRC.map((src, op): OpcodeInfo => {
  let s = src, ill = false, unstable = false;
  if (s[0] === '*') { ill = true; s = s.slice(1); } else if (s[0] === '!') { ill = unstable = true; s = s.slice(1); }
  const [mn, modeStr] = s.split(' ');
  const mode = modeStr as AddrMode;
  let flow: Flow = 'seq';
  if (mn === 'JSR') flow = 'jsr';
  else if (mn === 'JMP') flow = mode === 'ind' ? 'jmpi' : 'jmp';
  else if (mn === 'RTS' || mn === 'RTI') flow = 'ret';
  else if (mn === 'BRK') flow = 'brk';
  else if (mn === 'JAM') flow = 'jam';
  else if (BRANCHES.has(mn)) flow = 'br';
  const access: Access = WRITE_MN.has(mn) ? 'write' : (RMW_MN.has(mn) && mode !== 'acc') ? 'rmw'
    : (MODE_LEN[mode] > 1 && mode !== 'imm' && mode !== 'rel' && flow === 'seq') ? 'read' : null;
  const kick = !ill || (!unstable && KICK_ILLEGAL.has(mn) && !(mn === 'ANC' && op !== 0x0b));
  return { op, mn, mode, len: MODE_LEN[mode], ill, unstable, jam: mn === 'JAM', flow, access, kick };
});

/** Assembler encoding table: mnemonic -> mode -> opcode (documented first, then Kick-accepted illegals). */
export const ENC: Record<string, Partial<Record<AddrMode, number>> | undefined> = {};
for (const pref of [false, true]) for (const o of OPC) {
  if (o.ill !== pref || !o.kick) continue;
  const m = ENC[o.mn] || (ENC[o.mn] = {});
  if (m[o.mode] === undefined) m[o.mode] = o.op;
}
ENC.ISB = ENC.ISC; ENC.ASR = ENC.ALR; ENC.SBX = ENC.AXS; ENC.LXA = undefined;
