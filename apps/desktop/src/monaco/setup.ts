/* Lazily imported by SourceView: Monaco is bundled locally (no CDN, spec 4.2) with only the editor
 * core, the languages the source view needs, and its editor worker. */
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/edcore.main';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/bat/bat.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { registerKickAssembler } from './kickass-language';
import { registerProviders } from './providers';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

registerKickAssembler(monaco);
registerProviders(monaco);

export { monaco };
