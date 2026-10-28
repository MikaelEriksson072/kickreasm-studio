/* Hover (registers, labels, opcodes) and go-to-definition (Ctrl+click, F12) for Kick sources. */
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { findBlock, h4, kindInfo, OPC, SYM, type AnalysisResult, type RenderResult } from '@mimir/core';
import { KICKASS } from './kickass-language';

/** The analysis shown in the editor; SourceView keeps it current. */
export const monacoContext: { A: AnalysisResult | null; R: RenderResult | null } = { A: null, R: null };

export function registerProviders(monaco: typeof Monaco): void {
  monaco.languages.registerHoverProvider(KICKASS, {
    provideHover(model, pos) {
      const w = model.getWordAtPosition(pos); if (!w) return null;
      const name = w.word;
      const sym = [...SYM.exact.values()].find(s => s.name === name);
      const region = SYM.regions.find(r => r.name === name);
      if (sym) return { contents: [{ value: `**${name}** — $${h4(sym.addr)}` }, { value: `${sym.cat} · ${sym.desc}` }] };
      if (region) return { contents: [{ value: `**${name}** — $${h4(region.start)}` }, { value: `${region.cat} · ${region.desc}` }] };
      const { R, A } = monacoContext;
      if (R && A) for (const [a, l] of R.labels) if (l.name === name) {
        const xs = A.xrefs.get(a) || [];
        const b = findBlock(A.blocks, a);
        return { contents: [{ value: `**${name}** — $${h4(a)}` }, { value: `${b ? kindInfo(b.type).label : 'label'} · ${xs.length} reference${xs.length === 1 ? '' : 's'}${l.user ? ' · renamed by you' : ''}` }] };
      }
      const op = OPC.find(o => o.mn.toLowerCase() === name.toLowerCase());
      if (op) return { contents: [{ value: `**${op.mn}**${op.ill ? ' — undocumented opcode' : ''}` }] };
      return null;
    },
  });
  monaco.languages.registerDefinitionProvider(KICKASS, {
    provideDefinition(model, pos) {
      const w = model.getWordAtPosition(pos); if (!w) return null;
      const m = new RegExp(`^${w.word.replace(/[^\w]/g, '')}:`, 'm').exec(model.getValue()); if (!m) return null;
      const p = model.getPositionAt(m.index);
      return { uri: model.uri, range: new monaco.Range(p.lineNumber, 1, p.lineNumber, w.word.length + 1) };
    },
  });
}
