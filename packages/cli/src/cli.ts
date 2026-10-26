/* kickreasm analyse | export | verify | demo — batch and CI front end for @kickreasm/core. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  analyze, comparePrg, createProject, DEFAULT_SETTINGS, deserializeProject, detectPacking, exportFiles, h4, kindInfo, makeDemo,
  parsePrg, projectNameFor, render, verify, type Project, type SerializedProject, type Settings,
} from '@kickreasm/core';
import { findKickAssJar, runKickAssembler, splitArgs, writeVfs } from '@kickreasm/core/node';

export interface Io { out: (s: string) => void; err: (s: string) => void; cwd: string }

const USAGE = `KickReasm Studio command line

Usage:
  kickreasm analyse <file.prg | project.krproj.json>... [--json]
  kickreasm verify  <file.prg | project.krproj.json>... [--kickass [KickAss.jar]] [--java <java>]
  kickreasm export  <file.prg | project.krproj.json>... -o <folder> [--name <name>] [--force]
  kickreasm demo    [-o raster-demo.prg]

Options:
  --set key=value   override a setting (repeatable), e.g. --set hwInclude=inline --set bytesPerRow=16
  --kickass [jar]   also assemble with the real Kick Assembler (default: auto-detect / KICKASS_JAR)
  --java <path>     Java executable used for --kickass (default: java)
`;

interface Parsed { cmd: string; inputs: string[]; flags: Map<string, string | true>; sets: [string, string][] }

function parse(argv: string[]): Parsed {
  const [cmd = 'help', ...rest] = argv;
  const inputs: string[] = [], flags = new Map<string, string | true>(), sets: [string, string][] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--set') { const kv = rest[++i] || ''; const eq = kv.indexOf('='); if (eq > 0) sets.push([kv.slice(0, eq), kv.slice(eq + 1)]); continue; }
    if (a === '-o' || a === '--out') { flags.set('out', rest[++i] ?? ''); continue; }
    if (a.startsWith('--')) {
      const name = a.slice(2), nextArg = rest[i + 1];
      const takesValue = name === 'name' || name === 'java' || (name === 'kickass' && nextArg && !nextArg.startsWith('-') && /\.jar$/i.test(nextArg));
      flags.set(name, takesValue ? rest[++i] : true);
      continue;
    }
    inputs.push(a);
  }
  return { cmd, inputs, flags, sets };
}

function coerce(key: string, value: string): unknown {
  const def = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
  if (def === undefined) throw new Error(`unknown setting "${key}"`);
  if (typeof def === 'boolean') return value === 'true' || value === '1' || value === 'yes';
  if (typeof def === 'number') { const n = Number(value); if (!Number.isFinite(n)) throw new Error(`setting ${key} expects a number`); return n; }
  return value;
}

function loadProject(inputs: string[], io: Io, sets: [string, string][]): Project {
  if (!inputs.length) throw new Error('no input files');
  const settings: Partial<Settings> = {};
  for (const [k, v] of sets) (settings as Record<string, unknown>)[k] = coerce(k, v);
  const first = resolve(io.cwd, inputs[0]);
  if (/\.json$/i.test(first)) {
    const p = deserializeProject(JSON.parse(readFileSync(first, 'utf8')) as SerializedProject);
    return { ...p, settings: { ...p.settings, ...settings } };
  }
  const files = inputs.map(f => { const path = resolve(io.cwd, f); return parsePrg(basename(path), new Uint8Array(readFileSync(path))); });
  return createProject({ name: projectNameFor(files[0].name), files, settings });
}

function analyseCmd(p: Project, io: Io, json: boolean) {
  const A = analyze(p);
  const packing = A.files.map((_, i) => detectPacking(A, i));
  if (json) {
    io.out(JSON.stringify({
      entry: A.entry, stats: { ...A.stats, illegalList: undefined }, log: A.log,
      packing: packing.map(k => k && { verdict: k.verdict, signature: k.signature, entropy: +k.entropy.toFixed(2), packedShare: +k.packedShare.toFixed(2), codeBytes: k.codeBytes, decruncher: k.decruncher, reasons: k.reasons }),
      blocks: A.blocks.map(b => ({ start: b.start, end: b.end, type: b.type, conf: b.conf, reason: b.reason, user: b.user, props: b.props })),
      labels: Object.fromEntries([...A.labels].map(([a, l]) => [`$${h4(a)}`, l.name])),
      music: A.music.map(m => ({ start: m.start, end: m.end, init: m.init, play: m.play })),
    }, null, 2));
    return 0;
  }
  for (const l of A.log) io.out(`[${l.lvl.padEnd(4)}] ${l.msg}`);
  for (const [i, k] of packing.entries()) if (k) io.out(`[pack] ${A.files[i].name} ${k.verdict === 'packed' ? 'is packed' : 'may be packed'}${k.signature ? ` (${k.signature})` : ''}: ${k.reasons.join('; ')}. Unpack it (for example with unp64) and analyse the result.`);
  io.out('');
  io.out('Blocks:');
  for (const b of A.blocks) {
    const name = A.labels.get(b.start)?.name ?? '';
    io.out(`  $${h4(b.start)}-$${h4(b.end - 1)}  ${kindInfo(b.type).label.padEnd(13)} ${name.padEnd(16)} ${b.reason}`);
  }
  return 0;
}

async function kickCheck(p: Project, io: Io, jar: string, java: string): Promise<boolean> {
  const A = analyze(p);
  const R = render(A, p);
  const dir = await mkdtemp(join(tmpdir(), 'kickreasm-cli-'));
  let ok = true;
  try {
    await writeVfs(dir, R.files);
    for (const [fi, f] of A.files.entries()) {
      const entry = `${R.fileNames[fi]}.asm`;
      const run = await runKickAssembler({ java, jar, cwd: dir, entry, outDir: 'out', args: splitArgs(p.settings.kickArgs) });
      const cmp = comparePrg(f, run.prg);
      const good = run.ok && cmp.ok;
      ok = ok && good;
      io.out(`${good ? 'OK  ' : 'FAIL'} ${entry} with ${basename(jar)}: ${cmp.same}/${cmp.total} bytes identical (${run.ms} ms)`);
      for (const pr of run.problems) io.out(`  ${pr.file}:${pr.line}:${pr.column} ${pr.severity}: ${pr.message}`);
      for (const d of cmp.diffs.slice(0, 10)) io.out(`  ${d.msg ?? `$${h4(d.addr)}: expected $${(d.exp ?? 0).toString(16)}, got ${d.got == null ? 'nothing' : '$' + d.got.toString(16)}`}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return ok;
}

function builtinVerify(p: Project, io: Io) {
  const A = analyze(p);
  const R = render(A, p);
  const V = verify(A, R);
  for (const r of V.results) {
    io.out(`${r.ok ? 'OK  ' : 'FAIL'} ${r.path}: ${r.same}/${r.total} bytes identical to ${r.file} (built-in assembler)`);
    for (const e of r.errors.slice(0, 20)) io.out(`  ${e.file}:${e.line} ${e.msg}`);
    for (const d of r.diffs.slice(0, 10)) io.out(`  ${d.msg ?? `$${h4(d.addr)}: expected $${(d.exp ?? 0).toString(16)}, got ${d.got == null ? 'nothing' : '$' + d.got.toString(16)}`}`);
  }
  return { A, R, V };
}

export async function main(argv: string[], io: Io): Promise<number> {
  const { cmd, inputs, flags, sets } = parse(argv);
  try {
    switch (cmd) {
      case 'analyse': case 'analyze':
        return analyseCmd(loadProject(inputs, io, sets), io, flags.has('json'));
      case 'verify': {
        const p = loadProject(inputs, io, sets);
        const { V } = builtinVerify(p, io);
        let ok = V.ok;
        if (flags.has('kickass')) {
          const jar = typeof flags.get('kickass') === 'string' ? resolve(io.cwd, flags.get('kickass') as string) : findKickAssJar([p.settings.kickJar]);
          if (!jar) { io.err('KickAss.jar not found: pass --kickass <path> or set KICKASS_JAR'); return 2; }
          ok = (await kickCheck(p, io, jar, (flags.get('java') as string) || 'java')) && ok;
        }
        return ok ? 0 : 1;
      }
      case 'export': {
        const out = flags.get('out');
        if (typeof out !== 'string' || !out) { io.err('export needs -o <folder>'); return 2; }
        const dir = resolve(io.cwd, out);
        if (existsSync(dir) && readdirSync(dir).length && !flags.has('force')) { io.err(`${dir} is not empty (use --force to write into it)`); return 2; }
        let p = loadProject(inputs, io, sets);
        if (typeof flags.get('name') === 'string') p = { ...p, name: flags.get('name') as string };
        const { R, V } = builtinVerify(p, io);
        mkdirSync(dir, { recursive: true });
        const written = await writeVfs(dir, exportFiles(p, R, p.settings, V, new Date()));
        io.out(`Wrote ${written.length} files to ${dir}${V.ok ? ' (round-trip verified)' : ' (round-trip FAILED, see above)'}`);
        return V.ok ? 0 : 1;
      }
      case 'demo': {
        const d = makeDemo();
        const target = resolve(io.cwd, typeof flags.get('out') === 'string' ? flags.get('out') as string : d.name);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, d.prg);
        io.out(`Wrote ${target} (${d.prg.length} bytes)`);
        return 0;
      }
      case 'help': case '--help': case '-h':
        io.out(USAGE);
        return 0;
      default:
        io.err(`unknown command "${cmd}"\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    io.err(`kickreasm: ${(e as Error).message}`);
    return 2;
  }
}
