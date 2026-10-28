/* Graphics preview: sprites, charset, bitmap (hires or multicolor). */
import { useEffect, useMemo, useRef } from 'react';
import type { Addr } from '@mimir/core';
import { C64, hexRgb } from '../lib/util';

export type GfxMode = 'sprite' | 'chars' | 'bitmap';

export function GfxPreview({ mem, start, end, mode, mc }: { mem: Uint8Array; start: Addr; end: Addr; mode: GfxMode; mc: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const geom = useMemo(() => {
    const n = end - start;
    if (mode === 'sprite') { const count = Math.max(1, Math.min(32, Math.floor(n / 64))); const cols = Math.min(4, count); return { w: cols * 26, h: Math.ceil(count / cols) * 23, count, cols }; }
    if (mode === 'chars') { const count = Math.max(1, Math.min(256, Math.floor(n / 8))); const cols = 16; return { w: cols * 8, h: Math.ceil(count / cols) * 8, count, cols }; }
    return { w: 320, h: 200, count: 1, cols: 1 };
  }, [start, end, mode]);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(geom.w, geom.h); const d = img.data;
    const bg = hexRgb(C64[6]), pal = [bg, hexRgb(C64[14]), hexRgb(C64[7]), hexRgb(C64[1])];
    for (let i = 0; i < d.length; i += 4) { d[i] = 22; d[i + 1] = 20; d[i + 2] = 52; d[i + 3] = 255; }
    const px = (x: number, y: number, c: number[]) => { if (x < 0 || y < 0 || x >= geom.w || y >= geom.h) return; const o = (y * geom.w + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; };
    const drawByte = (b: number, x: number, y: number) => {
      if (mc) for (let k = 0; k < 4; k++) { const c = pal[(b >> (6 - k * 2)) & 3]; px(x + k * 2, y, c); px(x + k * 2 + 1, y, c); }
      else for (let k = 0; k < 8; k++) px(x + k, y, (b >> (7 - k)) & 1 ? pal[3] : pal[0]);
    };
    if (mode === 'sprite') {
      for (let s = 0; s < geom.count; s++) { const ox = (s % geom.cols) * 26 + 1, oy = Math.floor(s / geom.cols) * 23 + 1; for (let r = 0; r < 21; r++) for (let c = 0; c < 3; c++) drawByte(mem[(start + s * 64 + r * 3 + c) & 0xffff], ox + c * 8, oy + r); }
    } else if (mode === 'chars') {
      for (let ch = 0; ch < geom.count; ch++) { const ox = (ch % geom.cols) * 8, oy = Math.floor(ch / geom.cols) * 8; for (let r = 0; r < 8; r++) drawByte(mem[(start + ch * 8 + r) & 0xffff], ox, oy + r); }
    } else {
      for (let cy = 0; cy < 25; cy++) for (let cxx = 0; cxx < 40; cxx++) for (let r = 0; r < 8; r++) drawByte(mem[(start + (cy * 40 + cxx) * 8 + r) & 0xffff], cxx * 8, cy * 8 + r);
    }
    ctx.putImageData(img, 0, 0);
  }, [mem, start, end, mode, mc, geom]);
  const scale = mode === 'bitmap' ? 1 : mode === 'sprite' ? (geom.count === 1 ? 4 : 2) : 2;
  return <canvas ref={ref} width={geom.w} height={geom.h} className="gfx" style={{ width: Math.min(geom.w * scale, 272), aspectRatio: `${geom.w} / ${geom.h}` }} aria-label={`${mode} preview`} />;
}
