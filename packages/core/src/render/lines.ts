/* Line model -> Kick Assembler text. The listing renders the same tokens interactively. */
import type { ListingLine, Settings, Token } from '../types';
import { h4 } from '../util/hex';

export type LineTextSettings = Pick<Settings, 'indent' | 'commentCol' | 'addrComments'>;

/** Directives written at column 0 (everything else is indented). */
export const TOP_LEVEL_DIRECTIVES = ['#import', '#define', '#if', '#else', '#endif', '.label', '.var', '.pc', 'BasicUpstart2'];

/**
 * Mnemonics are always written in lower case: Kick Assembler 5.25 rejects upper-case ones
 * ("Pseudo command 'SEI' not defined"). `Settings.mnemonicCase` is still read from old
 * project files but no longer changes the output.
 */
export const kickMnemonic = (m: string): string => m.toLowerCase();

export function lineText(l: ListingLine, S: LineTextSettings): string {
  const ind = ' '.repeat(S.indent);
  const tokS = (tk: Token[]) => tk.map(t => t.s).join('');
  const withCmt = (s: string, c: string | undefined) => { if (!c) return s; const pad = Math.max(1, S.commentCol - s.length); return s + ' '.repeat(pad) + '// ' + c; };
  const mnc = kickMnemonic;
  const adr = l.a != null && S.addrComments && (l.k === 'ins' || l.k === 'dat') ? `${'$' + h4(l.a)}` : '';
  const cc = (c: string) => [adr, c].filter(Boolean).join('  ');
  switch (l.k) {
    case 'lbl': return `${l.name}:`;
    case 'ins': return withCmt(ind + mnc(l.mn) + (l.ext || '') + (l.tok.length ? ' ' + tokS(l.tok) : ''), cc(l.cmt));
    case 'dat': return withCmt(ind + l.dir + ' ' + tokS(l.tok), cc(l.cmt));
    case 'dir': return withCmt((l.tok[0] && TOP_LEVEL_DIRECTIVES.includes(l.tok[0].s) ? '' : ind) + tokS(l.tok), l.cmt);
    case 'cmt': return l.raw ? l.text : l.text ? `// ${l.text}` : '//';
    case 'hdr': return `// ${('---- ' + l.text + ' ').padEnd(66, '-')}`;
    case 'file': return `// ===== ${l.text} =====`;
    default: return '';
  }
}
