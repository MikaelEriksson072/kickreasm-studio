/* Crunching to Brokkr's own format: parse with the format's prices, count what the coder makes of the parse, price
 * again from those counts, and parse again, keeping the smallest stream; then decrunch it again and compare. */
import { blockAverages, countTokens, pricesFrom, readBrk, writeBrk, type BrkPrices } from './brk.ts';
import { crunchData, matchesFor, PROFILES, type Effort, type Profile } from './crunch.ts';
import { protocol, type Tokens } from './format.ts';
import { parseBrk } from './parse-brk.ts';

export interface BrkCrunched {
  /** the stream in reading order */
  stream: Uint8Array;
  tokens: Tokens;
  /** stream bytes unread less data bytes to come, at worst: the in-place margin */
  safety: number;
  stats: { literals: number; matches: number; reps: number };
  rounds: number;
  ms: number;
}

export interface BrkOptions { effort?: Effort; profile?: Partial<Profile>; rounds?: number; progress?: (round: number, bytes: number) => void; /** the prices change every 1 << shift bytes (0: the file's average everywhere) */ shift?: number; weight?: number }

export function crunchBrk(d: Uint8Array, o: BrkOptions = {}): BrkCrunched {
  const t0 = performance.now();
  if (!d.length) throw new Error('There is nothing to crunch: the data is empty.');
  const prof = { ...PROFILES[o.effort ?? 'normal'], ...o.profile };
  const m = matchesFor(d, protocol(), prof);
  // the first prices: from the Exomizer-format parse, which knows nothing of the coder but is a good start
  const first = crunchData(d, { effort: 'fast', protocol: { traits: 1 } }).tokens;
  const shift = o.shift ?? 11;
  // the first round prices with the file's averages, the rest with the coder's prices block by block
  let prices: BrkPrices[] = [pricesFrom(countTokens(d, first))], pshift = 30;
  let best: { tokens: Tokens; stream: Uint8Array } = { tokens: first, stream: writeBrk(d, first) };
  let rounds = 0, worse = 0;
  for (let r = 1; r <= (o.rounds ?? (prof.arrivals === 0 ? 2 : 6)); r++) {
    rounds = r;
    const { tokens } = parseBrk(d, m, prices, pshift, { arrivals: prof.arrivals, allLens: prof.allLens });
    const stream = writeBrk(d, tokens);
    if (stream.length < best.stream.length) { best = { tokens, stream }; worse = 0; } else if (++worse >= 2) break;
    o.progress?.(r, best.stream.length);
    if (shift) { prices = blockAverages(d, best.tokens, shift, o.weight ?? 16); pshift = shift; } else prices = [pricesFrom(countTokens(d, tokens))];
  }
  const back = readBrk(best.stream);
  if (back.data.length !== d.length || back.data.some((b, i) => b !== d[i])) {
    throw new Error("Brokkr's own check failed: its own format's stream does not decrunch to the data. This is a bug in Brokkr; please report it with the file.");
  }
  return { stream: best.stream, tokens: best.tokens, safety: back.safety, stats: back.tokens, rounds, ms: performance.now() - t0 };
}

