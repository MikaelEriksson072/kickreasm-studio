/* The 6502/6510 instruction set: the mnemonic and addressing mode of all 256 opcodes, the undocumented ones
 * included, with their lengths and a one-line disassembler. */

export type Mode = 'imp' | 'acc' | 'imm' | 'zp' | 'zpx' | 'zpy' | 'abs' | 'abx' | 'aby' | 'ind' | 'izx' | 'izy' | 'rel';

const ROWS = [
  'BRK imp,ORA izx,JAM imp,SLO izx,NOP zp,ORA zp,ASL zp,SLO zp,PHP imp,ORA imm,ASL acc,ANC imm,NOP abs,ORA abs,ASL abs,SLO abs',
  'BPL rel,ORA izy,JAM imp,SLO izy,NOP zpx,ORA zpx,ASL zpx,SLO zpx,CLC imp,ORA aby,NOP imp,SLO aby,NOP abx,ORA abx,ASL abx,SLO abx',
  'JSR abs,AND izx,JAM imp,RLA izx,BIT zp,AND zp,ROL zp,RLA zp,PLP imp,AND imm,ROL acc,ANC imm,BIT abs,AND abs,ROL abs,RLA abs',
  'BMI rel,AND izy,JAM imp,RLA izy,NOP zpx,AND zpx,ROL zpx,RLA zpx,SEC imp,AND aby,NOP imp,RLA aby,NOP abx,AND abx,ROL abx,RLA abx',
  'RTI imp,EOR izx,JAM imp,SRE izx,NOP zp,EOR zp,LSR zp,SRE zp,PHA imp,EOR imm,LSR acc,ALR imm,JMP abs,EOR abs,LSR abs,SRE abs',
  'BVC rel,EOR izy,JAM imp,SRE izy,NOP zpx,EOR zpx,LSR zpx,SRE zpx,CLI imp,EOR aby,NOP imp,SRE aby,NOP abx,EOR abx,LSR abx,SRE abx',
  'RTS imp,ADC izx,JAM imp,RRA izx,NOP zp,ADC zp,ROR zp,RRA zp,PLA imp,ADC imm,ROR acc,ARR imm,JMP ind,ADC abs,ROR abs,RRA abs',
  'BVS rel,ADC izy,JAM imp,RRA izy,NOP zpx,ADC zpx,ROR zpx,RRA zpx,SEI imp,ADC aby,NOP imp,RRA aby,NOP abx,ADC abx,ROR abx,RRA abx',
  'NOP imm,STA izx,NOP imm,SAX izx,STY zp,STA zp,STX zp,SAX zp,DEY imp,NOP imm,TXA imp,ANE imm,STY abs,STA abs,STX abs,SAX abs',
  'BCC rel,STA izy,JAM imp,SHA izy,STY zpx,STA zpx,STX zpy,SAX zpy,TYA imp,STA aby,TXS imp,TAS aby,SHY abx,STA abx,SHX aby,SHA aby',
  'LDY imm,LDA izx,LDX imm,LAX izx,LDY zp,LDA zp,LDX zp,LAX zp,TAY imp,LDA imm,TAX imp,LXA imm,LDY abs,LDA abs,LDX abs,LAX abs',
  'BCS rel,LDA izy,JAM imp,LAX izy,LDY zpx,LDA zpx,LDX zpy,LAX zpy,CLV imp,LDA aby,TSX imp,LAS aby,LDY abx,LDA abx,LDX aby,LAX aby',
  'CPY imm,CMP izx,NOP imm,DCP izx,CPY zp,CMP zp,DEC zp,DCP zp,INY imp,CMP imm,DEX imp,SBX imm,CPY abs,CMP abs,DEC abs,DCP abs',
  'BNE rel,CMP izy,JAM imp,DCP izy,NOP zpx,CMP zpx,DEC zpx,DCP zpx,CLD imp,CMP aby,NOP imp,DCP aby,NOP abx,CMP abx,DEC abx,DCP abx',
  'CPX imm,SBC izx,NOP imm,ISC izx,CPX zp,SBC zp,INC zp,ISC zp,INX imp,SBC imm,NOP imp,SBC imm,CPX abs,SBC abs,INC abs,ISC abs',
  'BEQ rel,SBC izy,JAM imp,ISC izy,NOP zpx,SBC zpx,INC zpx,ISC zpx,SED imp,SBC aby,NOP imp,ISC aby,NOP abx,SBC abx,INC abx,ISC abx',
];

export interface Opcode { name: string; mode: Mode }

export const OPCODES: Opcode[] = ROWS.flatMap(row => row.split(',').map(s => {
  const [name, mode] = s.split(' ');
  return { name, mode: mode as Mode };
}));

export const MODE_LEN: Record<Mode, number> = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, abs: 3, abx: 3, aby: 3, ind: 3, izx: 2, izy: 2, rel: 2 };

/** instruction length by opcode */
export const LEN = Uint8Array.from(OPCODES, o => MODE_LEN[o.mode]);

/** The documented opcodes (the ones every assembler knows); `EB` is SBC too but undocumented. */
export const isDocumented = (op: number): boolean =>
  op !== 0xeb && !['JAM', 'SLO', 'RLA', 'SRE', 'RRA', 'SAX', 'LAX', 'DCP', 'ISC', 'ANC', 'ALR', 'ARR', 'ANE', 'LXA', 'SBX', 'SHA', 'SHX', 'SHY', 'TAS', 'LAS'].includes(OPCODES[op].name)
  && !(OPCODES[op].name === 'NOP' && op !== 0xea);

const hex2 = (v: number) => v.toString(16).padStart(2, '0');
const hex4 = (v: number) => v.toString(16).padStart(4, '0');

/** One instruction as text, e.g. `lda ($fb),y`; `read` gives the bytes. */
export function disassemble(read: (addr: number) => number, pc: number): { text: string; len: number } {
  const op = read(pc);
  const { name, mode } = OPCODES[op];
  const lo = read((pc + 1) & 0xffff), hi = read((pc + 2) & 0xffff);
  const w = lo | (hi << 8);
  const m = name.toLowerCase();
  const operand: Record<Mode, string> = {
    imp: '', acc: '', imm: ` #$${hex2(lo)}`, zp: ` $${hex2(lo)}`, zpx: ` $${hex2(lo)},x`, zpy: ` $${hex2(lo)},y`,
    abs: ` $${hex4(w)}`, abx: ` $${hex4(w)},x`, aby: ` $${hex4(w)},y`, ind: ` ($${hex4(w)})`, izx: ` ($${hex2(lo)},x)`,
    izy: ` ($${hex2(lo)}),y`, rel: ` $${hex4((pc + 2 + ((lo ^ 0x80) - 0x80)) & 0xffff)}`,
  };
  return { text: m + operand[mode], len: MODE_LEN[mode] };
}

/**
 * The cycles of every opcode without page crossings or taken branches (JAM as 2). A load or store reaches the bus
 * in its last cycle, which is how the serial bus times the C64's and the drive's accesses against each other.
 */
export const CYCLES = Uint8Array.from([
  7, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 4, 4, 6, 6, 2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 4, 4, 6, 6, 2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  6, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 3, 4, 6, 6, 2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 5, 4, 6, 6, 2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4, 2, 6, 2, 6, 4, 4, 4, 4, 2, 5, 2, 5, 5, 5, 5, 5,
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4, 2, 5, 2, 5, 4, 4, 4, 4, 2, 4, 2, 4, 4, 4, 4, 4,
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6, 2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6, 2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
]);
