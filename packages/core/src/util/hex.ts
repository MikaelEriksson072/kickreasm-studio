import type { Addr } from '../types';

export const h2 = (v: number): string => (v & 0xff).toString(16).padStart(2, '0');
export const h4 = (v: number): string => (v & 0xffff).toString(16).padStart(4, '0');
export const $2 = (v: number): string => '$' + h2(v);
export const $4 = (v: number): string => '$' + h4(v);

/** Little-endian 16-bit word at `a`, wrapping at $ffff. */
export const word = (m: Uint8Array, a: Addr): number => m[a & 0xffff] | (m[(a + 1) & 0xffff] << 8);

export const now = (): number => (typeof performance !== 'undefined' ? performance : Date).now();
