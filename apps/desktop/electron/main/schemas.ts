/* zod schemas for everything that crosses the IPC boundary or is read from disk (spec 4.2). */
import { z } from 'zod';
import { extraProblem, LEGACY_PROJECT_FORMAT, type BlockKind } from '@mimir/core';

const addr = z.number().int().min(0).max(0x10000);
const record = z.record(z.string().regex(/^\d+$/), z.string());
/** comment lines (`//`) and blocks the user inserted above an address */
const notes = z.record(z.string().regex(/^\d+$/), z.object({ text: z.string().max(20000), block: z.boolean().optional() }));
/** the user's bookmarks: a title and a note per address (not written to the source) */
const bookmarks = z.record(z.string().regex(/^\d+$/), z.object({ title: z.string().max(200), text: z.string().max(20000) }));
/** build.bat / build.sh as the user edited them */
const scripts = z.object({ 'build.bat': z.string().max(65536), 'build.sh': z.string().max(65536) }).partial().strict();
/** how the Pack view packs the project, with Brokkr or Exomizer (spec 13.8) */
const packRange = z.object({ start: addr, end: addr }).refine(r => r.end > r.start, 'empty range');
export const packPrefsSchema = z.object({
  // project files from before Brokkr have neither: they pack with Brokkr now
  packer: z.enum(['brokkr', 'exomizer']).default('brokkr'),
  effort: z.enum(['fast', 'normal', 'max']).default('normal'),
  format: z.enum(['exomizer', 'brokkr', 'fast']).default('exomizer'),
  mode: z.enum(['sfx', 'mem']),
  ranges: z.array(packRange).max(4096).nullable(),
  start: z.enum(['sys', 'basic', 'jmp']),
  jmp: z.number().int().min(0).max(0xffff).nullable(),
  effect: z.enum(['default', 'none', 'x1', 'x2', 'x3']),
  ramExit: z.number().int().min(0).max(255).nullable(),
  irqExit: z.boolean().nullable(),
  memLoad: z.union([z.enum(['auto', 'none']), z.number().int().min(0).max(0xffff)]),
  forward: z.boolean(),
  compat: z.boolean(),
  fast: z.boolean(),
  extra: z.string().max(1024).refine(e => extraProblem(e) == null, e => ({ message: extraProblem(e) ?? '' })),
  out: z.string().max(128),
}).strict();
const blockKinds = ['code', 'data', 'words', 'text', 'table', 'lohi', 'sprite', 'charset', 'bitmap', 'screen', 'music', 'fill', 'basic'] as const satisfies readonly BlockKind[];

export const overrideSchema = z.object({
  start: addr,
  end: addr,
  // older project files wrote 'bytes'; unknown kinds are data, exactly as analyze() treats them
  type: z.string().max(16).transform((t): BlockKind | 'auto' => (t === 'auto' || (blockKinds as readonly string[]).includes(t) ? t as BlockKind | 'auto' : 'data')),
  props: z.object({
    enc: z.enum(['petscii', 'screen', 'petscii-mixed', 'screen-mixed']).optional(),
    row: z.number().int().min(1).max(256).optional(),
    fmt: z.enum(['hex', 'bin', 'dec']).optional(),
    init: addr.optional(),
    play: addr.optional(),
    sub: z.string().max(16).optional(),
  }).partial().optional(),
});

export const toolchainSettingsSchema = z.object({
  javaPath: z.string().max(1024),
  kickJar: z.string().max(1024),
  vicePath: z.string().max(1024),
  outDir: z.string().max(128).regex(/^[A-Za-z0-9_.-]+$/, 'output folder must be a plain folder name'),
  kickArgs: z.string().max(1024),
  viceArgs: z.string().max(1024),
  unpackerPath: z.string().max(1024),
  unpackerArgs: z.string().max(1024),
  exomizerPath: z.string().max(1024),
  viceQuicksave: z.string().max(1024),
});

