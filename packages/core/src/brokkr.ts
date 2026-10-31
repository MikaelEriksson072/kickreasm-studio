/* =====================================================================
 * Brokkr, the built-in cruncher (@mimir/brokkr, packages/brokkr): it packs the built PRGs, or ranges of them, as the
 * Pack view says (spec 13.8), into Exomizer 3's format or Brokkr's own. A self-extracting file is run in Brokkr's
 * emulated C64 before it is handed over, and compared with what was packed; a mem file's stream is decrunched
 * again. The result has the shape of an Exomizer run, so the Pack view shows either the same way, with the command
 * line of the standalone Brokkr that makes the same file.
 * ===================================================================== */
import {
  BrokkrError, crunchBrk, crunchData, memBrkFile, memCrunchOptions, memFile, sfxAsync, T, type CrunchOptions, type Crunched, type Start,
} from '@mimir/brokkr';
import type { PackPrefs } from './types';
import { packFileName, packImage, packInputs, packOutName, packParts, shellWord, type ExomizerReport, type PackCheck } from './pack';
import { h2, h4 } from './util/hex';

/** A crunch: here (the default), or on a pool of threads (node/brokkr.ts). */
export type BrokkrCrunch = (data: Uint8Array, o: CrunchOptions) => Promise<Crunched>;
export const crunchHere: BrokkrCrunch = async (d, o) => crunchData(d, o);

export interface BrokkrPack {
  ok: boolean;
  /** what Brokkr's command line would print */
  output: string;
  /** the standalone Brokkr's command that makes the same file, in the pack folder */
  argv: string[];
  ms: number;
  /** the packed file's name (made unique against the inputs) and bytes */
  name?: string;
  prg?: Uint8Array;
  /** the inputs as the command names them, to write next to the packed file */
  inputs: { name: string; prg: Uint8Array }[];
  packed: { start: number; length: number } | null;
  report: ExomizerReport;
  check: PackCheck | null;
  error?: string;
}

const $4 = (v: number) => `$${h4(v)}`;
const $2 = (v: number) => `$${h2(v)}`;
const range = (s: number, e: number) => `${$4(s)}–${$4(e - 1)}`;

/** The standalone Brokkr's arguments for these settings (`inputs` as packInputs names them). */
export function brokkrArgs(p: PackPrefs, inputs: readonly string[], out: string): string[] {
  const args = ['brokkr', p.mode];
  const own = p.format === 'brokkr';
  if (own) args.push('--format', 'brokkr');
  if (p.mode === 'sfx') {
    args.push('--start', p.start === 'jmp' ? $4(p.jmp ?? 0) : p.start);
    if (p.effect === 'none') args.push('--no-effect');
    if (p.ramExit != null) args.push('--ram-exit', $2(p.ramExit));
    if (p.irqExit != null) args.push('--irq', p.irqExit ? 'on' : 'off');
  } else {
    if (p.forward && !own) args.push('-f');
    if (p.memLoad !== 'auto') args.push('-l', p.memLoad === 'none' ? 'none' : $4(p.memLoad));
  }
  if (p.compat && !own) args.push('-T', p.mode === 'mem' ? String(T.NO_LIT_SEQ | T.NO_MIRRORS) : String(T.NO_LIT_SEQ));
  if (p.effort !== 'normal') args.push('--effort', p.effort);
  return [...args, '-o', out, ...inputs];
}

const empty = (): ExomizerReport => ({ crunched: null, saved: null, layout: [], decruncher: [], entry: null, errors: [] });

