/* The files Exomizer writes, made by Brokkr: `raw` (a bare stream) and `mem` (a stream with the data's address,
 * loaded where it can be decrunched in place). Both are byte for byte what Exomizer 3.1's decrunchers read, so
 * exodecrunch.s, Krill's loader and the rest decrunch them as they decrunch Exomizer's own. The same files in
 * Brokkr's own format (memBrk, rawBrk) and its fast one (memFast, rawFast) are for Brokkr's decrunchers of them
 * (brkDecrunchSource, fastDecrunchSource). */
import { crunchBrk, type BrkCrunched, type BrkOptions } from './crunch-brk.ts';
import { crunchFast, type FastCrunched, type FastOptions } from './fast.ts';
import { crunchData, type CrunchOptions, type Crunched } from './crunch.ts';
import { BrokkrError, h4, span } from './errors.ts';
import { P, T } from './format.ts';

export interface RawOptions {
  /** decrunch backward (Exomizer's -b): the data and the stream from their ends */
  backward?: boolean;
  /** write the file reversed (Exomizer's -r) */
  reversed?: boolean;
  crunch?: CrunchOptions;
}

export interface RawResult { bytes: Uint8Array; crunched: Crunched }

/** A bare stream, as `exomizer raw` writes it (defaults: forward, -P39, -T0). */
export function raw(data: Uint8Array, o: RawOptions = {}): RawResult {
  return rawFile(crunchData(o.backward ? data.slice().reverse() : data, o.crunch), o);
}

/** The raw file of a crunch (of the data reversed when backward). */
export function rawFile(crunched: Crunched, o: RawOptions = {}): RawResult {
  return { bytes: rawBytes(crunched.stream, o), crunched };
}

const rawBytes = (stream: Uint8Array, o: RawOptions) => {
  const bytes = o.backward ? stream.slice().reverse() : stream;
  return o.reversed ? bytes.slice().reverse() : bytes;
};

/** A bare stream in Brokkr's own format: its bits in reading order (backward: the file reversed, read from its end). */
export function rawBrk(data: Uint8Array, o: { backward?: boolean; reversed?: boolean; crunch?: BrkOptions } = {}): { bytes: Uint8Array; brk: BrkCrunched } {
  const brk = crunchBrk(o.backward ? data.slice().reverse() : data, o.crunch);
  return { bytes: rawBytes(brk.stream, o), brk };
}

export interface MemOptions {
  /** crunch forward (Exomizer's -f); default backward */
  forward?: boolean;
  /** the file's load address: 'auto' where it decrunches in place (default), 'none' for no load address, or one */
  load?: 'auto' | 'none' | number;
  crunch?: CrunchOptions;
}

export interface MemResult {
  /** the file: with a load address unless `load: 'none'` */
  bytes: Uint8Array;
  /** where the crunched file lies in memory when it is loaded at its load address (null for 'none') */
  at: { start: number; end: number } | null;
  /** the lowest load address (backward) or highest end (forward) that decrunches in place */
  inPlace: { start: number; end: number };
  crunched: Crunched;
  warnings: string[];
}

/**
 * A stream with the data's address, as `exomizer mem` writes it (defaults: backward, -P39 and -T4, which
 * exodecrunch.s needs). Backward the file ends with the data's end address; forward it starts with the data's start.
 */
export function mem(data: Uint8Array, start: number, o: MemOptions = {}): MemResult {
  const crunch = memCrunchOptions(o);
  return memFile(data, start, crunchData(o.forward ? data : data.slice().reverse(), crunch), o);
}

/** The crunch options of mem: -T4 unless said otherwise, for exodecrunch.s. */
export const memCrunchOptions = (o: MemOptions): CrunchOptions => ({ ...o.crunch, protocol: { traits: T.NO_MIRRORS, ...o.crunch?.protocol } });

/** The mem file of a crunch of the data (reversed unless forward). */
export function memFile(data: Uint8Array, start: number, crunched: Crunched, o: MemOptions = {}): MemResult {
  const placed = place(data, start, crunched.stream, crunched.safety, o);
  const warnings: string[] = [];
  if (crunched.stats.traits & T.NO_MIRRORS) warnings.push('The stream has lengths that exodecrunch.s gets wrong (256 m + 0-2); crunch with -T4 for it.');
  if ((memCrunchOptions(o).protocol?.flags ?? 39) & P.FOUR_TABLES) warnings.push('The stream has a table for length 3 (-P+16): the decruncher needs it too.');
  return { ...placed, warnings: [...warnings, ...placed.warnings], crunched };
}