export const settingsSchema = toolchainSettingsSchema.partial().extend({
  illegal: z.boolean(), detectMusic: z.boolean(), detectGfx: z.boolean(), detectText: z.boolean(), bankTracking: z.boolean(), snapshotZeroPage: z.boolean(), codeIslands: z.boolean(), deepAnalysis: z.boolean(),
  mnemonicCase: z.enum(['lower', 'upper']), hexCase: z.enum(['lower', 'upper']),
  bytesPerRow: z.number().int().min(1).max(64), indent: z.number().int().min(0).max(16), commentCol: z.number().int().min(0).max(160),
  basicUpstart: z.boolean(), hwInclude: z.enum(['import', 'inline', 'none']), hwComments: z.boolean(),
  musicAsSid: z.boolean(), gfxBinary: z.boolean(), addrComments: z.boolean(), notesFormat: z.enum(['html', 'txt', 'none']),
}).partial();

const fileName = z.string().min(1).max(255);
/** code the user wrote over the loaded bytes (spec 10.2): what it wrote and what was there, as many bytes */
const patchFields = { name: z.string().min(1).max(64), start: addr, end: addr, source: z.string().max(65536), fill: z.enum(['nop', 'keep']), over: z.boolean(), off: z.boolean().optional(), cycles: z.boolean().optional() };
const base64 = z.string().max(0x20000).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const serializedPatch = z.object({ ...patchFields, bytes: base64, old: base64 })
  .refine(p => p.bytes.length === p.old.length && p.bytes.length > 0, 'the bytes written and the bytes written over differ in length');
const patch = z.object({ ...patchFields, id: z.string().max(64), bytes: z.instanceof(Uint8Array), old: z.instanceof(Uint8Array) })
  .refine(p => p.bytes.length === p.old.length && p.bytes.length > 0 && p.start + p.bytes.length <= 0x10000, 'the bytes written and the bytes written over differ in length');
/** memory configuration / VIC bank the code in a range runs with (null: back to detection) */
const bankZone = z.object({ start: addr, end: addr, port: z.number().int().min(0).max(255).nullable().optional(), vicBank: z.number().int().min(0).max(3).nullable().optional() });

/** .mimir.json on disk (and a .krproj.json saved before the rename) */
export const serializedProjectSchema = z.object({
  format: z.enum(['mimir-project', LEGACY_PROJECT_FORMAT]),
  version: z.literal(1),
  name: z.string().max(255).default('project'),
  // project files from before snapshots were kept have no vsf
  files: z.array(z.object({ name: fileName, load: addr, data: z.string(), vsf: z.string().optional() })).min(1).max(64),
  overrides: z.array(overrideSchema).max(100000).default([]),
  entries: z.array(addr).max(65536).default([]),
  // project files from before the program start could be set have none
  entryPoint: z.number().int().min(0).max(0xffff).nullable().default(null),
  labels: record.default({}),
  comments: record.default({}),
  blockComments: record.default({}),
  // project files from before comment lines and blocks existed have none
  notes: notes.default({}),
  // project files from before bookmarks have none
  bookmarks: bookmarks.default({}),
  // project files from before the build scripts could be edited have none
  scripts: scripts.default({}),
  // project files from before packing with Exomizer have none
  pack: packPrefsSchema.nullable().default(null),
  // project files from before patches have none
  patches: z.array(serializedPatch).max(4096).default([]),
  bankZones: z.array(bankZone).max(100000).default([]),
  // project files from before blocks could be excluded have none
  excluded: z.array(addr).max(65536).default([]),
  // project files from before blocks could be saved as binary files have none
  binary: z.array(addr).max(65536).default([]),
  settings: settingsSchema.default({}),
});

