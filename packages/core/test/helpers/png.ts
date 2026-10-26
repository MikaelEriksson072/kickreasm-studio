/* A PNG reader for the tests: 8-bit RGB or RGBA, not interlaced, as VICE writes its screenshots. */
import { inflateSync } from 'node:zlib';

export function readPng(b: Uint8Array): { width: number; height: number; pixel: (x: number, y: number) => [number, number, number] } {
  const u32 = (at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
  const width = u32(16), height = u32(20), type = b[25], bpp = type === 6 ? 4 : 3;
  if (b[24] !== 8 || (type !== 2 && type !== 6) || b[28] !== 0) throw new Error('only 8-bit RGB(A) PNGs without interlace');
  const idat: Uint8Array[] = [];
  for (let p = 8; p < b.length;) {
    const n = u32(p), t = String.fromCharCode(...b.subarray(p + 4, p + 8));
    if (t === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + n));
    p += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * bpp, px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[y * stride + i - bpp] : 0, up = y ? px[(y - 1) * stride + i] : 0, c = y && i >= bpp ? px[(y - 1) * stride + i - bpp] : 0;
      const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
      const pred = f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? up : c) : 0;
      px[y * stride + i] = (row[i] + pred) & 0xff;
    }
  }
  return { width, height, pixel: (x, y) => [px[y * stride + x * bpp], px[y * stride + x * bpp + 1], px[y * stride + x * bpp + 2]] };
}
