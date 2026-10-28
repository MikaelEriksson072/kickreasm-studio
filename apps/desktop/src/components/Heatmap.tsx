/* Memory heatmap (inspector, 256 × 256, one pixel per byte) and the sidebar's 64 KB strip. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { findBlock, h2, h4, kindInfo, type Addr, type AnalysisResult } from '@mimir/core';
import { cssVar, GROUP_ORDER, groupOfType, hexRgb } from '../lib/util';
import type { Sel } from '../lib/types';
import type { TypeGroup } from '@mimir/core';

export type Rgb = [number, number, number];
export interface CanvasColors { g: Record<TypeGroup, Rgb>; empty: Rgb; accent: Rgb; heat: Rgb; fg: Rgb }
export type HeatMode = 'type' | 'bytes' | 'refs';

export function useCanvasColors(theme: string): CanvasColors {
  return useMemo(() => {
    const g = {} as Record<TypeGroup, Rgb>;
    for (const k of GROUP_ORDER) g[k] = hexRgb(cssVar(`--g-${k}`));
    return { g, empty: hexRgb(cssVar('--map-empty')), accent: hexRgb(cssVar('--accent')), heat: hexRgb(cssVar('--g-table')), fg: hexRgb(cssVar('--fg')) };
  }, [theme]);
}

interface HeatmapProps {
  A: AnalysisResult; mode: HeatMode; cursor: Addr | null; sel: Sel | null; colors: CanvasColors; fit: boolean;
  onNavigate: (a: Addr) => void; onSelect: (start: Addr, end: Addr) => void;
}

export function Heatmap({ A, mode, cursor, sel, onNavigate, onSelect, colors, fit }: HeatmapProps) {
  const ref = useRef<HTMLCanvasElement>(null), ovl = useRef<HTMLCanvasElement>(null);
  const span = useMemo(() => {
    if (!fit) return { p0: 0, rows: 256 };
    let lo = 256, hi = -1;
    for (let p = 0; p < 256; p++) for (let i = 0; i < 256; i += 16) if (A.owner[p * 256 + i] >= 0 || A.owner[p * 256 + 255] >= 0) { lo = Math.min(lo, p); hi = Math.max(hi, p); break; }
    if (hi < 0) return { p0: 0, rows: 256 };
    return { p0: lo, rows: hi - lo + 1 };
  }, [A, fit]);
  const [hover, setHover] = useState<{ a: Addr; x: number; y: number } | null>(null);
  const drag = useRef<Addr | null>(null);
  const heat = useMemo(() => {
    const h = new Uint16Array(65536);
    for (const [to, l] of A.xrefs) if (to >= 0 && to < 65536) h[to] = Math.min(65535, l.length);
    return h;
  }, [A]);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext('2d')!; const img = ctx.createImageData(256, span.rows); const d = img.data;
    const { tm, mem, owner } = A;
    const a0 = span.p0 * 256;
    for (let a = a0; a < a0 + span.rows * 256; a++) {
      let c: number[];
      if (owner[a] < 0) c = colors.empty;
      else if (mode === 'type') {
        const base = colors.g[groupOfType(tm[a])]; const k = 0.78 + (mem[a] / 255) * 0.32;
        c = [Math.min(255, base[0] * k), Math.min(255, base[1] * k), Math.min(255, base[2] * k)];
      } else if (mode === 'bytes') { const v = mem[a] / 255; c = colors.empty.map((e, i) => e + (colors.fg[i] - e) * (0.12 + v * 0.88)); }
      else { const v = heat[a] ? Math.min(1, 0.35 + Math.log2(1 + heat[a]) / 4) : 0; c = v ? colors.empty.map((e, i) => e + (colors.heat[i] - e) * v) : colors.empty.map((e, i) => e + (colors.fg[i] - e) * 0.06); }
      const o = (a - a0) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [A, mode, colors, heat, span]);
  useEffect(() => {
    const cv = ovl.current; if (!cv) return;
    const ctx = cv.getContext('2d')!; ctx.clearRect(0, 0, 512, 512);
    const sy = 512 / span.rows, y0 = span.p0;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    if (sel && sel.end > sel.start) for (let a = sel.start; a < sel.end; a++) { const r = (a >> 8) - y0; if (r >= 0 && r < span.rows) ctx.fillRect((a & 255) * 2, r * sy, 2, Math.max(2, sy)); }
    if (cursor != null) { const r = (cursor >> 8) - y0; ctx.strokeStyle = cssVar('--accent-hi'); ctx.lineWidth = 2; ctx.strokeRect((cursor & 255) * 2 - 5, r * sy + sy / 2 - 6, 12, 12); }
  }, [cursor, sel, span]);
  const addrAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(255, Math.floor((e.clientX - r.left) / r.width * 256)));
    const y = Math.max(0, Math.min(span.rows - 1, Math.floor((e.clientY - r.top) / r.height * span.rows)));
    return { a: (span.p0 + y) * 256 + x, x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const b = hover ? findBlock(A.blocks, hover.a) : null;
  return (
    <div className="heat-wrap">
      <div className="heat" role="img" aria-label="Memory map of all 64 KB, one pixel per byte, colored by classification"
        onMouseMove={e => { const p = addrAt(e); setHover(p); if (drag.current != null) onSelect(Math.min(drag.current, p.a), Math.max(drag.current, p.a) + 1); }}
        onMouseLeave={() => setHover(null)}
        onMouseDown={e => { drag.current = addrAt(e).a; }}
        onMouseUp={e => { const p = addrAt(e); if (drag.current === p.a) onNavigate(p.a); drag.current = null; }}>
        <canvas ref={ref} width="256" height={span.rows} />
        <canvas ref={ovl} width="512" height="512" className="heat-ovl" />
        <div className="heat-axis">{[0, 0.25, 0.5, 0.75].map(f => <span key={f}>${h4((span.p0 + Math.floor(span.rows * f)) * 256)}</span>)}</div>
      </div>
      {hover && (
        <div className="heat-tip" style={{ left: Math.min(hover.x + 12, 150), top: hover.y + 14 }}>
          <b>${h4(hover.a)}</b> <span className="mono">${h2(A.mem[hover.a])}</span><br />
          {A.owner[hover.a] < 0 ? 'not loaded' : `${b ? kindInfo(b.type).label : ''}${A.xrefs.get(hover.a) ? ` · ${A.xrefs.get(hover.a)!.length} refs` : ''}`}
        </div>
      )}
    </div>
  );
}

/** Sidebar strip: 64 KB as a vertical bar, 256 bytes per pixel row. */
export function MemoryStrip({ A, colors, cursor, onNavigate }: { A: AnalysisResult; colors: CanvasColors; cursor: Addr | null; onNavigate: (a: Addr) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext('2d')!; const img = ctx.createImageData(16, 256);
    for (let y = 0; y < 256; y++) {
      const counts: Partial<Record<TypeGroup, number>> = {};
      for (let i = 0; i < 256; i++) { const a = y * 256 + i; if (A.owner[a] >= 0) { const g = groupOfType(A.tm[a]); counts[g] = (counts[g] || 0) + 1; } }
      let x = 0;
      for (const g of GROUP_ORDER) { const n = Math.round((counts[g] || 0) / 16); for (let k = 0; k < n && x < 16; k++, x++) { const o = (y * 16 + x) * 4; const c = colors.g[g]; img.data.set([c[0], c[1], c[2], 255], o); } }
      for (; x < 16; x++) { const o = (y * 16 + x) * 4; const c = colors.empty; img.data.set([c[0], c[1], c[2], 255], o); }
    }
    ctx.putImageData(img, 0, 0);
  }, [A, colors]);
  return (
    <div className="strip-wrap">
      <div className="strip-scale">{['$0000', '$4000', '$8000', '$c000', '$ffff'].map(t => <span key={t}>{t}</span>)}</div>
      <div className="strip" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onNavigate(Math.floor((e.clientY - r.top) / r.height * 256) * 256); }}>
        <canvas ref={ref} width="16" height="256" />
        {cursor != null && <div className="strip-cur" style={{ top: `${(cursor / 65536) * 100}%` }} />}
      </div>
    </div>
  );
}