/** Project as sent by the renderer (bytes as Uint8Array). */
export const projectSchema = z.object({
  format: z.literal('mimir-project'),
  version: z.literal(1),
  name: z.string().max(255),
  files: z.array(z.object({ id: z.string().max(64), name: fileName, load: addr, bytes: z.instanceof(Uint8Array), vsf: z.instanceof(Uint8Array).optional() })).min(1).max(64),
  overrides: z.array(overrideSchema).max(100000),
  entries: z.array(addr).max(65536),
  entryPoint: z.number().int().min(0).max(0xffff).nullable(),
  labels: record,
  comments: record,
  blockComments: record,
  notes,
  bookmarks,
  scripts,
  pack: packPrefsSchema.nullable().optional(),
  patches: z.array(patch).max(4096),
  bankZones: z.array(bankZone).max(100000),
  excluded: z.array(addr).max(65536),
  binary: z.array(addr).max(65536),
  settings: settingsSchema,
});

export const projectOpenSchema = z.object({ path: z.string().max(4096).optional() }).default({});
export const projectSaveSchema = z.object({ project: projectSchema, path: z.string().max(4096).optional() });
/** `zeroPage`: VICE snapshots open from $0002 (zero page and stack included) */
export const prgOpenSchema = z.object({ paths: z.array(z.string().max(4096)).max(64).optional(), zeroPage: z.boolean().optional() }).default({});
export const diskOpenSchema = z.object({ path: z.string().max(4096).optional() }).default({});
export const terminalOpenSchema = z.object({ dir: z.string().min(1).max(4096).optional() }).default({});
/** a packed PRG (load address first) for the external unpacker */
export const unpackSchema = z.object({ name: fileName, prg: z.instanceof(Uint8Array).refine(b => b.length >= 3 && b.length <= 0x10002, 'not a PRG') });
export const exportWriteSchema = z.object({
  dir: z.string().max(4096).optional(),
  target: z.enum(['pick', 'temp']).optional(),
  name: z.string().max(64).regex(/^[A-Za-z0-9_-]*$/).optional(),
  files: z.record(z.string().min(1).max(512), z.union([z.string(), z.instanceof(Uint8Array)])),
}).refine(r => !!r.dir !== !!r.target, 'give either dir or target');
export const buildSchema = z.object({ dir: z.string().min(1).max(4096), entries: z.array(z.string().max(255)).min(1).max(64) });
export const runSchema = z.object({ prgPath: z.string().min(1).max(4096), labelsPath: z.string().max(4096).optional(), start: z.number().int().min(0).max(0xffff).optional(), disk: z.string().min(1).max(4096).optional() });
const prg = z.instanceof(Uint8Array).refine(b => b.length >= 3 && b.length <= 0x10002, 'not a PRG');
/** the built PRGs (one per project file, in order) and how to pack them */
export const packSchema = z.object({ files: z.array(z.object({ name: fileName, prg })).min(1).max(64), prefs: packPrefsSchema });
/** a file to save with a dialog (the packed PRG, graphics, .byte source): its suggested name and bytes */
export const fileSaveSchema = z.object({ name: fileName, bytes: z.instanceof(Uint8Array).refine(b => b.length > 0 && b.length <= 4 * 1024 * 1024, 'empty or larger than 4 MB'), title: z.string().max(200).optional() });
/** VICE's quicksave snapshot: `zeroPage` opens it from $0002 */
export const quicksaveSchema = z.object({ zeroPage: z.boolean().optional() }).strict().default({});
/** one of the kept quicksaves, by the id the list gave (13.7b) */
const quicksaveId = z.string().regex(/^[a-z0-9]{1,32}$/);
export const quicksaveEntrySchema = z.object({ id: quicksaveId, zeroPage: z.boolean().optional() }).strict();
export const quicksaveRenameSchema = z.object({ id: quicksaveId, name: z.string().trim().min(1).max(80) }).strict();
export const quicksaveSaveSchema = z.object({ id: quicksaveId }).strict();
export const quicksaveFavouriteSchema = z.object({ id: quicksaveId, on: z.boolean() }).strict();
export const viceAttachSchema = z.object({ host: z.string().max(255).optional(), port: z.number().int().min(1).max(65535).optional() }).default({});
export const viceCommandSchema = z.object({ command: z.string().max(4096) });
