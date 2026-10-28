/* The Pack view's defaults and the command it shows (spec 13.8). The main process runs the same command on the
 * built PRGs, which Build & Run verified to be the loaded files byte for byte. */
import {
  DEFAULT_PACK, packArgs, packFileName, packImage, packInputs, packOutName, packParts, rangeCover, shellWord,
  type AnalysisResult, type FileInput, type PackPart, type PackPrefs, type Project,
} from '@mimir/core';

/** How a project is packed until the user changes something: the whole build, self-extracting, started where
 *  Build & Run starts it (the SYS of the BASIC line, else the program start). */
export function packDefaults(A: Pick<AnalysisResult, 'basics' | 'entry' | 'files'>, project: Pick<Project, 'entryPoint'>): PackPrefs {
  const sys = basicSys(A);
  const ep = project.entryPoint;
  if (sys != null && (ep == null || ep === sys)) return { ...DEFAULT_PACK, start: 'sys' };
  return { ...DEFAULT_PACK, start: 'jmp', jmp: ep ?? A.entry ?? A.files[0]?.load ?? null };
}

/** the SYS of the first file's BASIC line, if it has one */
export const basicSys = (A: Pick<AnalysisResult, 'basics'>): number | null => A.basics.find(b => b.sys != null && (b.file ?? 0) === 0)?.sys ?? null;

/** the built files as the pack folder names them: `<source name>.prg`, as Kick Assembler writes them */
export const packNames = (fileNames: readonly string[]): string[] => fileNames.map(n => packFileName(`${n}.prg`));

export interface PackCommand { args: string[]; text: string; out: string; parts: PackPart[]; size: number }

/** The command for `prefs` on these files (`exe`: the executable's name as shown). */
export function packCommand(prefs: PackPrefs, files: readonly Pick<FileInput, 'load' | 'bytes'>[], fileNames: readonly string[], exe = 'exomizer'): PackCommand {
  const names = packNames(fileNames);
  const parts = packParts(prefs.ranges, files.map((f, i) => ({ name: names[i] ?? `file${i + 1}.prg`, load: f.load, bytes: f.bytes })));
  const out = packOutName(prefs, names[0] ?? 'packed.prg');
  const args = packArgs(prefs, packInputs(parts), out);
  return { args, out, parts, size: packImage(parts)?.bytes.length ?? 0, text: [exe, ...args].map(shellWord).join(' ') };
}

/** A warning about settings Exomizer would refuse or that would not start the program, or null. */
export function packWarning(prefs: PackPrefs, A: Pick<AnalysisResult, 'basics'>): string | null {
  if (prefs.mode !== 'sfx' || prefs.start !== 'sys') return null;
  const b = A.basics.find(x => x.sys != null && (x.file ?? 0) === 0);
  if (!b) return 'There is no BASIC line with a SYS to start from: choose “Jump to address”.';
  if (prefs.ranges && rangeCover(prefs.ranges, b.start, b.end) < b.end - b.start) return 'The chosen blocks leave out the BASIC line, so there is no SYS to start from: add it, or choose “Jump to address”.';
  return null;
}

/** what a pack result belongs to: the pack settings and the generated files (a result with another key is stale) */
export const packKeyOf = (prefs: PackPrefs, filesKey: string): string => `${JSON.stringify(prefs)}|${filesKey}`;
