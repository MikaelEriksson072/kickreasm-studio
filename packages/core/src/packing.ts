/* =====================================================================
 * Packed (crunched) programs: is a loaded PRG a decruncher plus compressed data? Runs after analyze() and
 * changes nothing in the analysis; the app reports it and unpacks it with the built-in unpacker (unpacker.ts), or with an
 * external one (unp64).
 *
 * The signs, calibrated on a few hundred PRGs from the CSDB archive:
 *  - compressed data: 1 KB windows with at least 7.2 bits of entropy per byte (code is near 6, text and
 *    graphics lower; modern crunchers give 7.5-7.95 throughout)
 *  - almost no code that can be traced: the decruncher copies itself and jumps to the copy, which a static
 *    trace cannot follow, so a packed file shows a few dozen bytes of code (older crunchers also give less
 *    entropy, about 6.5-7, so this sign counts on its own when the rest is not plain)
 *  - the name of a packer or a "crunched by" line in the bytes (ASCII, PETSCII or screen codes)
 * ===================================================================== */
import type { Addr, AnalysisResult } from './types';

export interface PackingInfo {
  /** index of the file in the analysis */
  file: number;
  verdict: 'packed' | 'maybe';
  size: number;
  /** traced code bytes in the file */
  codeBytes: number;
  /** entropy (bits per byte) of the bytes that are not code */
  entropy: number;
  /** share of the file's 1 KB windows that look compressed (at least 7.2 bits per byte) */
  packedShare: number;
  /** where the decruncher starts: the program start */
  decruncher: Addr | null;
  /** the packer named in the file, or the text that names one */
  signature: string | null;
  reasons: string[];
}

const WINDOW = 1024, STEP = 512, HIGH = 7.2;

/** Packer names (and phrases) as they appear in decrunchers and crunched files, lower case. */
const SIGNATURES: [RegExp, string][] = [
  [/exomizer/, 'Exomizer'], [/pucrunch/, 'PuCrunch'], [/byte ?boozer/, 'ByteBoozer'], [/tscrunch/, 'TSCrunch'],
  [/subsizer/, 'Subsizer'], [/level[- ]?crusher/, 'Level Crusher'], [/time ?cruncher/, 'Time Cruncher'],
  [/\bdali\b/, 'Dali'], [/\bzx0\b/, 'ZX0'], [/cruncher ab|ab cruncher/, 'Cruncher AB'], [/matcham/, 'Matcham'],
  [/sledgehammer/, 'Sledgehammer'], [/compactor/, 'a compactor'],
  [/(?:crunched|packed|compressed) (?:by|with)/, 'a cruncher'], [/cruncher|crunched|packer\b/, 'a cruncher'],
];

const entropy = (b: ArrayLike<number>, s = 0, e = b.length): number => {
  const c = new Uint32Array(256);
  for (let i = s; i < e; i++) c[b[i]]++;
  let h = 0;
  const n = e - s;
  for (const k of c) if (k) { const p = k / n; h -= p * Math.log2(p); }
  return h;
};

/** The file's bytes as text three ways: ASCII, PETSCII (upper case set) and screen codes, lower case. */
function texts(b: Uint8Array): string[] {
  const ch = (f: (x: number) => string | null) => Array.from(b, x => f(x) ?? ' ').join('');
  return [
    ch(x => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x).toLowerCase() : null)),
    ch(x => (x >= 0x41 && x <= 0x5a ? String.fromCharCode(x + 32) : x >= 0xc1 && x <= 0xda ? String.fromCharCode(x - 0x60) : x >= 0x20 && x < 0x40 ? String.fromCharCode(x) : null)),
    ch(x => (x >= 1 && x <= 26 ? String.fromCharCode(96 + x) : x >= 0x20 && x < 0x40 ? String.fromCharCode(x) : null)),
  ];
}

export function packerSignature(bytes: Uint8Array): string | null {
  const t = texts(bytes);
  for (const [re, name] of SIGNATURES) if (t.some(s => re.test(s))) return name;
  return null;
}

/** Whether file `file` of the analysis looks packed; null when it does not (or is too small to tell). */
export function detectPacking(A: AnalysisResult, file = 0): PackingInfo | null {
  const f = A.files[file];
  if (!f || f.bytes.length < 1024) return null;
  const s = f.load, e = Math.min(0x10000, s + f.bytes.length), size = e - s;
  const stub = A.basics.find(b => b.start >= s && b.start < e);
  let codeBytes = 0;
  const data: number[] = [];
  for (let a = s; a < e; a++) {
    if (A.insLen[a] > 0 || A.codeOwner[a] >= 0) codeBytes++;
    else if (!stub || a < stub.start || a >= stub.end) data.push(A.mem[a]);
  }
  const H = data.length ? entropy(data) : 0;
  let windows = 0, high = 0;
  for (let a = s; a + WINDOW <= e; a += STEP) { windows++; if (entropy(A.mem, a, a + WINDOW) >= HIGH) high++; }
  const packedShare = windows ? high / windows : 0;
  const signature = packerSignature(f.bytes);
  const tinyCode = codeBytes <= Math.max(64, size * 0.03) && codeBytes < 400;

  const reasons: string[] = [];
  if (packedShare > 0) reasons.push(`${Math.round(packedShare * 100)}% of the file looks compressed (1 KB windows with at least ${HIGH} bits of entropy per byte)`);
  reasons.push(`${H.toFixed(2)} bits of entropy per byte outside the code`);
  if (tinyCode) reasons.push(`only ${codeBytes} bytes of code can be traced: a decruncher that moves itself before it runs`);
  if (signature) reasons.push(`the file names ${signature}`);

  let verdict: PackingInfo['verdict'] | null = null;
  if (packedShare >= 0.5 || (tinyCode && H >= 7) || (signature && (packedShare > 0 || (tinyCode && H >= 6.3)))) verdict = 'packed';
  // some compressed-looking windows in a file with plenty of code are music or graphics (an unpacked program)
  else if ((packedShare >= 0.2 && codeBytes < size * 0.1) || (tinyCode && H >= 6.4)) verdict = 'maybe';
  if (!verdict) return null;
  return { file, verdict, size, codeBytes, entropy: H, packedShare, decruncher: A.entry, signature, reasons };
}
