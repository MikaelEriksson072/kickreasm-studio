/* Project creation and the on-disk `.mimir.json` format (file bytes as base64). */
import { LEGACY_PROJECT_FORMAT, type FileInput, type LoadedFile, type Project, type SerializedProject, type Settings } from './types';
import { DEFAULT_SETTINGS } from './model';
import { makeDemo } from './demo';
import { parsePrg } from './c64/prg';

export const newId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 9);

export const b64enc = (u8: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
  return btoa(s);
};
export const b64dec = (s: string): Uint8Array => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };

/** File name -> project name usable as a Kick source file name. */
export const projectNameFor = (fileName: string): string => fileName.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_') || 'project';

export const withId = (f: FileInput): LoadedFile => ({ id: f.id || newId(), name: f.name, load: f.load, bytes: f.bytes, ...(f.vsf ? { vsf: f.vsf } : {}) });

export function createProject(init: { name?: string; files: FileInput[]; settings?: Partial<Settings> }): Project {
  return {
    format: 'mimir-project', version: 1,
    name: init.name || (init.files[0] ? projectNameFor(init.files[0].name) : 'project'),
    files: init.files.map(withId),
    overrides: [], entries: [], entryPoint: null, labels: {}, comments: {}, blockComments: {}, notes: {}, bankZones: [], excluded: [], binary: [], bookmarks: {}, scripts: {},
    settings: Object.assign({}, DEFAULT_SETTINGS, init.settings || {}),
  };
}

export function demoProject(settings?: Partial<Settings>): Project {
  const d = makeDemo();
  return createProject({ name: 'raster-demo', files: [parsePrg(d.name, d.prg)], settings });
}

export function serializeProject(p: Project): SerializedProject {
  return {
    format: 'mimir-project', version: 1, name: p.name,
    files: p.files.map(f => ({ name: f.name, load: f.load, data: b64enc(f.bytes), ...(f.vsf ? { vsf: b64enc(f.vsf) } : {}) })),
    overrides: p.overrides, entries: p.entries, entryPoint: p.entryPoint, labels: p.labels, comments: p.comments, blockComments: p.blockComments, notes: p.notes, bankZones: p.bankZones, excluded: p.excluded, binary: p.binary, bookmarks: p.bookmarks, scripts: p.scripts, ...(p.pack ? { pack: p.pack } : {}), settings: p.settings,
  };
}

/** Accepts an already shape-checked object (the Electron main process validates with zod first). */
export function deserializeProject(o: SerializedProject): Project {
  if (!o || (o.format !== 'mimir-project' && o.format !== LEGACY_PROJECT_FORMAT) || !Array.isArray(o.files)) throw new Error('This file is not a Mimir project (.mimir.json).');
  return {
    format: 'mimir-project', version: 1,
    name: o.name || 'project', files: o.files.map(f => ({ id: newId(), name: f.name, load: f.load, bytes: b64dec(f.data), ...(f.vsf ? { vsf: b64dec(f.vsf) } : {}) })),
    overrides: o.overrides || [], entries: o.entries || [], entryPoint: o.entryPoint ?? null, labels: o.labels || {}, comments: o.comments || {}, blockComments: o.blockComments || {}, notes: o.notes || {}, bankZones: o.bankZones || [], excluded: o.excluded || [], binary: o.binary || [], bookmarks: o.bookmarks || {}, scripts: o.scripts || {}, pack: o.pack ?? null,
    settings: Object.assign({}, DEFAULT_SETTINGS, o.settings || {}),
  };
}
