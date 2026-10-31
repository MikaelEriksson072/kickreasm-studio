/* Brokkr's command line. `node src/cli.ts <command> [options] <files>`; --json prints one JSON object (the result,
 * or the error with its code), for editors and build tools. */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { brkDecrunchSource } from './brk-decruncher.ts';
import { crunchBrk, type BrkCrunched } from './crunch-brk.ts';
import { crunchData, PROFILES, type CrunchOptions, type Crunched, type Effort } from './crunch.ts';
import { Disk } from './d64.ts';
import { decrunchSource } from './decruncher.ts';
import { BrokkrError, h2, h4, span } from './errors.ts';
import { memBrkFile, memCrunchOptions, memFile, rawBrk, rawFile, type MemOptions } from './files.ts';
import { encodingText, parseEncoding, protocol, type Protocol } from './format.ts';
import { defaultThreads, Pool } from './node.ts';
import { crunchSearch } from './search.ts';
import { sfxAsync, type SfxFormat, type SfxResult, type Start } from './sfx.ts';

const USAGE = `Brokkr, a C64 cruncher (Exomizer 3 streams, smaller and faster; or its own, smaller still)

usage: brokkr <command> [options] <file>...

commands:
  sfx <file>...          a self-extracting program (loads at $0801, starts with RUN)
  mem <file>...          crunched data with its address, decrunched in place (exomizer mem)
  raw <file>...          a bare stream (exomizer raw)
  d64 <disk> [name]...   list a disk, or pack the files named on it (sfx where they start
                         with a SYS line, mem where not) into a new disk image
  decruncher             write Brokkr's 6502 decruncher of mem files as Kick Assembler source

files: a .prg (its load address first), <file>@<address> for raw bytes, or as Exomizer takes
a part of a file, <file>,<address>[,<offset>[,<length>]]; several are merged into one memory
image (a later one wins, gaps are zero).

options:
  -o <file>              the output (default: <first file>-brokkr.prg, .bin, .d64, .asm)
  --format <f>           exomizer (default): Exomizer 3's format; brokkr: Brokkr's own, about 6.5 %
                         smaller, decrunched about 8 times slower with 0.9-1.9 KB more RAM
  --effort <e>           fast, normal (default) or max (every core, a thorough search)
  --threads <n>          threads for --effort max (default ${defaultThreads()})
  --json                 print the result as JSON
  -q                     print nothing but errors
sfx:
  --start <s>            sys (the program's SYS, default), basic (RUN), or an address
  --ram-exit <$01>       $01 after decrunching (default $37)
  --irq <on|off>         interrupts after decrunching (default on with the KERNAL in)
  --no-effect            no border flashing
  --four-tables          a table of its own for length 3 (-P+16); "auto" tries both
mem:
  -f                     crunch forward
  -l <address|none>      the load address (default: in place)
raw:
  -b                     backward;  -r  write it reversed
exomizer's stream options (mem and raw, Exomizer's format):
  -P <bits>  -T <bits>  -M <length>  -m <offset>  -e <encoding>  -E (no encoding in the stream)
d64:
  --mode <sfx|mem>       pack every named file this way
decruncher:
  --zp <a> --table <a> --at <a> --four --no-reuse --effect --no-literal-sequences
  with --format brokkr: --zp <a> --table <page> (1.5 KB) --small (0.5 KB, slower) --at <a> --effect
`;

interface Args { _: string[]; [k: string]: string | boolean | string[] }

function parseArgs(argv: string[]): Args {
  const a: Args = { _: [] };
  const takes = new Set(['o', 'format', 'effort', 'threads', 'start', 'ram-exit', 'irq', 'four-tables', 'l', 'P', 'T', 'M', 'm', 'e', 'mode', 'zp', 'table', 'at']);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--') { a._.push(...argv.slice(i + 1)); break; }
    const m = /^--?([\w-]+)(?:=(.*))?$/.exec(t);
    if (!m || /^-\d/.test(t)) { a._.push(t); continue; }
    const [, k, v] = m;
    if (v != null) a[k] = v;
    else if (takes.has(k)) {
      if (i + 1 >= argv.length) throw new BrokkrError('BRK-E001', `The option ${t} needs a value.`);
      a[k] = argv[++i];
    } else a[k] = true;
  }
  return a;
}

