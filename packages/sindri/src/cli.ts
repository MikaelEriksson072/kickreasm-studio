/* sindri <file.prg | disk.d64> [options]: unpack a C64 program and report its layers. Run with `node src/cli.ts` (Node 22.18
 * or newer runs the TypeScript as it is), or `pnpm unpack` in this folder. */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpack, type LayerReport, type Saved, type UnpackOptions } from './session.ts';
import { findRoms, loadRoms } from './node.ts';
import { d64File, d64Pick } from './d64.ts';
import type { Range } from './analyze.ts';

const HELP = `sindri <file.prg | disk.d64> [options]

Runs the program in an emulated C64, follows it through its layers (coders, movers, decrunchers) and saves
the unpacked program when it starts. With a disk (a D64, or --disk) a 1541 is on the serial bus, so the
program can go on loading from it, with the KERNAL or a fast loader of its own.

  -o FILE        save here (default: <name>.<start address>.prg next to the file)
  --file NAME    the file on the D64 to unpack (default: its first PRG; * and ? as the DOS takes them)
  --disk FILE    put this D64 in the drive for a PRG given on its own
  -e ADDR        start with SYS ADDR instead of RUN
  -l ADDR        load the file at ADDR instead of its own load address
  --layer N      save layer N instead of the newest (see the report)
  --all          save every layer
  -i             report only, save nothing
  --clean        clear the bytes in the saved range that are not part of the program
  --deep         also press keys when a later layer waits (an intro after the decrunching)
  --no-keys      never press keys
  --cycles N     give up after N million cycles (default 400)
  --roms DIR     the folder with the C64 ROM files (default: a VICE installation, or $C64_ROMS); the 1541
                 DOS ROM is taken from there or from VICE's DRIVES folder next to it
  --no-roms      use the built-in stand-ins instead of ROM files
  --json         print the result as JSON
  --trace        print every layer change and key press as it happens
  --learn NAME   add the depackers' fingerprints to the signature list as NAME

Addresses: $080d, 0x080d or 2061.`;

