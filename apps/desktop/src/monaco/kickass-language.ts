/* Monarch definition for Kick Assembler (spec 14.3): comments, preprocessor, directives, macros,
 * label definitions, documented and undocumented mnemonics, hardware symbols, numbers, strings. */
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { OPC, SYM } from '@mimir/core';

export const KICKASS = 'kickass';

export function registerKickAssembler(monaco: typeof Monaco): void {
  const mnemonics = [...new Set(OPC.map(o => o.mn.toLowerCase()))];
  const illegals = [...new Set(OPC.filter(o => o.ill).map(o => o.mn.toLowerCase()))].filter(m => m !== 'nop' && m !== 'sbc');
  const hw = [...SYM.exact.values()].map(s => s.name).concat(SYM.regions.map(r => r.name));
  monaco.languages.register({ id: KICKASS, extensions: ['.asm'], aliases: ['Kick Assembler'] });
  monaco.languages.setLanguageConfiguration(KICKASS, { comments: { lineComment: '//', blockComment: ['/*', '*/'] }, brackets: [['(', ')'], ['{', '}'], ['[', ']']] });
  monaco.languages.setMonarchTokensProvider(KICKASS, {
    ignoreCase: false, mnemonics, illegals, hw,
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/#(import|importonce|if|else|endif|define)\b/, 'keyword.preproc'],
        [/[a-zA-Z_]\w*(?=:)/, 'label.def'],
        [/[a-zA-Z]{3}\.(abs|zp|a|z)\b/, 'keyword.mnemonic'],
        [/\.(byte|by|word|wo|text|fill|pc|label|const|var|encoding|import|align|cpu|macro|function|namespace|segment|segmentdef|file|eval|print|return|if|for|break|pseudopc|zp)\b/, 'keyword.directive'],
        [/\b(BasicUpstart2|BasicUpstart|LoadSid|LoadBinary|LoadPicture|toIntString)\b/, 'keyword.macro'],
        [/[a-zA-Z_]\w*(\.[a-zA-Z_]\w*(\([^)]*\))?)+/, 'variable.member'],
        [/[a-zA-Z_]\w*/, { cases: { '@illegals': 'keyword.illegal', '@mnemonics': 'keyword.mnemonic', '@hw': 'type.hardware', '@default': 'identifier' } }],
        [/\$[0-9a-fA-F]+/, 'number.hex'], [/%[01]+/, 'number.binary'], [/\d+/, 'number'],
        [/"[^"]*"/, 'string'],
        [/#[<>]?/, 'operator.immediate'], [/\*/, 'operator.pc'], [/[<>+\-/,()=]/, 'operator'],
      ],
      comment: [[/[^*/]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[*/]/, 'comment']],
    },
  } as Monaco.languages.IMonarchLanguage);
}