/** a number as C64 people write it: $hex, 0xhex, %binary or decimal */
export function number(s: string, what: string): number {
  const t = s.trim();
  const v = /^\$[0-9a-f]+$/i.test(t) ? parseInt(t.slice(1), 16) : /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16)
    : /^%[01]+$/.test(t) ? parseInt(t.slice(1), 2) : /^\d+$/.test(t) ? Number(t) : NaN;
  if (!Number.isFinite(v)) throw new BrokkrError('BRK-E002', `${what} "${s}" is not a number ($c000, 49152 or %1100...).`);
  return v;
}

interface Input { name: string; start: number; bytes: Uint8Array }

function loadInputs(names: string[]): { inputs: Input[]; start: number; data: Uint8Array } {
  if (!names.length) throw new BrokkrError('BRK-E003', 'Name a file to crunch.');
  const inputs = names.map(n => {
    // file@address (raw bytes there), or Exomizer's file,address[,offset[,length]] (a part of the file)
    const at = /^(.*)@([$%\w]+)$/.exec(n), part = at ? null : /^(.*?),([$%\w]+)(?:,(\d+))?(?:,(\d+))?$/.exec(n);
    const file = at ? at[1] : part ? part[1] : n;
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(readFileSync(file)); }
    catch { throw new BrokkrError('BRK-E004', `"${file}" cannot be read.`); }
    if (at) {
      const start = number(at[2], 'The address');
      return { name: file, start, bytes: /\.prg$/i.test(file) ? bytes.subarray(2) : bytes };
    }
    if (part) {
      const body = /\.prg$/i.test(file) ? bytes.subarray(2) : bytes;
      const offset = part[3] != null ? Number(part[3]) : 0, length = part[4] != null ? Number(part[4]) : body.length - offset;
      if (offset + length > body.length) throw new BrokkrError('BRK-E011', `"${n}" asks for bytes ${offset}-${offset + length - 1} of a file of ${body.length}.`);
      return { name: file, start: number(part[2], 'The address'), bytes: body.subarray(offset, offset + length) };
    }
    if (bytes.length < 3) throw new BrokkrError('BRK-E005', `"${file}" is too short for a PRG (a load address and at least a byte).`, 'Give raw bytes an address: file.bin@$1000.');
    return { name: file, start: bytes[0] | (bytes[1] << 8), bytes: bytes.subarray(2) };
  });
  const start = Math.min(...inputs.map(i => i.start)), end = Math.max(...inputs.map(i => i.start + i.bytes.length));
  if (end > 0x10000) {
    const i = inputs.find(x => x.start + x.bytes.length > 0x10000)!;
    throw new BrokkrError('BRK-E006', `"${i.name}" at ${h4(i.start)} is ${i.bytes.length} bytes and goes past $ffff.`);
  }
  const data = new Uint8Array(end - start);
  for (const i of inputs) data.set(i.bytes, i.start - start);
  return { inputs, start, data };
}

function formatOf(a: Args): SfxFormat {
  const f = String(a.format ?? 'exomizer');
  if (f !== 'exomizer' && f !== 'brokkr') throw new BrokkrError('BRK-E012', `--format is exomizer or brokkr, not "${f}".`);
  if (f === 'brokkr') {
    const given = ['P', 'T', 'M', 'm', 'e', 'E', 'four-tables'].find(k => a[k] != null);
    if (given) throw new BrokkrError('BRK-E013', `-${given.length > 1 ? '-' : ''}${given} is an option of Exomizer's format, not of Brokkr's own.`);
  }
  return f;
}