/** Pack the built PRGs (load address first, in project order) as `prefs` says, with Brokkr. */
export async function packWithBrokkr(files: readonly { name: string; prg: Uint8Array }[], prefs: PackPrefs, crunch: BrokkrCrunch = crunchHere): Promise<BrokkrPack> {
  const t0 = performance.now();
  // the inputs get names the command line reads as one file name, distinct from each other and from the output
  const used = new Set<string>();
  const named = files.map((f, i) => {
    let name = packFileName(f.name);
    if (used.has(name.toLowerCase())) name = packFileName(`${f.name.replace(/\.prg$/i, '')}-${i + 1}`);
    used.add(name.toLowerCase());
    return { name, load: f.prg[0] | (f.prg[1] << 8), bytes: f.prg.subarray(2), prg: f.prg };
  });
  const out = packOutName(prefs, named[0]?.name ?? 'packed.prg');
  const parts = packParts(prefs.ranges, named);
  const image = packImage(parts);
  const argv = brokkrArgs(prefs, packInputs(parts), out);
  const base = { argv, inputs: named.map(f => ({ name: f.name, prg: f.prg })), packed: image && { start: image.start, length: image.bytes.length } };
  const fail = (error: string, output = ''): BrokkrPack => ({ ok: false, output, ms: performance.now() - t0, report: empty(), check: null, error, ...base });
  if (!files.length || files.some(f => f.prg.length < 3)) return fail('There is no built PRG to pack.');
  if (used.has(out.toLowerCase())) return fail(`The packed file cannot be called ${out}: that is the name of a file it packs.`);
  if (!image) return fail('None of the chosen blocks is in the built files.');
  if (prefs.mode === 'sfx' && prefs.start === 'jmp' && prefs.jmp == null) return fail('Enter the address the program starts at after decrunching.');
  const own = prefs.format === 'brokkr';
  if (own && prefs.mode === 'mem' && prefs.forward) return fail("Brokkr's own format is decrunched backward: turn off Forward, or pack with Exomizer's format.");

  const crunchOptions: CrunchOptions = { effort: prefs.effort, protocol: prefs.compat ? { traits: T.NO_LIT_SEQ } : {} };
  const lines = [`${named.map(f => f.name).join(', ')}: ${range(image.start, image.start + image.bytes.length)}, ${image.bytes.length} bytes`];
  try {
    if (prefs.mode === 'sfx') {
      const start: Start = prefs.start === 'jmp' ? prefs.jmp! : prefs.start;
      const r = await sfxAsync(image.bytes, image.start, {
        start, ramExit: prefs.ramExit ?? undefined, irqExit: prefs.irqExit ?? undefined, effect: prefs.effect !== 'none', crunch: crunchOptions,
        format: prefs.format,
      }, crunch);
      const layout = r.areas.filter(a => a.name !== 'File').map(a => ({ name: a.name, start: a.start, end: a.end, ...(a.note ? { note: a.note } : {}) }));
      for (const a of r.areas) lines.push(`  ${a.name.padEnd(16)} ${range(a.start, a.end)}${a.note ? `  ${a.note}` : ''}`);
      lines.push(`  $01 ${$2(r.ramDuring)} while decrunching, ${$2(r.ramExit)} after; interrupts ${r.irqExit ? 'on' : 'off'} after; ${r.basic ? 'RUN' : `jmp ${$4(r.entry)}`}`);
      lines.push(`  checked in an emulated C64: ${r.cycles} cycles (${(r.cycles / 985248).toFixed(2)} s)`);
      for (const w of r.warnings) lines.push(`  note: ${w}`);
      lines.push(`${out}: ${r.prg.length} bytes (${(100 * r.prg.length / image.bytes.length).toFixed(1)} % of ${image.bytes.length})`);
      const report: ExomizerReport = {
        crunched: r.stream.length, saved: { start: 0x0801, end: 0x0801 + r.prg.length - 2 }, layout,
        decruncher: [
          { what: 'RAM config', enter: '$37', during: $2(r.ramDuring), exit: $2(r.ramExit) },
          { what: 'IRQ enabled', enter: '1', during: '0', exit: r.irqExit ? '1' : '0' },
        ],
        entry: r.basic ? null : r.entry, errors: [],
      };
      const check: PackCheck = {
        status: 'same',
        text: `Decrunched in Brokkr's emulated C64: ${range(image.start, image.start + image.bytes.length)} has the same ${image.bytes.length} bytes, and it ${r.basic ? 'RUNs the BASIC program' : `starts at ${$4(r.entry)}`} after ${(r.cycles / 985248).toFixed(2)} s.`,
      };
      return { ok: true, output: lines.join('\n'), ms: performance.now() - t0, name: out, prg: r.prg, report, check, ...base };
    }
    const mo = { forward: prefs.forward, load: prefs.memLoad, crunch: crunchOptions };
    const data = image.bytes;
    const r = own
      ? memBrkFile(data, image.start, crunchBrk(data.slice().reverse(), { effort: prefs.effort }), mo)
      : memFile(data, image.start, await crunch(prefs.forward ? data : data.slice().reverse(), memCrunchOptions(mo)), mo);
    const stream = 'brk' in r ? r.brk : r.crunched;
    lines.push(`  in place it loads at ${range(r.inPlace.start, r.inPlace.end)} (safety ${stream.safety})`);
    for (const w of r.warnings) lines.push(`  note: ${w}`);
    lines.push(`${out}: ${r.bytes.length} bytes${r.at ? ` at ${range(r.at.start, r.at.end)}` : ''}`);
    const layout = [
      ...(r.at ? [{ name: 'Crunched data', start: r.at.start, end: r.at.end }] : []),
      { name: 'Decrunched data', start: image.start, end: image.start + data.length },
    ];
    const report: ExomizerReport = { crunched: stream.stream.length, saved: r.at, layout, decruncher: [], entry: null, errors: [] };
    const check: PackCheck = {
      status: 'same',
      text: `Brokkr decrunched the stream again: the same ${data.length} bytes. In place it loads at ${$4(r.inPlace.start)}${prefs.forward && !own ? ` and ends at ${$4(r.inPlace.end - 1)}` : ' or lower'}.${own ? " Decrunch it with Brokkr's decruncher of its own format (brokkr decruncher --format brokkr)." : ''}`,
    };
    return { ok: true, output: lines.join('\n'), ms: performance.now() - t0, name: out, prg: r.bytes, report, check, ...base };
  } catch (e) {
    const msg = e instanceof BrokkrError ? `${e.message}${e.hint ? ` ${e.hint}` : ''}` : (e as Error).message;
    const code = e instanceof BrokkrError ? `${e.code}: ` : '';
    return fail(msg, [...lines, `brokkr: ${code}${msg}`].join('\n'));
  }
}

/** The command as a line to show (and type in the pack folder). */
export const brokkrCommandText = (argv: readonly string[]): string => argv.map(shellWord).join(' ');
