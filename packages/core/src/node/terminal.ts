/* Node-only: opens a terminal window in a folder, with the toolchain at hand: VICE's folder on PATH and, on
 * Windows, a `kickass` command that runs KickAss.jar with the configured Java. */
import { spawn } from 'node:child_process';
import { posix, win32 } from 'node:path';

export interface TerminalLaunch {
  dir: string;
  java?: string; kickJar?: string; vicePath?: string;
  platform?: NodeJS.Platform;
  /** the environment to extend (default: this process's) */
  env?: Record<string, string | undefined>;
}

export interface TerminalCommand { file: string; args: string[]; cwd: string; env: Record<string, string | undefined> }

/**
 * What to start. Windows: PowerShell in a console of its own (Windows 11 shows it in the default terminal app),
 * with `kickass` defined and a line saying so. macOS: Terminal.app in the folder. Elsewhere: x-terminal-emulator.
 */
export function terminalCommand(o: TerminalLaunch): TerminalCommand {
  const platform = o.platform ?? process.platform;
  const base = o.env ?? process.env;
  const env: Record<string, string | undefined> = { ...base };
  const pathKey = Object.keys(base).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  if (o.vicePath) env[pathKey] = [(platform === 'win32' ? win32 : posix).dirname(o.vicePath), base[pathKey]].filter(Boolean).join(platform === 'win32' ? ';' : ':');
  if (o.kickJar) { env.KICKASS_JAR = o.kickJar; env.KICKREASM_JAVA = o.java || 'java'; }
  if (platform === 'win32') {
    const hint = [o.kickJar && 'kickass <file.asm> runs Kick Assembler', o.vicePath && 'x64sc <file.prg> starts VICE'].filter(Boolean).join(', ');
    const script = [
      o.kickJar ? 'function global:kickass { & $env:KICKREASM_JAVA -jar $env:KICKASS_JAR @args }' : '',
      `Write-Host 'KickReasm Studio terminal${hint ? `: ${hint}` : ''}' -ForegroundColor DarkGray`,
    ].filter(Boolean).join('; ');
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', script], cwd: o.dir, env };
  }
  if (platform === 'darwin') return { file: 'open', args: ['-a', 'Terminal', o.dir], cwd: o.dir, env };
  return { file: 'x-terminal-emulator', args: [], cwd: o.dir, env };
}

/**
 * The cmd.exe command line that opens `c` in a console window of its own: `start "title" /D "dir" file args`.
 * A console program started directly from the app would get the app's (empty) standard handles, and PowerShell
 * reads end of input there and exits; `start` gives it a new console instead. Arguments are quoted, and none may
 * hold a `"` (Windows paths cannot).
 */
export function windowsStartLine(c: TerminalCommand, title = 'KickReasm Studio'): string {
  const q = (s: string) => { if (s.includes('"')) throw new Error(`cannot pass ${s} to a terminal`); return /[\s&|<>^()%!,;=]/.test(s) || !s ? `"${s}"` : s; };
  return `/d /c start "${title}" /D ${q(c.cwd)} ${[c.file, ...c.args].map(q).join(' ')}`;
}

/** Start the terminal detached (it outlives the app). Resolves once it has started. */
export function launchTerminal(o: TerminalLaunch): Promise<number> {
  const c = terminalCommand(o);
  const win = (o.platform ?? process.platform) === 'win32';
  const [file, args] = win ? ['cmd.exe', [windowsStartLine(c)]] : [c.file, c.args];
  return new Promise((ok, fail) => {
    // on Windows cmd.exe only runs `start` and exits, so its own window stays hidden
    const child = spawn(file, args, { cwd: c.cwd, env: c.env, shell: false, detached: true, stdio: 'ignore', windowsHide: win, windowsVerbatimArguments: win });
    child.once('error', e => fail(new Error(`could not start a terminal (${c.file}): ${e.message}`)));
    child.once('spawn', () => { child.unref(); ok(child.pid ?? -1); });
  });
}