function crunchOptions(a: Args): CrunchOptions {
  const effort = (a.effort ?? 'normal') as Effort;
  if (!['fast', 'normal', 'max'].includes(effort)) throw new BrokkrError('BRK-E007', `--effort is fast, normal or max, not "${effort}".`);
  const protocol: Partial<Protocol> = {};
  if (a.P != null) protocol.flags = protocolBits(String(a.P));
  if (a.T != null) protocol.traits = number(String(a.T), 'The -T value');
  if (a.M != null) protocol.maxLen = number(String(a.M), 'The -M length');
  if (a.m != null) protocol.maxOffset = number(String(a.m), 'The -m offset');
  const o: CrunchOptions = { effort, protocol };
  if (a.e != null) o.encoding = parseEncoding(String(a.e), protocol.flags ?? 39);
  if (a.E) o.header = false;
  return o;
}

/** -P as Exomizer reads it: a value, and +bits or -bits to set or clear (-P+16, -P39-32) */
function protocolBits(s: string): number {
  let v = 39;
  for (const m of s.matchAll(/([+-]?)(\d+)/g)) {
    const n = Number(m[2]);
    if (n > 63) throw new BrokkrError('BRK-E008', `-P bits go up to 63, not ${n}.`);
    v = m[1] === '+' ? v | n : m[1] === '-' ? v & ~n : n;
  }
  return v;
}

function makeCrunch(a: Args): { crunch: (d: Uint8Array, o: CrunchOptions) => Promise<Crunched>; close: () => Promise<void> } {
  let pool: Pool | null = null;
  return {
    crunch: async (d, o) => {
      if (o.effort !== 'max' || o.encoding) return crunchData(d, o);
      pool ??= new Pool(a.threads != null ? number(String(a.threads), '--threads') : defaultThreads());
      return crunchSearch(d, o, pool.runner({ data: d, protocol: protocol(o.protocol), profile: { ...PROFILES.max, ...o.profile }, header: o.header !== false }));
    },
    close: async () => { await pool?.close(); },
  };
}

const outName = (first: string, ext: string, given?: unknown) =>
  typeof given === 'string' ? given : `${first.replace(/\.(prg|bin|d64)$/i, '')}-brokkr${ext}`;

