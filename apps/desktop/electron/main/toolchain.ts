/* Toolchain runner (spec 13.2): Kick Assembler and VICE are started with argument arrays, never
 * through a shell, using the executables from the main-process settings store. */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { KickProblem, ToolchainSettings } from '@mimir/core';
import { canIdentify, identifyPacker, launchTerminal, launchVice, runExomizer, runKickAssembler, runUnpacker, splitArgs } from '@mimir/core/node';
import { rm } from 'node:fs/promises';
import type { BuildRequest, BuildResult, IdentifyResponse, PackRequest, PackResponse, RunRequest, RunResult, TerminalOpenResult, UnpackRequest, UnpackResponse } from '../../shared/ipc';
import { createBuildFolder } from './project-fs';
import { assertEntryName, type PathPolicy } from './paths';

const missing = (what: string, path: string): KickProblem => ({ severity: 'error', file: '', line: 0, column: 0, message: `${what} not found at "${path}". Set the path in Settings → Toolchain.` });

export async function buildWithKickAssembler(req: BuildRequest, settings: ToolchainSettings, policy: PathPolicy): Promise<BuildResult> {
  const t0 = Date.now();
  const dir = policy.assert(req.dir, 'Build folder');
  const entries = req.entries.map(assertEntryName);
  if (!settings.kickJar || !existsSync(settings.kickJar)) {
    return { ok: false, stdout: '', problems: [missing('KickAss.jar', settings.kickJar)], outputs: [], commands: [], ms: Date.now() - t0 };
  }
  const outputs: BuildResult['outputs'] = [];
  const commands: string[][] = [];
  let stdout = '';
  for (const entry of entries) {
    if (!existsSync(join(dir, entry))) throw new Error(`${entry} does not exist in the build folder`);
    const run = await runKickAssembler({ java: settings.javaPath || 'java', jar: settings.kickJar, cwd: dir, entry, outDir: settings.outDir || 'out', args: splitArgs(settings.kickArgs) });
    commands.push(run.argv);
    stdout += `> ${run.argv.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n${run.output}\n`;
    outputs.push({ entry, ok: run.ok, prg: run.prg, prgPath: run.prgPath, vsPath: run.vsPath, problems: run.problems });
  }
  const problems = outputs.flatMap(o => o.problems);
  return { ok: outputs.every(o => o.ok), stdout, problems, prg: outputs[0]?.prg ?? undefined, outputs, commands, ms: Date.now() - t0 };
}

/** Unpack a packed PRG with the configured external unpacker (unp64), in a build folder of its own. */
export async function unpackWithTool(req: UnpackRequest, settings: ToolchainSettings): Promise<UnpackResponse> {
  if (!settings.unpackerPath) throw new Error('No unpacker is set. Set unp64 in Settings → Toolchain → Unpacker.');
  if (!existsSync(settings.unpackerPath)) throw new Error(`Unpacker not found at "${settings.unpackerPath}". Set the path in Settings → Toolchain.`);
  const dir = await createBuildFolder('unpack');
  const r = await runUnpacker({ exe: settings.unpackerPath, args: settings.unpackerArgs, dir, name: req.name, prg: req.prg });
  return { ok: r.ok, output: r.output, argv: r.argv, dir, name: r.file?.name, prg: r.file?.prg, entry: r.entry, packer: r.packer, error: r.error, ms: r.ms };
}

/** Ask unp64 (`-i`, nothing is unpacked) which packer a PRG uses; its scratch folder is removed afterwards. */
export async function identifyWithTool(req: UnpackRequest, settings: ToolchainSettings): Promise<IdentifyResponse> {
  const tool = settings.unpackerPath;
  if (!tool || !canIdentify(tool) || !existsSync(tool)) return { supported: false, known: false, packer: null, tool };
  const dir = await createBuildFolder('identify');
  try {
    const r = await identifyPacker({ exe: tool, dir, name: req.name, prg: req.prg });
    return { supported: true, known: r.known, packer: r.packer, tool };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Pack the built PRGs (or ranges of them) with Exomizer in a pack folder of its own, which the session may then
 * run in VICE: the result is checked with desfx when it is self-extracting. */
export async function packWithExomizer(req: PackRequest, settings: ToolchainSettings, policy: PathPolicy): Promise<PackResponse> {
  const exe = settings.exomizerPath;
  if (!exe) throw new Error('No Exomizer is set. Set it in Settings → Toolchain → Exomizer.');
  if (!existsSync(exe)) throw new Error(`Exomizer not found at "${exe}". Set the path in Settings → Toolchain.`);
  const dir = policy.allow(await createBuildFolder('pack'));
  const r = await runExomizer({ exe, dir, files: req.files, prefs: req.prefs });
  return {
    ok: r.ok, output: r.output, argv: r.argv, ms: r.ms, dir, packed: r.packed, report: r.report, check: r.check, error: r.error,
    ...(r.out ? { name: r.out.name, path: join(dir, r.out.name), prg: r.out.prg } : {}),
  };
}

/** A terminal window in `dir` (already checked against the path policy), with VICE on PATH and `kickass` defined. */
export async function openTerminal(dir: string, settings: ToolchainSettings): Promise<TerminalOpenResult> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
  const has = (p: string) => !!p && existsSync(p);
  await launchTerminal({ dir, java: settings.javaPath || 'java', kickJar: has(settings.kickJar) ? settings.kickJar : undefined, vicePath: has(settings.vicePath) ? settings.vicePath : undefined });
  return { dir };
}

export async function runInVice(req: RunRequest, settings: ToolchainSettings, policy: PathPolicy): Promise<RunResult> {
  const prgPath = policy.assert(req.prgPath, 'Program');
  const labelsPath = req.labelsPath ? policy.assert(req.labelsPath, 'Label file') : null;
  if (!settings.vicePath || !existsSync(settings.vicePath)) throw new Error(`VICE (x64sc) not found at "${settings.vicePath}". Set the path in Settings → Toolchain.`);
  const disk = req.disk ? policy.assert(req.disk, 'Disk image') : null;
  return launchVice({ vice: settings.vicePath, args: splitArgs(settings.viceArgs), prgPath, labelsPath: labelsPath && existsSync(labelsPath) ? labelsPath : null, start: req.start, disk });
}
