/* What the undocumented 6510 opcodes do (spec 7.2): a line on each, what it computes, the flags it changes and the
 * names other assemblers give it. The listing and the source view show it when the pointer is on one. */
import { OPC } from './opcodes';

export interface UndocumentedInfo {
  /** the name Mimir writes (Kick Assembler's where it has one), and others in use */
  mn: string; also: string[];
  /** what it does, in a sentence, and as a formula (`#` the value, `H` the high byte of the address) */
  does: string; formula: string;
  /** the flags it changes, in the order N V Z C; empty: none */
  flags: string[];
  /** why it is unstable on real hardware; null: it is stable */
  unstable: string | null;
  note?: string;
}

type Entry = Omit<UndocumentedInfo, 'mn' | 'unstable'> & { unstable?: string };
const NZ = ['N', 'Z'], NZC = ['N', 'Z', 'C'], NVZC = ['N', 'V', 'Z', 'C'];
const HIGH = 'the AND with the high byte drops out when the VIC holds the CPU up during it, and a page crossing changes where it stores';

const BY_NAME: Record<string, Entry> = {
  SLO: { also: ['ASO'], does: 'shifts the memory left (ASL), then ORs it into A', formula: 'M = M << 1, A = A | M', flags: NZC },
  RLA: { also: [], does: 'rotates the memory left (ROL), then ANDs it into A', formula: 'M = M rol 1, A = A & M', flags: NZC },
  SRE: { also: ['LSE'], does: 'shifts the memory right (LSR), then EORs it into A', formula: 'M = M >> 1, A = A ^ M', flags: NZC },
  RRA: { also: [], does: 'rotates the memory right (ROR), then adds it to A with the carry (ADC)', formula: 'M = M ror 1, A = A + M + C', flags: NVZC, note: 'Decimal mode works as in ADC.' },
  SAX: { also: ['AAX'], does: 'stores A AND X', formula: 'M = A & X', flags: [] },
  LAX: { also: [], does: 'loads A and X with the same byte', formula: 'A = X = M', flags: NZ },
  DCP: { also: ['DCM'], does: 'decrements the memory (DEC), then compares A with it (CMP)', formula: 'M = M - 1, compare A with M', flags: NZC },
  ISC: { also: ['ISB', 'INS'], does: 'increments the memory (INC), then subtracts it from A with the borrow (SBC)', formula: 'M = M + 1, A = A - M - (1 - C)', flags: NVZC, note: 'Decimal mode works as in SBC.' },
  ANC: { also: ['AAC'], does: 'ANDs the value into A, then copies bit 7 of the result into the carry', formula: 'A = A & #, C = N', flags: NZC },
  ALR: { also: ['ASR'], does: 'ANDs the value into A, then shifts A right (LSR)', formula: 'A = (A & #) >> 1', flags: NZC },
  ARR: { also: [], does: 'ANDs the value into A, then rotates A right (ROR); the carry and overflow come from bits 6 and 5 of the result', formula: 'A = (A & #) ror 1, C = bit 6, V = bit 6 ^ bit 5', flags: NVZC, note: 'Decimal mode changes the result.' },
  AXS: { also: ['SBX'], does: 'sets X to A AND X minus the value, without the borrow, and sets the carry as CMP does', formula: 'X = (A & X) - #', flags: NZC },
  XAA: { also: ['ANE'], does: 'ANDs X and the value into A, after ORing A with a constant the chip decides', formula: 'A = (A | c) & X & #', flags: NZ, unstable: 'the constant c ($00, $ee, $ef, $fe, $ff ...) depends on the chip and its temperature' },
  AHX: { also: ['SHA', 'AXA'], does: 'stores A AND X AND the high byte of the address + 1', formula: 'M = A & X & (H + 1)', flags: [], unstable: HIGH },
  TAS: { also: ['SHS', 'XAS'], does: 'sets the stack pointer to A AND X, then stores it AND the high byte of the address + 1', formula: 'S = A & X, M = S & (H + 1)', flags: [], unstable: HIGH },
  SHY: { also: ['SYA', 'SAY'], does: 'stores Y AND the high byte of the address + 1', formula: 'M = Y & (H + 1)', flags: [], unstable: HIGH },
  SHX: { also: ['SXA'], does: 'stores X AND the high byte of the address + 1', formula: 'M = X & (H + 1)', flags: [], unstable: HIGH },
  LAS: { also: ['LAR', 'LAE'], does: 'loads A, X and the stack pointer with the memory AND the stack pointer', formula: 'A = X = S = M & S', flags: NZ },
  JAM: { also: ['KIL', 'HLT'], does: 'stops the CPU: only a reset brings it back', formula: 'the CPU hangs', flags: [] },
};

/** the opcodes whose mnemonic says less than they do */
const BY_OPCODE: Record<number, Entry> = {
  0xab: { also: ['LXA', 'OAL'], does: 'loads A and X with the value ANDed with A ORed with a constant the chip decides', formula: 'A = X = (A | c) & #', flags: NZ, unstable: 'the constant c ($00, $ee, $ff ...) depends on the chip and its temperature' },
  0xeb: { also: ['USBC'], does: 'subtracts the value from A with the borrow: the same as SBC # ($e9)', formula: 'A = A - # - (1 - C)', flags: NVZC },
};

/** What the undocumented opcode `op` does; null for a documented one. */
export function undocumentedOpcode(op: number): UndocumentedInfo | null {
  const o = OPC[op & 0xff];
  if (!o || !o.ill) return null;
  const nop: Entry | null = o.mn !== 'NOP' ? null
    : o.mode === 'imp' ? { also: [], does: 'does nothing, as NOP ($ea) does', formula: '-', flags: [] }
    : o.mode === 'imm' ? { also: ['DOP', 'SKB'], does: 'does nothing: it skips the byte after it', formula: '-', flags: [] }
    : { also: o.len === 2 ? ['DOP', 'SKB'] : ['TOP', 'SKW'], does: 'does nothing but read the address (a read of I/O still counts: $dc0d acknowledges a CIA interrupt)', formula: '-', flags: [] };
  const e = BY_OPCODE[o.op] ?? nop ?? BY_NAME[o.mn];
  if (!e) return null;
  return { mn: o.mn, ...e, unstable: o.unstable ? e.unstable ?? 'real chips do not all agree on it' : null };
}

/** The undocumented opcode `op` described in a few lines (a tooltip); null for a documented one. `byName`: only its
 *  mnemonic is known (not the opcode and addressing mode, which the first line then leaves out). */
export function undocumentedText(op: number, byName = false): string | null {
  const u = undocumentedOpcode(op);
  if (!u) return null;
  const which = byName ? '' : ` ($${(op & 0xff).toString(16).padStart(2, '0')}, ${OPC[op & 0xff].mode})`;
  return [
    `${u.mn.toLowerCase()}${which} - undocumented opcode${u.also.length ? `, also called ${u.also.join(', ').toLowerCase()}` : ''}`,
    `${u.does[0].toUpperCase()}${u.does.slice(1)}.`,
    ...(u.formula !== '-' ? [u.formula] : []),
    `Flags: ${u.flags.length ? u.flags.join(' ') : 'none change'}`,
    ...(u.note ? [u.note] : []),
    ...(u.unstable ? [`Unstable: ${u.unstable}.`] : []),
  ].join('\n');
}