const stats = (c: Crunched) => ({
  format: 'exomizer', bytes: c.stream.length, bits: c.bits, rounds: c.rounds, ms: Math.round(c.ms), safety: c.safety,
  encoding: encodingText(c.encoding), ...c.stats,
});
const brkStats = (b: BrkCrunched) => ({ format: 'brokkr', bytes: b.stream.length, rounds: b.rounds, ms: Math.round(b.ms), safety: b.safety, ...b.stats });

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const json = !!a.json, quiet = !!a.q;
  const say = (s: string) => { if (!json && !quiet) console.log(s); };
  const [command, ...files] = a._;
  const t0 = performance.now();
  if (!command || a.help || a.h || command === 'help') { console.log(USAGE); return command ? 0 : 1; }
  const { crunch, close } = makeCrunch(a);
  try {
    let result: Record<string, unknown>;
    if (command === 'sfx' || command === 'mem' || command === 'raw') {
      const { inputs, start, data } = loadInputs(files);
      const format = formatOf(a);
      const o = crunchOptions(a);
      const inInfo = { files: inputs.map(i => ({ name: i.name, start: i.start, end: i.start + i.bytes.length })), start, end: start + data.length, bytes: data.length };
      say(`${inputs.map(i => basename(i.name)).join(', ')}: ${span(start, start + data.length)}, ${data.length} bytes`);
      if (command === 'sfx') {
        const startArg = String(a.start ?? 'sys');
        const st: Start = startArg === 'sys' || startArg === 'basic' ? startArg : number(startArg, 'The start address');
        const r: SfxResult = await sfxAsync(data, start, {
          start: st, ramExit: a['ram-exit'] != null ? number(String(a['ram-exit']), '$01') : undefined,
          irqExit: a.irq != null ? String(a.irq) === 'on' : undefined, effect: !a['no-effect'],
          fourTables: a['four-tables'] === 'auto' ? 'auto' : a['four-tables'] != null && a['four-tables'] !== 'off',
          format, crunch: o,
        }, crunch);
        const out = outName(files[0], '.prg', a.o);
        writeFileSync(out, r.prg);
        for (const area of r.areas) say(`  ${area.name.padEnd(16)} ${span(area.start, area.end)}${area.note ? `  ${area.note}` : ''}`);
        say(`  $01 ${h2(r.ramDuring)} while decrunching, ${h2(r.ramExit)} after; interrupts ${r.irqExit ? 'on' : 'off'} after; ${r.basic ? 'RUN' : `jmp ${h4(r.entry)}`}`);
        say(`  checked in an emulated C64: ${r.cycles} cycles (${(r.cycles / 985248).toFixed(2)} s)`);
        for (const w of r.warnings) say(`  note: ${w}`);
        say(`${out}: ${r.prg.length} bytes (${(100 * r.prg.length / data.length).toFixed(1)} % of ${data.length})`);
        result = { input: inInfo, output: { file: out, bytes: r.prg.length }, crunched: r.crunched ? stats(r.crunched) : brkStats(r.brk!), protocol: r.protocol,
          areas: r.areas, entry: r.entry, basic: r.basic, ramDuring: r.ramDuring, ramExit: r.ramExit, irqExit: r.irqExit,
          effect: r.effect, cycles: r.cycles, warnings: r.warnings };
      } else if (command === 'mem') {
        const load: MemOptions['load'] = a.l == null ? 'auto' : a.l === 'none' ? 'none' : number(String(a.l), 'The load address');
        const mo = { forward: !!a.f, load, crunch: o };
        if (format === 'brokkr' && a.f) throw new BrokkrError('BRK-E014', "Brokkr's own format is decrunched backward; -f is for Exomizer's format.");
        const r = format === 'brokkr'
          ? memBrkFile(data, start, crunchBrk(data.slice().reverse(), { effort: o.effort }), mo)
          : memFile(data, start, await crunch(a.f ? data : data.slice().reverse(), memCrunchOptions(mo)), mo);
        const c = 'brk' in r ? brkStats(r.brk) : stats(r.crunched);
        const out = outName(files[0], load === 'none' ? '.bin' : '.prg', a.o);
        writeFileSync(out, r.bytes);
        say(`  in place it loads at ${span(r.inPlace.start, r.inPlace.end)} (safety ${c.safety})`);
        for (const w of r.warnings) say(`  note: ${w}`);
        say(`${out}: ${r.bytes.length} bytes${r.at ? ` at ${span(r.at.start, r.at.end)}` : ''}`);
        result = { input: inInfo, output: { file: out, bytes: r.bytes.length, at: r.at }, inPlace: r.inPlace, crunched: c, warnings: r.warnings };
      } else {
        const ro = { backward: !!a.b, reversed: !!a.r };
        let bytes: Uint8Array, c: Record<string, unknown>;
        if (format === 'brokkr') { const r = rawBrk(data, { ...ro, crunch: { effort: o.effort } }); bytes = r.bytes; c = brkStats(r.brk); }
        else { const r = rawFile(await crunch(a.b ? data.slice().reverse() : data, o), ro); bytes = r.bytes; c = stats(r.crunched); }
        const out = outName(files[0], '.bin', a.o);
        writeFileSync(out, bytes);
        say(`${out}: ${bytes.length} bytes`);
        result = { input: inInfo, output: { file: out, bytes: bytes.length }, crunched: c };
      }
    } else if (command === 'd64') {
      const [diskName, ...names] = files;
      if (!diskName) throw new BrokkrError('BRK-E003', 'Name a disk image.');
      let image: Uint8Array;
      try { image = new Uint8Array(readFileSync(diskName)); } catch { throw new BrokkrError('BRK-E004', `"${diskName}" cannot be read.`); }
      const disk = new Disk(image);
      if (!names.length) {
        const list = disk.files();
        say(`0 "${disk.title.name.padEnd(16)}" ${disk.title.id}`);
        for (const f of list) say(`${String(f.blocks).padEnd(5)}"${f.name}"${' '.repeat(Math.max(0, 17 - f.name.length))}${f.closed ? ' ' : '*'}${f.type}${f.locked ? '<' : ''}`);
        say(`${disk.free} blocks free.`);
        result = { disk: diskName, title: disk.title, free: disk.free, files: list.map(({ entry: _e, ...f }) => f) };
      } else {
        const format = formatOf(a);
        const o = crunchOptions(a);
        const packed: Record<string, unknown>[] = [];
        for (const name of names) {
          const f = disk.find(name);
          if (!f) throw new BrokkrError('BRK-E320', `There is no file "${name}" on the disk.`, 'brokkr d64 <disk> lists the files.');
          if (f.type !== 'PRG') throw new BrokkrError('BRK-E321', `"${f.name}" is a ${f.type} file; Brokkr packs PRG files.`);
          const prg = disk.read(f);
          const load = prg[0] | (prg[1] << 8), data = prg.subarray(2);
          const mode = a.mode ?? (load === 0x0801 && findStart(data) ? 'sfx' : 'mem');
          let bytes: Uint8Array;
          if (mode === 'sfx') bytes = (await sfxAsync(data, load, { format, crunch: o }, crunch)).prg;
          else if (mode === 'mem' && format === 'brokkr') bytes = memBrkFile(data, load, crunchBrk(data.slice().reverse(), { effort: o.effort })).bytes;
          else if (mode === 'mem') bytes = memFile(data, load, await crunch(data.slice().reverse(), memCrunchOptions({ crunch: o })), { crunch: o }).bytes;
          else throw new BrokkrError('BRK-E009', `--mode is sfx or mem, not "${String(mode)}".`);
          const written = disk.write(f.name, bytes, { replace: true });
          say(`"${f.name}": ${f.blocks} blocks -> ${written.blocks} (${mode})`);
          packed.push({ name: f.name, mode, before: { bytes: prg.length, blocks: f.blocks }, after: { bytes: bytes.length, blocks: written.blocks } });
        }
        const out = outName(diskName, '.d64', a.o);
        writeFileSync(out, disk.bytes);
        say(`${out}: ${disk.free} blocks free.`);
        result = { disk: diskName, output: out, free: disk.free, packed };
      }
    } else if (command === 'decruncher') {
      const opt = (k: string) => (a[k] != null ? number(String(a[k]), `--${k}`) : undefined);
      const own = formatOf(a) === 'brokkr';
      const table = opt('table');
      if (own && table != null && table & 0xff) throw new BrokkrError('BRK-E015', `--table for Brokkr's own format is the start of a page ($c000), not ${h4(table)}.`);
      const src = own
        ? brkDecrunchSource({ zp: opt('zp'), table, at: opt('at'), small: !!a.small, effect: !!a.effect })
        : decrunchSource({ zp: opt('zp'), table, at: opt('at'), four: !!a.four, reuse: !a['no-reuse'], effect: !!a.effect, literalSequences: !a['no-literal-sequences'] });
      const out = typeof a.o === 'string' ? a.o : 'brokkr_decrunch.asm';
      writeFileSync(out, src);
      say(`${out}: Brokkr's decruncher ${own ? 'of its own format ' : ''}for Kick Assembler`);
      result = { output: { file: out } };
    } else {
      throw new BrokkrError('BRK-E010', `"${command}" is not a command.`, 'brokkr --help lists them.');
    }
    if (json) console.log(JSON.stringify({ ok: true, command, ms: Math.round(performance.now() - t0), ...result }, null, 2));
    return 0;
  } catch (e) {
    const err = e instanceof BrokkrError ? { code: e.code, message: e.message, hint: e.hint } : { code: 'BRK-E999', message: (e as Error).message };
    if (json) console.log(JSON.stringify({ ok: false, command, error: err }, null, 2));
    else console.error(`brokkr: ${err.code}: ${err.message}${'hint' in err && err.hint ? `\n  ${err.hint}` : ''}`);
    return 1;
  } finally {
    await close();
  }
}

/** whether a program at $0801 has a SYS to start it */
function findStart(data: Uint8Array): boolean {
  for (let i = 4; i < Math.min(data.length, 80); i++) { if (data[i] === 0) return false; if (data[i] === 0x9e) return true; }
  return false;
}

process.exitCode = await main(process.argv.slice(2));
