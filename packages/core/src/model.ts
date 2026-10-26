import type { BlockKind, OverrideProps, Settings, TypeId } from './types';

/** Classification ids used in the 64 KB type map. */
export const T = {
  NONE: 0, DATA: 1, CODE: 2, BASIC: 3, TEXT: 4, TABLE: 5, LOHI: 6, WORDS: 7,
  SPRITE: 8, CHARSET: 9, BITMAP: 10, SCREEN: 11, MUSIC: 12, FILL: 13,
} as const satisfies Record<string, TypeId>;

export type TypeGroup = 'code' | 'basic' | 'gfx' | 'music' | 'table' | 'text' | 'data' | 'fill';
export interface TypeInfo { key: BlockKind; label: string; group: TypeGroup }

export const TYPE_INFO: Record<Exclude<TypeId, 0>, TypeInfo> = {
  [T.DATA]: { key: 'data', label: 'Data', group: 'data' },
  [T.CODE]: { key: 'code', label: 'Code', group: 'code' },
  [T.BASIC]: { key: 'basic', label: 'BASIC', group: 'basic' },
  [T.TEXT]: { key: 'text', label: 'Text', group: 'text' },
  [T.TABLE]: { key: 'table', label: 'Table', group: 'table' },
  [T.LOHI]: { key: 'lohi', label: 'Lo/Hi table', group: 'table' },
  [T.WORDS]: { key: 'words', label: 'Word table', group: 'table' },
  [T.SPRITE]: { key: 'sprite', label: 'Sprites', group: 'gfx' },
  [T.CHARSET]: { key: 'charset', label: 'Charset', group: 'gfx' },
  [T.BITMAP]: { key: 'bitmap', label: 'Bitmap', group: 'gfx' },
  [T.SCREEN]: { key: 'screen', label: 'Screen matrix', group: 'gfx' },
  [T.MUSIC]: { key: 'music', label: 'Music (SID)', group: 'music' },
  [T.FILL]: { key: 'fill', label: 'Fill', group: 'fill' },
};

export const TYPE_BY_KEY = Object.fromEntries(
  Object.entries(TYPE_INFO).map(([id, i]) => [i.key, +id]),
) as Record<BlockKind, Exclude<TypeId, 0>>;

/** Type info for a block kind (blocks carry the string kind, the type map the id). */
export const kindInfo = (k: BlockKind): TypeInfo => TYPE_INFO[TYPE_BY_KEY[k]];

/** Type info for a type-map id; ids outside the table count as data. */
export const typeInfo = (t: number): TypeInfo => TYPE_INFO[t as Exclude<TypeId, 0>] ?? TYPE_INFO[T.DATA];

export interface MarkAs { id: string; label: string; key?: string; type: Exclude<TypeId, 0>; props?: OverrideProps }

/** User-facing "Mark as" choices -> type + props. */
export const MARK_AS: MarkAs[] = [
  { id: 'code', label: 'Code', key: 'C', type: T.CODE },
  { id: 'bytes', label: 'Bytes (.byte)', key: 'D', type: T.DATA },
  { id: 'words', label: 'Words (.word)', key: 'W', type: T.WORDS },
  { id: 'text', label: 'Text (PETSCII)', key: 'T', type: T.TEXT, props: { enc: 'petscii' } },
  { id: 'textsc', label: 'Text (screen codes)', type: T.TEXT, props: { enc: 'screen' } },
  { id: 'textmix', label: 'Text (PETSCII, mixed case)', type: T.TEXT, props: { enc: 'petscii-mixed' } },
  { id: 'textscmix', label: 'Text (screen codes, mixed case)', type: T.TEXT, props: { enc: 'screen-mixed' } },
  { id: 'table', label: 'Table (curve/values)', type: T.TABLE, props: { sub: 'table' } },
  { id: 'sprite', label: 'Sprite data', type: T.SPRITE },
  { id: 'charset', label: 'Charset', type: T.CHARSET },
  { id: 'bitmap', label: 'Bitmap', type: T.BITMAP },
  { id: 'screen', label: 'Screen matrix', type: T.SCREEN },
  { id: 'music', label: 'Music (SID binary)', type: T.MUSIC },
  { id: 'fill', label: 'Fill', type: T.FILL },
];

/** "Mark as" id -> override type stored in the project. */
export const MARK_TYPE: Record<string, BlockKind> = {
  code: 'code', bytes: 'data', words: 'words', text: 'text', textsc: 'text', textmix: 'text', textscmix: 'text', table: 'table',
  sprite: 'sprite', charset: 'charset', bitmap: 'bitmap', screen: 'screen', music: 'music', fill: 'fill',
};

export const DEFAULT_SETTINGS: Settings = {
  // analysis
  illegal: true, detectMusic: true, detectGfx: true, detectText: true, bankTracking: true, snapshotZeroPage: false, codeIslands: true,
  // output
  mnemonicCase: 'lower', hexCase: 'lower', bytesPerRow: 8, indent: 8, commentCol: 40,
  basicUpstart: true, hwInclude: 'import', hwComments: true, musicAsSid: true, gfxBinary: true, addrComments: false, notesFormat: 'html',
  // toolchain (used by the Electron main process and the CLI)
  javaPath: 'java', kickJar: 'C:\\C64\\KickAssembler\\KickAss.jar', vicePath: 'C:\\C64\\VICE\\bin\\x64sc.exe',
  outDir: 'out', kickArgs: '-vicesymbols -showmem', viceArgs: '-autostartprgmode 1',
  // an external unpacker for packed PRGs (unp64): its path and arguments ({in} the packed PRG, {out} the result)
  unpackerPath: '', unpackerArgs: '{in}',
  // Exomizer 3 for the Pack view (the installed app comes with one)
  exomizerPath: '',
  // VICE's quicksave snapshot (empty: the one VICE writes in its settings folder)
  viceQuicksave: '',
};

export const TOOLCHAIN_KEYS = ['javaPath', 'kickJar', 'vicePath', 'outDir', 'kickArgs', 'viceArgs', 'unpackerPath', 'unpackerArgs', 'exomizerPath', 'viceQuicksave'] as const;
