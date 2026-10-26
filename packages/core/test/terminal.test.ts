/* The terminal button: what is started (on Windows PowerShell through `cmd /c start`, which gives it a console of
 * its own), and that the PowerShell it opens has VICE on PATH and a working `kickass` command. The real run drops
 * -NoExit and appends checks, so the shell exits on its own. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findKickAssJar, findVice, terminalCommand, windowsStartLine } from '../src/node';

describe('terminal command', () => {
  it('opens PowerShell on Windows with VICE on PATH and kickass defined', () => {
    const c = terminalCommand({ dir: 'C:\\work', platform: 'win32', java: 'C:\\jdk\\bin\\java.exe', kickJar: 'C:\\C64\\KickAss.jar', vicePath: 'C:\\VICE\\bin\\x64sc.exe', env: { Path: 'C:\\Windows', HOME: 'h' } });
    expect(c.file).toBe('powershell.exe');
    expect(c.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']);
    expect(c.args[3]).toBe("function global:kickass { & $env:KICKREASM_JAVA -jar $env:KICKASS_JAR @args }; Write-Host 'KickReasm Studio terminal: kickass <file.asm> runs Kick Assembler, x64sc <file.prg> starts VICE' -ForegroundColor DarkGray");
    expect(c.cwd).toBe('C:\\work');
    // the existing PATH key keeps its spelling (Windows has "Path")
    expect(c.env).toMatchObject({ Path: 'C:\\VICE\\bin;C:\\Windows', HOME: 'h', KICKASS_JAR: 'C:\\C64\\KickAss.jar', KICKREASM_JAVA: 'C:\\jdk\\bin\\java.exe' });
  });

  it('works without a toolchain', () => {
    const c = terminalCommand({ dir: 'C:\\work', platform: 'win32', env: { Path: 'C:\\Windows' } });
    expect(c.args[3]).toBe("Write-Host 'KickReasm Studio terminal' -ForegroundColor DarkGray");
    expect(c.env).toEqual({ Path: 'C:\\Windows' });
  });

  it('opens it on Windows through `start`, so PowerShell gets a console of its own', () => {
    const c = terminalCommand({ dir: 'C:\\my work', platform: 'win32', kickJar: 'C:\\C64\\KickAss.jar', env: { Path: 'C:\\Windows' } });
    expect(windowsStartLine(c)).toBe(`/d /c start "KickReasm Studio" /D "C:\\my work" powershell.exe -NoLogo -NoExit -Command "${c.args[3]}"`);
    expect(windowsStartLine({ ...c, cwd: 'C:\\w', args: ['-NoExit'] })).toBe('/d /c start "KickReasm Studio" /D C:\\w powershell.exe -NoExit');
    expect(() => windowsStartLine({ ...c, args: ['say "hi"'] })).toThrow(/cannot pass/);
  });

  it('opens Terminal.app on macOS and x-terminal-emulator elsewhere', () => {
    expect(terminalCommand({ dir: '/w', platform: 'darwin', env: {} })).toMatchObject({ file: 'open', args: ['-a', 'Terminal', '/w'] });
    expect(terminalCommand({ dir: '/w', platform: 'linux', vicePath: '/opt/vice/bin/x64sc', env: { PATH: '/usr/bin' } })).toMatchObject({ file: 'x-terminal-emulator', args: [], cwd: '/w', env: { PATH: '/opt/vice/bin:/usr/bin' } });
  });
});

const vice = process.env.VICE || findVice();
const jar = process.env.KICKASS_JAR || findKickAssJar();

describe.skipIf(process.platform !== 'win32')('the PowerShell it opens', () => {
  it('starts in the folder, finds x64sc and assembles with kickass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kickreasm-term-'));
    try {
      await writeFile(join(dir, 't.asm'), '.pc = $c000\n rts\n');
      const c = terminalCommand({ dir, java: 'java', kickJar: jar ?? undefined, vicePath: vice ?? undefined });
      const checks = ["'cwd=' + (Get-Location).Path", ...(vice ? ["'vice=' + (Get-Command x64sc).Source"] : []), ...(jar ? ['kickass t.asm -odir out | Out-Null', "'prg=' + (Test-Path out\\t.prg)"] : [])];
      const r = spawnSync(c.file, [...c.args.filter(a => a !== '-NoExit').slice(0, -1), `${c.args[c.args.length - 1]}; ${checks.join('; ')}`], { cwd: c.cwd, env: c.env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('KickReasm Studio terminal');
      expect(r.stdout).toContain(`cwd=${dir}`);
      if (vice) expect(r.stdout.toLowerCase()).toContain(`vice=${vice.toLowerCase()}`);
      if (jar) { expect(r.stdout).toContain('prg=True'); expect(existsSync(join(dir, 'out', 't.prg'))).toBe(true); }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
