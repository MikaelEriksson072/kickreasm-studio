/* BASIC stub parsing: line links, tokens, SYS address, BasicUpstart2 match. */
import type { Addr, BasicInfo, BasicLine } from '../types';
import { h2, word } from '../util/hex';

export const BASIC_TOKENS = ('END FOR NEXT DATA INPUT# INPUT DIM READ LET GOTO RUN IF RESTORE GOSUB RETURN REM STOP ON WAIT LOAD SAVE VERIFY DEF POKE PRINT# PRINT CONT LIST CLR CMD SYS OPEN CLOSE GET NEW TAB( TO FN SPC( THEN NOT STEP + - * / ^ AND OR > = < SGN INT ABS USR FRE POS SQR RND LOG EXP COS SIN TAN ATN PEEK LEN STR$ VAL ASC CHR$ LEFT$ RIGHT$ MID$ GO').split(' ');

export function parseBasic(mem: Uint8Array, owner: Int16Array, start: Addr): BasicInfo | null {
  const lines: BasicLine[] = [];
  let a = start;
  for (let guard = 0; guard < 64; guard++) {
    if (owner[a] < 0 || owner[a + 1] < 0) return null;
    const link = word(mem, a);
    if (link === 0) {
      const end = a + 2;
      let sys: number | null = null, sysLine: BasicLine | null = null;
      for (const l of lines) {
        const i = l.toks.indexOf(0x9e);
        if (i < 0) continue;
        let j = i + 1, digits = '';
        while (l.toks[j] === 0x20 || l.toks[j] === 0x28) j++;
        while (l.toks[j] >= 0x30 && l.toks[j] <= 0x39) digits += String.fromCharCode(l.toks[j++]);
        if (digits) { sys = parseInt(digits, 10) & 0xffff; sysLine = l; break; }
      }
      const one = lines.length === 1 && lines[0];
      const upstart = !!(one && start === 0x0801 && one.num === 10 && sys != null &&
        one.toks.length === 1 + String(sys).length && one.toks[0] === 0x9e &&
        one.toks.slice(1).map(c => String.fromCharCode(c)).join('') === String(sys) && word(mem, start) === end - 2);
      return { start, end, lines, sys, sysLine, upstart };
    }
    if (link <= a + 4 || link > a + 260) return null;
    const num = word(mem, a + 2), toks: number[] = [];
    let p = a + 4;
    while (p < link - 1 && mem[p] !== 0) toks.push(mem[p++]);
    if (p !== link - 1 || mem[p] !== 0) return null;
    lines.push({ addr: a, num, toks, text: num + ' ' + toks.map(t => t >= 0x80 && t <= 0xcb ? BASIC_TOKENS[t - 0x80] : t >= 0x20 && t < 0x60 ? String.fromCharCode(t) : `{${h2(t)}}`).join('') });
    a = link;
  }
  return null;
}
