import type { Addr } from '../types';
import { OPC, type OpcodeInfo } from './opcodes';

export interface Decoded {
  pc: Addr;
  info: OpcodeInfo;
  /** operand value (byte or word), null for implied/accumulator */
  v: number | null;
  /** branch/jump/memory target, null for immediates and implied */
  target: Addr | null;
}

export function decode(mem: Uint8Array, pc: Addr): Decoded {
  const info = OPC[mem[pc]];
  const b1 = mem[(pc + 1) & 0xffff], b2 = mem[(pc + 2) & 0xffff];
  const v = info.len === 2 ? b1 : info.len === 3 ? (b1 | (b2 << 8)) : null;
  let target: Addr | null = null;
  if (info.mode === 'rel') target = (pc + 2 + ((b1 ^ 0x80) - 0x80)) & 0xffff;
  else if (v != null && info.mode !== 'imm') target = v;
  return { pc, info, v, target };
}