const hex4 = (v: number) => '$' + v.toString(16).padStart(4, '0');
const range = (r: Range) => r.start === r.end ? hex4(r.start) : `${hex4(r.start)}-${hex4(r.end)}`;
const ranges = (rs: Range[], max = 3) => rs.length ? rs.slice(0, max).map(range).join(' ') + (rs.length > max ? ` +${rs.length - max}` : '') : '-';
const kb = (n: number) => n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} bytes`;

function parseAddr(s: string | undefined, what: string): number {
  if (s == null) throw new Error(`${what} needs an address`);
  const v = /^\$/.test(s) ? parseInt(s.slice(1), 16) : /^0x/i.test(s) ? parseInt(s.slice(2), 16) : Number(s);
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error(`${what}: "${s}" is not an address`);
  return v;
}

function describe(l: LayerReport): string {
  const head = `layer ${l.index}  ${hex4(l.entry)}  ${(l.via === 'start' ? 'start' : `${l.via} from ${hex4(l.from!)}`).padEnd(15)} ${l.basic ? 'BASIC RUN' : l.kind}`;
  const lines = [head];
  if (l.kind !== 'program' || l.index === 0) {
    lines.push(`         ran ${ranges(l.code)} (${l.instructions} instructions), read ${ranges(l.read)} (${kb(l.readBytes)}), wrote ${ranges(l.written)} (${kb(l.writtenBytes)})`);
    if (l.kind !== 'jump') lines.push(`         ${l.packer ? `packer: ${l.packer.name} (${Math.round(l.packer.similarity * 100)}% alike)` : `unknown depacker, fingerprint ${l.fingerprint}`}`);
  }
  if (l.calls.length) lines.push(`         called code it wrote: ${l.calls.map(c => `${hex4(c.entry)} (${c.via})`).join(', ')}`);
  if (l.text.length) lines.push(`         text: ${l.text.slice(0, 4).map(t => JSON.stringify(t)).join(', ')}`);
  const printed = l.printed.replace(/\s+/g, ' ').trim();
  if (printed) lines.push(`         printed: ${JSON.stringify(printed.slice(0, 80))}`);
  if (l.presses.length) lines.push(`         pressed: ${l.presses.join(', ')}`);
  return lines.join('\n');
}

function startHint(s: Saved): string {
  const port = s.port !== 0x37 ? `, $01=$${s.port.toString(16).padStart(2, '0')}` : '';
  return s.basic ? `RUN (SYS ${s.entry} = ${hex4(s.entry)}${port})` : `SYS ${s.entry} = ${hex4(s.entry)}${port}${s.interrupts ? '' : ', interrupts off'}`;
}

function main(argv: string[]): number {
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) { console.log(HELP); return argv.length ? 0 : 2; }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const o: UnpackOptions = {};
  let input: string | null = null, out: string | null = null, info = false, all = false, json = false, learn: string | null = null;
  let roms: string | null | false = null, fileName: string | null = null, diskPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-o': out = argv[++i]; break;
      case '--file': fileName = argv[++i]; break;
      case '--disk': diskPath = argv[++i]; break;
      case '-e': o.entry = parseAddr(argv[++i], '-e'); break;
      case '-l': o.load = parseAddr(argv[++i], '-l'); break;
      case '--layer': o.layer = Number(argv[++i]); break;
      case '--all': all = true; break;
      case '-i': info = true; break;
      case '--clean': o.clean = true; break;
      case '--deep': o.deep = true; break;
      case '--no-keys': o.keys = false; break;
      case '--cycles': o.maxCycles = Number(argv[++i]) * 1e6; break;
      case '--roms': roms = argv[++i]; break;
      case '--no-roms': roms = false; break;
      case '--json': json = true; break;
      case '--trace': o.trace = line => console.log(`  ${line}`); break;
      case '--learn': learn = argv[++i]; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
        if (input) throw new Error('one file at a time');
        input = a;
    }
  }
  if (!input) throw new Error('no file given');
  const path = resolve(cwd, input);
  let file = new Uint8Array(readFileSync(path));
  let base = join(dirname(path), basename(path, extname(path))), shown = basename(path);
  if (/\.d64$/i.test(path)) {
    const disk = file, entry = d64Pick(disk, fileName ?? undefined);
    if (!entry) throw new Error(fileName ? `no PRG named "${fileName}" on the disk` : 'no PRG on the disk');
    file = new Uint8Array(d64File(disk, entry));
    o.disk = disk;
    shown = `${basename(path)}: "${entry.name}"`;
    base += `.${entry.name.replace(/[^A-Za-z0-9 _-]/g, '_').trim() || 'file'}`;
  } else if (fileName) throw new Error('--file picks a file on a D64');
  if (diskPath) o.disk = new Uint8Array(readFileSync(resolve(cwd, diskPath)));
  o.roms = roms === false ? null : roms ? loadRoms(resolve(cwd, roms)) : findRoms();
  if (roms && !o.roms) throw new Error(`no kernal, basic and chargen ROM files in ${roms}`);

  const r = unpack(file, o);
  const written: string[] = [];
  const write = (s: Saved, name: string) => { writeFileSync(name, s.prg); written.push(name); };
  if (!info && r.saved) {
    if (all) for (let k = 1; k < r.layers.length; k++) { const s = r.save(k); if (s) write(s, `${base}.layer${k}.${s.entry.toString(16).padStart(4, '0')}.prg`); }
    else write(r.saved, out ? resolve(cwd, out) : `${base}.${r.saved.entry.toString(16).padStart(4, '0')}.prg`);
  }
  if (learn) learnSignatures(r.layers, learn);

  if (json) {
    const { save: _save, saved, ...rest } = r;
    console.log(JSON.stringify({ file: path, ...rest, saved: saved && { ...saved, prg: undefined, bytes: saved.prg.length }, written }, null, 2));
    return r.unpacked ? 0 : 1;
  }
  const loadAt = o.load ?? (file[0] | (file[1] << 8));
  console.log(`${shown}: ${range({ start: loadAt, end: loadAt + file.length - 3 })} (${kb(file.length - 2)})${r.basic.length ? `, ${r.basic.slice(0, 2).join(' / ')}` : ''}`);
  console.log(`ROMs: ${r.roms}`);
  if (r.drive) console.log(`Drive: ${r.drive}`);
  for (const l of r.layers) console.log(describe(l));
  const secs = (r.cycles / 985248).toFixed(1);
  console.log(`stopped after ${secs} s of C64 time (${Math.round(r.ms)} ms): ${r.stop.reason}${r.stop.detail ? `, ${r.stop.detail}` : ''}`);
  if (!r.unpacked) console.log('nothing was unpacked');
  else if (r.saved) {
    const s = r.saved;
    console.log(`${info ? 'would save' : 'saved'} layer ${s.layer}: ${range(s)} (${kb(s.prg.length - 2)}), start with ${startHint(s)}`);
    for (const w of written) console.log(`  -> ${w}`);
  }
  return r.unpacked ? 0 : 1;
}

/** Add the depacker layers' fingerprints to data/signatures.json (a layer that changes nothing is left out). */
function learnSignatures(layers: LayerReport[], name: string): void {
  const file = fileURLToPath(new URL('../data/signatures.json', import.meta.url));
  const db = JSON.parse(readFileSync(file, 'utf8')) as { packers: { name: string; kind?: string; opcodes: string }[] };
  const stages = layers.filter(l => l.kind !== 'program' && l.kind !== 'jump' && l.opcodes.length >= 16);
  stages.forEach((l, k) => {
    if (db.packers.some(p => p.opcodes === l.opcodes)) return;
    db.packers.push({ name: stages.length > 1 ? `${name} (${k === stages.length - 1 ? 'depacker' : `stage ${k + 1}`})` : name, kind: l.kind, opcodes: l.opcodes });
    console.log(`learned ${l.kind} at ${hex4(l.entry)} as ${name}`);
  });
  writeFileSync(file, JSON.stringify(db, null, 2) + '\n');
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`sindri: ${(e as Error).message}`);
  process.exitCode = 2;
}
