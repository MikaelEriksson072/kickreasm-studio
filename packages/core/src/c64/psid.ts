import type { Addr } from '../types';

/** PSID v2 file: 0x7C byte header + load address + data. */
export function makePsid(data: Uint8Array, load: Addr, init: Addr, play: Addr, name?: string): Uint8Array {
  const out = new Uint8Array(0x7c + 2 + data.length);
  const be16 = (o: number, v: number) => { out[o] = (v >> 8) & 0xff; out[o + 1] = v & 0xff; };
  out.set([0x50, 0x53, 0x49, 0x44], 0);
  be16(4, 2); be16(6, 0x7c); be16(8, 0); be16(0x0a, init); be16(0x0c, play); be16(0x0e, 1); be16(0x10, 1);
  const str = (o: number, s: string) => { for (let i = 0; i < 31 && i < s.length; i++) out[o + i] = s.charCodeAt(i) & 0x7f; };
  str(0x16, name || 'Ripped music'); str(0x36, '<?>'); str(0x56, 'Ripped with KickReasm Studio');
  be16(0x76, 0x14);
  out[0x7c] = load & 0xff; out[0x7d] = load >> 8;
  out.set(data, 0x7e);
  return out;
}

export interface PsidInfo {
  location: Addr;
  init: Addr;
  play: Addr;
  size: number;
  songs: number;
  startSong: number;
  name: string;
  author: string;
  data: Uint8Array;
}

export function parsePsid(u8: Uint8Array): PsidInfo {
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (u8.length < 0x7c || (magic !== 'PSID' && magic !== 'RSID')) throw new Error('not a PSID/RSID file');
  const be = (o: number) => (u8[o] << 8) | u8[o + 1];
  const off = be(6);
  let load = be(8), data = u8.subarray(off);
  if (load === 0) { load = data[0] | (data[1] << 8); data = data.subarray(2); }
  const str = (o: number) => String.fromCharCode(...u8.subarray(o, o + 32)).replace(/\0.*$/, '');
  return { location: load, init: be(0x0a) || load, play: be(0x0c), size: data.length, songs: be(0x0e), startSong: be(0x10), name: str(0x16), author: str(0x36), data };
}