/** A bare stream in Brokkr's fast format, as rawBrk. */
export function rawFast(data: Uint8Array, o: { backward?: boolean; reversed?: boolean; crunch?: FastOptions } = {}): { bytes: Uint8Array; fast: FastCrunched } {
  const fast = crunchFast(o.backward ? data.slice().reverse() : data, o.crunch);
  return { bytes: rawBytes(fast.stream, o), fast };
}

export interface MemBrkResult extends Omit<MemResult, 'crunched'> { brk: BrkCrunched }
export interface MemFastResult extends Omit<MemResult, 'crunched'> { fast: FastCrunched }

/** A mem file in Brokkr's fast format, laid out as memBrk's. Backward only, as its decruncher reads. */
export function memFast(data: Uint8Array, start: number, o: Omit<MemOptions, 'forward' | 'crunch'> & { crunch?: FastOptions } = {}): MemFastResult {
  return memFastFile(data, start, crunchFast(data.slice().reverse(), o.crunch), o);
}

/** The mem file of a crunch of the data reversed in Brokkr's fast format. */
export function memFastFile(data: Uint8Array, start: number, fast: FastCrunched, o: Omit<MemOptions, 'forward' | 'crunch'> = {}): MemFastResult {
  return { ...place(data, start, fast.stream, fast.safety, o), fast };
}

/**
 * A mem file in Brokkr's own format: the stream reversed, then the data's end address, as Exomizer's backward mem
 * files are; loaded where it decrunches in place unless `load` says where. Backward only, as its decruncher reads.
 */
export function memBrk(data: Uint8Array, start: number, o: Omit<MemOptions, 'forward' | 'crunch'> & { crunch?: BrkOptions } = {}): MemBrkResult {
  return memBrkFile(data, start, crunchBrk(data.slice().reverse(), o.crunch), o);
}

/** The mem file of a crunch of the data reversed in Brokkr's own format. */
export function memBrkFile(data: Uint8Array, start: number, brk: BrkCrunched, o: Omit<MemOptions, 'forward' | 'crunch'> = {}): MemBrkResult {
  return { ...place(data, start, brk.stream, brk.safety, o), brk };
}

/** A stream with the data's address, at its load address; and where it decrunches in place. */
function place(data: Uint8Array, start: number, stream: Uint8Array, safety: number, o: Omit<MemOptions, 'crunch'>): Omit<MemResult, 'crunched'> {
  const end = start + data.length;
  if (!data.length) throw new BrokkrError('BRK-E100', 'There is nothing to crunch: the data is empty.');
  if (end > 0x10000) throw new BrokkrError('BRK-E101', `The data ${span(start, end)} goes past $ffff.`);
  const warnings: string[] = [];
  let body: Uint8Array, inPlace: { start: number; end: number };
  if (o.forward) {
    const s = stream;
    body = new Uint8Array(2 + s.length);
    body.set([start >> 8, start & 0xff]);
    body.set(s, 2);
    const last = end + safety;
    inPlace = { start: last - body.length, end: last };
  } else {
    const s = stream.slice().reverse();
    body = new Uint8Array(s.length + 2);
    body.set(s);
    body.set([end & 0xff, (end >> 8) & 0xff], s.length);
    const first = start - safety;
    inPlace = { start: first, end: first + body.length };
  }
  if (o.load === 'none') return { bytes: body, at: null, inPlace, warnings };
  const at = o.load === 'auto' || o.load == null ? inPlace.start : o.load;
  if (at < 0 || at + body.length > 0x10000) throw new BrokkrError('BRK-E160', `The crunched data (${body.length} bytes) does not fit at ${h4(at)}.`);
  if (o.load != null && o.load !== 'auto') {
    const overlapsData = at < end && at + body.length > start;
    if (overlapsData && (o.forward ? at + body.length < inPlace.end : at > inPlace.start)) {
      warnings.push(o.forward
        ? `Loaded at ${h4(at)} the crunched data ends at ${h4(at + body.length - 1)}, inside the data: in place it must end at ${h4(inPlace.end - 1)} or later, or the decruncher writes over bytes it has not read yet.`
        : `Loaded at ${h4(at)} the crunched data starts inside the data ${span(start, end)}: in place it must start at ${h4(inPlace.start)} or lower, or the decruncher writes over bytes it has not read yet.`);
    }
  }
  const bytes = new Uint8Array(2 + body.length);
  bytes.set([at & 0xff, at >> 8]);
  bytes.set(body, 2);
  return { bytes, at: { start: at, end: at + body.length }, inPlace, warnings };
}
