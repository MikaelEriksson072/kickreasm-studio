/* Test data and the tools the tests compare with, when they are installed: Exomizer 3.1.1, Kick Assembler and
 * VICE's c1541. A test that needs one is skipped without it. */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const first = (paths: (string | undefined)[]): string | null => paths.find(p => p && existsSync(p)) ?? null;

export const EXOMIZER = first([process.env.EXOMIZER, 'C:/C64/exomizer-3.1.1/win32/exomizer.exe']);
export const KICKASS = first([process.env.KICKASS, 'C:/C64/KickAssembler/KickAss.jar']);
export const JAVA = (() => { try { execFileSync('java', ['-version'], { stdio: 'ignore' }); return 'java'; } catch { return null; } })();
export const C1541 = first([process.env.C1541, 'C:/C64/vice/GTK3VICE-3.10-win64/bin/c1541.exe']);

/** A deterministic random number generator (xorshift). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}

/**
 * Bytes that crunch like a C64 program's: runs, copies of earlier stretches (some changed), counting tables,
 * text and noise, in random order.
 */
export function programLike(n: number, seed = 1): Uint8Array {
  const r = rng(seed), out = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    const kind = Math.floor(r() * 6), len = Math.min(n - i, 1 + Math.floor(r() * r() * 300));
    if (kind === 0) out.fill(Math.floor(r() * 256), i, i + len);
    else if (kind === 1 && i > 8) {
      const from = Math.floor(r() * i);
      for (let k = 0; k < len; k++) out[i + k] = r() < 0.03 ? Math.floor(r() * 256) : out[from + (k % Math.max(1, i - from))];
    } else if (kind === 2) { const b = Math.floor(r() * 256), step = 1 + Math.floor(r() * 4); for (let k = 0; k < len; k++) out[i + k] = (b + k * step) & 0xff; }
    else if (kind === 3) { const t = 'BROKKR AND SINDRI FORGED THE HAMMER. '; for (let k = 0; k < len; k++) out[i + k] = t.charCodeAt((i + k) % t.length); }
    else for (let k = 0; k < len; k++) out[i + k] = Math.floor(r() * 256) & (kind === 4 ? 0x3f : 0xff);
    i += len;
  }
  return out;
}

/** A BASIC line `0 SYS<sys>` at $0801 followed by the bytes, as memory from $0801. */
export function basicProgram(body: Uint8Array, sys = 0x0810): Uint8Array {
  const text = [0x9e, ...String(sys).split('').map(c => c.charCodeAt(0)), 0];
  const next = 0x0801 + 4 + text.length;
  const line = [next & 0xff, next >> 8, 0, 0, ...text, 0, 0];
  const out = new Uint8Array(line.length + body.length);
  out.set(line);
  out.set(body, line.length);
  return out;
}
