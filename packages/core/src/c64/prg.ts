import type { Addr } from '../types';

export interface ParsedPrg { name: string; load: Addr; bytes: Uint8Array }

/** Split a .prg into its 2-byte little-endian load address and payload. */
export function parsePrg(name: string, u8: Uint8Array): ParsedPrg {
  if (u8.length < 3) throw new Error(`${name}: too short to be a PRG (needs a 2-byte load address and data)`);
  const load = u8[0] | (u8[1] << 8);
  return { name, load, bytes: u8.slice(2) };
}

/** BASIC's and the KERNAL's work area: zero page, stack, input and keyboard buffers, vectors ($0002-$03ff). */
export const SYSTEM_AREA = { start: 0x0002, end: 0x0400 } as const;

/** A program loaded over the system area (a memory dump, say) cannot be started from BASIC, with RUN or SYS. */
export const overwritesSystemArea = (load: Addr, len: number): boolean => len > 0 && load < SYSTEM_AREA.end && load + len > SYSTEM_AREA.start;

/** Build a .prg (load address + payload). */
export function makePrg(load: Addr, bytes: Uint8Array): Uint8Array {
  const u = new Uint8Array(bytes.length + 2);
  u[0] = load & 255; u[1] = load >> 8;
  u.set(bytes, 2);
  return u;
}
