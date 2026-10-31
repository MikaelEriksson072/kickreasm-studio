/* Crunching: matches, then parse and encoding in turn until the stream stops shrinking, then the stream, which is
 * decrunched again and compared before it is returned. */
import {
  MATCH, P, SEQ, T, costs, protocol, readStream, reuses, streamSize, writeStream,
  type Encoding, type Protocol, type Tokens,
} from './format.ts';
import { findMatches, type MatchOptions, type Matches } from './match.ts';
import { encodingFor, covers } from './optimize.ts';
import { greedy, lazy, parse, type ParseOptions } from './parse.ts';

export type Effort = 'fast' | 'normal' | 'max';

export interface Profile extends ParseOptions, Pick<MatchOptions, 'nice' | 'depth'> {
  /** the most parse and encoding rounds */
  passes: number;
  /** the first encodings to refine: 1 from a lazy parse, 2 from a greedy one too */
  starts: number;
}

export const PROFILES: Record<Effort, Profile> = {
  fast: { arrivals: 0, allLens: 16, nice: 64, depth: 48, passes: 3, starts: 1 },
  normal: { arrivals: 4, allLens: 64, nice: 256, depth: 4096, passes: 100, starts: 2 },
  max: { arrivals: 8, allLens: 512, nice: 1024, depth: 1 << 20, passes: 100, starts: 2 },
};

export interface CrunchOptions {
  protocol?: Partial<Protocol>;
  effort?: Effort;
  /** a profile's settings changed */
  profile?: Partial<Profile>;
  /** crunch with this encoding instead of finding one (Exomizer's -e) */
  encoding?: Encoding;
  /** write the encoding in the stream (default); false: Exomizer's -E */
  header?: boolean;
  /** encodings to start from besides the one of a quick parse (from other files, or other runs) */
  seeds?: Encoding[];
  /** called after every round with its size in bits */
  progress?: (round: number, bits: number) => void;
}

export interface Crunched {
  /** the stream in reading order */
  stream: Uint8Array;
  encoding: Encoding;
  tokens: Tokens;
  bits: number;
  /** stream bytes unread less data bytes to come, at worst: the in-place margin */
  safety: number;
  stats: CrunchStats;
  rounds: number;
  ms: number;
}

export interface CrunchStats {
  literals: number; sequences: number; matches: number; reused: number;
  longest: number; farthest: number;
  /** the traits the stream uses (-T bits a decruncher must not leave out) */
  traits: number;
}

export function statsOf(t: Tokens, flags: number): CrunchStats {
  const reuse = reuses(t, flags);
  const s: CrunchStats = { literals: 0, sequences: 0, matches: 0, reused: 0, longest: 0, farthest: 0, traits: 0 };
  const four = flags & P.FOUR_TABLES ? 4 : 3;
  for (let i = 0; i < t.count; i++) {
    const len = t.len[i];
    if (t.kind[i] === MATCH) {
      s.matches++;
      if (reuse[i]) s.reused++;
      if (len > s.longest) s.longest = len;
      if (t.off[i] > s.farthest) s.farthest = t.off[i];
      if (len === 1 && !reuse[i]) s.traits |= T.NO_LEN1;
      if (len > 255 && (len & 255) < four) s.traits |= T.NO_MIRRORS;
    } else if (t.kind[i] === SEQ) {
      s.sequences++;
      s.traits |= T.NO_LIT_SEQ;
      if (len > s.longest) s.longest = len;
    } else s.literals++;
  }
  return s;
}

interface Candidate { tokens: Tokens; encoding: Encoding; bits: number; bytes: number }

const better = (a: Candidate, b: Candidate | null) => !b || a.bytes < b.bytes || (a.bytes === b.bytes && a.bits < b.bits);

/** Parse and encode in turn from an encoding until the stream stops shrinking. */
export function refine(d: Uint8Array, m: Matches, p: Protocol, start: Encoding, prof: Profile, header: boolean,
  fixed: boolean, progress?: (round: number, bits: number) => void): Candidate & { rounds: number } {
  let enc = start, best: Candidate | null = null, rounds = 0, worse = 0;
  for (let round = 1; round <= (fixed ? 1 : prof.passes); round++) {
    rounds = round;
    const { tokens } = parse(d, m, costs(enc, p), p, prof);
    const here = { tokens, encoding: enc, ...streamSize(d, tokens, enc, p.flags, header) };
    let improved = false;
    if (better(here, best)) { best = here; improved = true; }
    if (fixed) break;
    const next = encodingFor(tokens, p.flags);
    if (covers(next, tokens, p.flags)) {
      const re = { tokens, encoding: next, ...streamSize(d, tokens, next, p.flags, header) };
      if (better(re, best)) { best = re; improved = true; }
    }
    progress?.(round, best!.bits);
    if (improved) worse = 0; else if (++worse >= 2) break;
    if (sameEncoding(next, enc)) break;
    enc = next;
  }
  return { ...best!, rounds };
}

const sameEncoding = (a: Encoding, b: Encoding) => a.len.join() === b.len.join() && a.off.every((t, i) => t.join() === b.off[i].join());

export function matchesFor(d: Uint8Array, p: Protocol, prof: Profile): Matches {
  return findMatches(d, { maxLen: p.maxLen, maxOffset: p.maxOffset, nice: prof.nice, depth: prof.depth });
}

/** Crunch data, in the order the decruncher writes it, to a stream in the order it reads it. */
export function crunchData(d: Uint8Array, o: CrunchOptions = {}): Crunched {
  const t0 = performance.now();
  if (!d.length) throw new Error('There is nothing to crunch: the data is empty.');
  if (d.length > 0x10000 * 16) throw new Error(`${d.length} bytes is more than Brokkr crunches at once (1 MB).`);
  const p = protocol(o.protocol);
  const prof = { ...PROFILES[o.effort ?? 'normal'], ...o.profile };
  const header = o.header !== false;
  const m = matchesFor(d, p, prof);
  let best: (Candidate & { rounds: number }) | null = null;
  if (o.encoding) best = refine(d, m, p, o.encoding, prof, header, true, o.progress);
  else {
    const starts = [encodingFor(lazy(d, m, p), p.flags), ...(prof.starts > 1 ? [encodingFor(greedy(d, m, p), p.flags)] : []), ...(o.seeds ?? [])];
    for (const s of starts) {
      const r = refine(d, m, p, s, prof, header, false, o.progress);
      if (better(r, best)) best = r;
    }
  }
  return finish(d, best!, p, header, t0);
}

export function finish(d: Uint8Array, best: Candidate & { rounds: number }, p: Protocol, header: boolean, t0: number): Crunched {
  const stream = writeStream(d, best.tokens, best.encoding, p.flags, header);
  const back = readStream(stream, p.flags, header ? undefined : best.encoding);
  if (back.data.length !== d.length || back.data.some((b, i) => b !== d[i])) {
    const at = back.data.findIndex((b, i) => b !== d[i]);
    throw new Error(`Brokkr's own check failed: the stream decrunches to ${back.data.length} bytes${at >= 0 ? `, different from byte ${at} on` : ''}. This is a bug in Brokkr; please report it with the file.`);
  }
  return {
    stream, encoding: best.encoding, tokens: best.tokens, bits: best.bits, safety: back.safety,
    stats: statsOf(best.tokens, p.flags), rounds: best.rounds, ms: performance.now() - t0,
  };
}
