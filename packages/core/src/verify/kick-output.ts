/* Parses Kick Assembler 5.x console output into problems.
 *
 * KickAss prints errors in two forms (both checked against KickAss 5.25):
 *   Got 2 errors and 0 warnings while executing:
 *     (C:\work\demo\include\inc.asm 2:14) Error: Unknown symbol 'undefinedthing'
 * and, for the first error, a source excerpt followed by
 *   Error: Unknown symbol 'undefinedthing'
 *   at line 2, column 14 in include\inc.asm
 */
import type { KickProblem } from '../types';

const slash = (p: string) => p.replace(/\\/g, '/');

/** Make `file` relative to `baseDir` (when inside it) with forward slashes. */
function relativeTo(file: string, baseDir?: string): string {
  const f = slash(file.trim());
  if (!baseDir) return f;
  const base = slash(baseDir).replace(/\/+$/, '') + '/';
  return f.toLowerCase().startsWith(base.toLowerCase()) ? f.slice(base.length) : f;
}

export function parseKickOutput(output: string, baseDir?: string): KickProblem[] {
  const problems: KickProblem[] = [];
  const seen = new Set<string>();
  const add = (p: KickProblem) => {
    const key = `${p.severity}|${p.file.toLowerCase()}|${p.line}|${p.column}|${p.message}`;
    if (seen.has(key)) return;
    seen.add(key); problems.push(p);
  };
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const summary = lines[i].match(/^\s*\((.+) (\d+):(\d+)\)\s+(Error|Warning):\s*(.*)$/i);
    if (summary) {
      add({ severity: summary[4].toLowerCase() === 'warning' ? 'warning' : 'error', file: relativeTo(summary[1], baseDir), line: +summary[2], column: +summary[3], message: summary[5].trim() });
      continue;
    }
    const head = lines[i].match(/^(Error|Warning):\s*(.*)$/i);
    if (head) {
      const at = (lines[i + 1] || '').match(/^at line (\d+), column (\d+) in (.+)$/i);
      const severity = head[1].toLowerCase() === 'warning' ? 'warning' : 'error';
      if (at) { add({ severity, file: relativeTo(at[3], baseDir), line: +at[1], column: +at[2], message: head[2].trim() }); i++; }
      else add({ severity, file: '', line: 0, column: 0, message: head[2].trim() });
    }
  }
  return problems;
}
