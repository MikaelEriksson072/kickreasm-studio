/* =====================================================================
 * Domain model (spec section 6). Shared by the analysis worker, the
 * renderer, the Electron main process and the CLI.
 * ===================================================================== */

export type Addr = number; // 0x0000–0xffff

export type BlockKind =
  | 'code' | 'data' | 'words' | 'text' | 'table' | 'lohi' | 'sprite'
  | 'charset' | 'bitmap' | 'screen' | 'music' | 'fill' | 'basic';

/** Numeric classification id used in the 64 KB type map (`AnalysisResult.tm`). */
export type TypeId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

/** the *-mixed kinds are for the lower case character set (Kick's petscii_mixed / screencode_mixed) */
export type TextEncoding = 'petscii' | 'screen' | 'petscii-mixed' | 'screen-mixed';
export type NumberFormat = 'hex' | 'bin' | 'dec';

export interface LoadedFile {
  id: string;
  name: string;
  load: Addr;
  bytes: Uint8Array;
  /** the VICE snapshot (.vsf) the file was opened from: Build & Run restarts it as it was, the built program in its RAM */
  vsf?: Uint8Array;
}

/** A file as accepted by `analyze()`; ids are only needed by the UI. */
export interface FileInput {
  id?: string;
  name: string;
  load: Addr;
  bytes: Uint8Array;
  vsf?: Uint8Array;
}

export interface OverrideProps {
  enc?: TextEncoding;
  row?: number;
  fmt?: NumberFormat;
  init?: Addr;
  play?: Addr;
  sub?: string;
}

export interface Override {
  start: Addr;
  end: Addr; // exclusive
  type: BlockKind | 'auto'; // 'auto' clears overrides in the range
  props?: OverrideProps;
}

export interface Settings {
  // analysis
  illegal: boolean;
  detectMusic: boolean;
  detectGfx: boolean;
  detectText: boolean;
  /** follow the memory configuration ($01) and VIC bank along the code paths */
  bankTracking: boolean;
  /** a VICE snapshot opens from $0002, the zero page and the stack included, instead of from $0200 */
  snapshotZeroPage: boolean;
  /** data nothing traced reaches that decodes as a routine (6+ instructions ending in RTS, RTI or JMP) is code */
  codeIslands: boolean;
  /** deep analysis: slower, re-analyses until the problems are at a minimum (guesses are traced on trial, calls into
   * ROM, self-modified jump targets and branches with known flags are not followed) */
  deepAnalysis: boolean;
  // output
  mnemonicCase: 'lower' | 'upper';
  hexCase: 'lower' | 'upper';
  bytesPerRow: number;
  indent: number;
  commentCol: number;
  basicUpstart: boolean;
  hwInclude: 'import' | 'inline' | 'none';
  hwComments: boolean;
  musicAsSid: boolean;
  gfxBinary: boolean;
  addrComments: boolean;
  /** the export's document with the bookmarks and comments: NOTES.html, NOTES.txt, or none */
  notesFormat: 'html' | 'txt' | 'none';
  // toolchain (used by the Electron main process and the CLI)
  javaPath: string;
  kickJar: string;
  vicePath: string;
  outDir: string;
  kickArgs: string;
  viceArgs: string;
  /** an external unpacker for packed PRGs (unp64) and its argument template: {in} the packed PRG, {out} the result */
  unpackerPath: string;
  unpackerArgs: string;
  /** Exomizer 3, which packs the built PRG or chosen blocks of it (the Pack view) */
  exomizerPath: string;
  /** VICE's quicksave snapshot; empty: C64SC.vsf / C64.vsf in VICE's settings folder, where Alt+F11 writes it */
  viceQuicksave: string;
}

export type ToolchainSettings = Pick<Settings, 'javaPath' | 'kickJar' | 'vicePath' | 'outDir' | 'kickArgs' | 'viceArgs' | 'unpackerPath' | 'unpackerArgs' | 'exomizerPath' | 'viceQuicksave'>;

/** A comment on lines of its own above an address: one `//` line per text line, or (block) one multi-line block comment. */
export interface Note { text: string; block?: boolean }

/** A bookmark: the user's own note on an address, listed with its title; kept in the project, never in the source. */
export interface Bookmark { title: string; text: string }
/** the build scripts of an exported project, which the user can edit */
export type BuildScript = 'build.bat' | 'build.sh';

/** Exomizer's output (spec 13.8): a self-extracting program (sfx) or crunched data that your own code decrunches (mem) */
export type PackMode = 'sfx' | 'mem';
/** sfx: what runs after decrunching: the SYS of the BASIC line, the BASIC program (RUN), or a jmp to `PackPrefs.jmp` */
export type PackStart = 'sys' | 'basic' | 'jmp';
/** sfx: Exomizer's decrunch effect (a flashing character), none (-n), or one of its border flashes (-x1 to -x3) */
export type PackEffect = 'default' | 'none' | 'x1' | 'x2' | 'x3';
/** an address range to pack; `end` exclusive */
export interface PackRange { start: Addr; end: Addr }

/** How the project is packed with Exomizer (the Pack view); kept in the project. */
export interface PackPrefs {
  mode: PackMode;
  /** null: the built PRGs whole; otherwise these ranges of them (sorted, not overlapping) */
  ranges: PackRange[] | null;
  start: PackStart;
  /** the jmp address for start 'jmp' */
  jmp: Addr | null;
  effect: PackEffect;
  /** sfx: $01 after decrunching (null: Exomizer's default, $37) */
  ramExit: number | null;
  /** sfx: interrupts after decrunching, cli (true) or sei (false); null: Exomizer's default (enabled) */
  irqExit: boolean | null;
  /** mem: the load address of the output: in-place decrunching (auto), a plain file without one (none), or this address */
  memLoad: 'auto' | 'none' | Addr;
  /** mem: crunch forward (-f) instead of backward */
  forward: boolean;
  /** -c: no literal sequences (for old decrunchers) */
  compat: boolean;
  /** -C: favour crunching speed over ratio */
  fast: boolean;
  /** more Exomizer options as typed (no paths and no -o: the app names the files) */
  extra: string;
  /** the packed file's name; empty: <first file>-exo.prg */
  out: string;
}

/**
 * The user's word on what code in a range runs with: the value of $01 (only bits 0-2 count) and/or the
 * VIC bank (0-3). It replaces the detected state there and flows on to the code it reaches.
 * Later zones win; `null` returns that part of the range to detection.
 */
export interface BankZone { start: Addr; end: Addr; port?: number | null; vicBank?: number | null }

export interface Project {
  format: 'mimir-project';
  version: 1;
  name: string;
  files: LoadedFile[]; // one or more PRG files
  overrides: Override[]; // ordered, later wins
  entries: Addr[]; // extra user entry points
  entryPoint: Addr | null; // the program start set by the user (null: BASIC SYS or the load address)
  labels: Record<Addr, string>; // user names (empty string = restore)
  comments: Record<Addr, string>; // line comments
  blockComments: Record<Addr, string>; // comments above blocks
  notes: Record<Addr, Note>; // comment lines and blocks the user inserted above an address
  bankZones: BankZone[]; // ordered, later wins: memory configuration / VIC bank code runs with
  excluded: Addr[]; // starts of the blocks left out of the build (kept in the source under #if)
  binary: Addr[]; // starts of the blocks written to their own file and loaded with .import binary
  bookmarks: Record<Addr, Bookmark>; // the user's notes on addresses (the Bookmarks list); not written to the source
  /** build.bat / build.sh as the user edited them: the export writes these instead of the generated scripts */
  scripts: Partial<Record<BuildScript, string>>;
  /** how the Pack view packs the project with Exomizer (missing or null: not set up yet) */
  pack?: PackPrefs | null;
  settings: Settings;
}

/** What `analyze()` and `render()` need; tests and the CLI build these directly. */
export interface ProjectInput {
  name?: string;
  files: FileInput[];
  overrides?: Override[];
  entries?: Addr[];
  /** the program start set by the user; replaces the detected one (BASIC SYS target or the first file's load address) */
  entryPoint?: Addr | null;
  labels?: Record<Addr, string>;
  comments?: Record<Addr, string>;
  blockComments?: Record<Addr, string>;
  notes?: Record<Addr, Note>;
  bankZones?: BankZone[];
  /** starts of the blocks left out of the build: they stay in the source under `#if INCLUDE_<name>` */
  excluded?: Addr[];
  /** starts of the blocks saved as `data/<name>.bin` and loaded with `.import binary` */
  binary?: Addr[];
  /** the user's notes on addresses; they change nothing in the analysis or the output */
  bookmarks?: Record<Addr, Bookmark>;
  scripts?: Partial<Record<BuildScript, string>>;
  settings?: Partial<Settings>;
}

/** On-disk `.mimir.json` form: file bytes are base64. */
/** The format of projects saved before the program was renamed to Mimir Studio; they still open. */
export const LEGACY_PROJECT_FORMAT = 'kickreasm-project';

export interface SerializedProject {
  /** `kickreasm-project`: saved before the program was called Mimir Studio (read, never written) */
  format: 'mimir-project' | typeof LEGACY_PROJECT_FORMAT;
  version: 1;
  name: string;
  /** `vsf`: the snapshot the file was opened from (base64), missing in project files from before snapshots were kept */
  files: { name: string; load: Addr; data: string; vsf?: string }[];
  overrides: Override[];
  entries: Addr[];
  /** missing in project files from before the program start could be set */
  entryPoint?: Addr | null;
  labels: Record<string, string>;
  comments: Record<string, string>;
  blockComments: Record<string, string>;
  /** missing in project files from before comment lines and blocks existed */
  notes?: Record<string, Note>;
  /** missing in project files from before bank zones existed */
  bankZones?: BankZone[];
  /** missing in project files from before blocks could be excluded */
  excluded?: Addr[];
  /** missing in project files from before blocks could be binary files */
  binary?: Addr[];
  /** missing in project files from before bookmarks */
  bookmarks?: Record<Addr, Bookmark>;
  scripts?: Partial<Record<BuildScript, string>>;
  /** missing in project files from before packing with Exomizer */
  pack?: PackPrefs | null;
  settings: Partial<Settings>;
}

export interface BlockProps {
  enc?: TextEncoding;
  sub?: string;
  part?: 'lo' | 'hi';
  partner?: Addr;
  ptr?: boolean;
  code?: boolean;
  value?: number;
  var?: boolean;
  indexed?: boolean;
  init?: Addr;
  play?: Addr;
  row?: number;
  fmt?: NumberFormat;
}

export interface Block {
  id: number;
  start: Addr;
  end: Addr;
  type: BlockKind;
  file: number;
  props: BlockProps;
  conf: number; // 0–1
  reason: string; // evidence in plain words, shown in the Inspector
  user: boolean; // set by the user
  entropy: number; // bits/byte
  hint?: 'code';
}

export type XRefKind = 'call' | 'jump' | 'branch' | 'read' | 'write' | 'rmw' | 'ptr';
export interface XRef { from: Addr; kind: XRefKind }

/** `guess`: data nothing traced reaches that decodes as a routine (`Settings.codeIslands`) */
export type EntryKind = 'entry' | 'irq' | 'nmi' | 'brk' | 'sub' | 'ptr' | 'user' | 'guess' | 'jmp' | 'branch';

export type LogLevel = 'info' | 'ok' | 'warn' | 'err' | 'hint';
export interface LogEntry { lvl: LogLevel; msg: string; addr: Addr | null; cat: string }

export interface BasicLine { addr: Addr; num: number; toks: number[]; text: string }
export interface BasicInfo {
  start: Addr;
  end: Addr;
  lines: BasicLine[];
  sys: Addr | null;
  sysLine: BasicLine | null;
  upstart: boolean;
  file?: number;
}

/**
 * Timing code (5.4b): the branch at `branch`, whose offset the store at `by` sets from the timer `timer` (read at
 * `read`), enters the delay `start`-`end` (exclusive) 0 to `most` bytes in; `enter`: where it goes in the loaded
 * bytes. `ins`: the delay's instructions, decoded from its start; `cycles`: the fewest and most they take.
 */
export interface DelaySled { branch: Addr; by: Addr; read: Addr; timer: Addr; start: Addr; end: Addr; enter: number; most: number; cycles: [number, number]; ins: Addr[] }

/** What ends a Spindle part: the condition column of Pefchain's script (`space`, `-`, `stay`, `addr = value`, `@`). */
export type SpindleCondition =
  | { kind: 'space' } | { kind: 'drop' } | { kind: 'stay' }
  | { kind: 'value'; addr: Addr; value: number }
  /** `@`: the music's interlock at `addr` (pefchain -@) */
  | { kind: 'sync'; addr: Addr };

/**
 * A Pefchain effect driver in memory (5.4c): the code Spindle's linker builds from one line of its script. It installs
 * the part's interrupt, calls its setup, loads, waits for the condition, runs the fadeout and the cleanup and jumps to
 * the next part's driver. The routines are the part's own (its .efo header); null where it has none.
 */
export interface SpindleDriver {
  /** its part's number in the order the parts run, among the drivers in memory, from 1 (`|` goes on with a part) */
  part: number;
  /** its first byte (in the first driver the early setup) and one past its last */
  start: Addr; end: Addr;
  /** where the driver before jumps in */
  front: Addr;
  /** where a seek to a label, or the next disk side, comes in */
  side: Addr | null;
  /** the first driver, which the loader runs once it has loaded the first part; `ownSetup`: the early setup before
   *  it is the demo's own (pefchain -s), not Spindle's */
  first: boolean; ownSetup: boolean;
  prepare: Addr | null; setup: Addr | null; irq: Addr | null; main: Addr | null; fadeout: Addr | null; cleanup: Addr | null;
  /** the next part's prepare, which this driver calls once it has loaded */
  prepareNext: Addr | null;
  condition: SpindleCondition;
  /** it calls the loader in the resident page */
  loads: boolean;
  /** the next driver's front door; how it ends: that driver, the end of the demo, staying, or the next disk side */
  next: Addr | null;
  ends: 'next' | 'stop' | 'stay' | 'flip';
  /** the label it seeks before it jumps back (the script loops, pefchain -L) */
  seek: number | null;
  /** its fadeout leaves a label to seek to (the J tag) */
  jump: boolean;
  /** `|`: it goes on with the part before; `blank`: Pefchain's blank part, `music` the play routine it calls */
  extend: boolean; blank: boolean; music: Addr | null;
  /** in a snapshot: the part that runs (the PC is in its driver, or the IRQ vector points at its interrupt) */
  running: boolean;
}

/** What the deep analysis did (5.17): its rounds and the problems before (a normal analysis) and after. */
export interface DeepReport {
  rounds: number;
  /** problems (log warnings, errors and hints) of the normal analysis and of the deep one */
  before: number;
  after: number;
  /** guesses (code islands, pointer targets, the load address) that tracing showed to lead into problems */
  rejected: number;
  /** calls and jumps not followed: into ROM, through a self-modified operand, past a routine that never returns */
  cuts: number;
  /** conditional branches whose flags the instruction before sets, so one side is never taken */
  branches: number;
  ms: number;
}

/** An IRQ handler and the raster line it runs at (5.16). */
export interface RasterIrq {
  handler: Addr;
  /** $d012 with bit 7 of $d011 as bit 8 (taken as 0 when $d011 is not written there); null when $d012 is not a constant */
  line: number | null;
  d012: number | null;
  /** what is written to $d011 there: the value when it is a constant, and bit 7 when that is known (`and #$7f`) */
  d011: { value: number | null; bit8: 0 | 1 | null; at: Addr } | null;
  /** the store to $d012 */
  setAt: Addr | null;
  /** the vector ($fffe or $0314) set to the handler and where (its low byte); null when the handler sets its own next line */
  vector: Addr | null;
  installedAt: Addr | null;
  /** the handler whose code does it (a raster chain); null for the main code */
  from: Addr | null;
}

export interface MusicInfo {
  start: Addr;
  end: Addr;
  init: Addr;
  play: Addr;
  sidRegs: number;
  score: number;
  why: string[];
  file: number;
  user?: boolean;
}

export interface SpriteRef { n: number; ptr: number; addr: Addr }
export interface VicEvidence {
  banks: Set<number>;
  d018: Set<number>;
  bitmap: boolean;
  multicolor: boolean;
  sprites: SpriteRef[];
}

export interface GfxCandidate { type: TypeId; start: Addr; size: number; why: string }

export interface LohiTable {
  lo: Addr;
  hi: Addr;
  len: number;
  ptr: boolean;
  dest: Addr;
  code: boolean;
  targets: Addr[];
  part: 'lo' | 'hi';
  partner: Addr;
}

export interface IndirectJump { pc: Addr; ptr: Addr }
export interface ZpVar { name: string; ptr?: boolean; off?: number; user?: boolean }
export interface ImmediateHint { kind: 'lo' | 'hi'; target: Addr }
export interface LabelInfo { name: string; kind: string }

export interface Stats {
  mn: Record<string, number>;
  modes: Record<string, number>;
  illegal: number;
  illegalList: Addr[];
  ins: number;
  bytesByType: Record<number, number>;
  codeBytes: number;
  total: number;
  xrefs: number;
  entries: number;
  labels: number;
  ms: number;
}

/** Plain data (structured-clone safe) so it can cross the worker boundary. */
export interface AnalysisResult {
  S: Settings;
  files: FileInput[];
  mem: Uint8Array;
  owner: Int16Array; // file index owning each byte, -1 = not loaded
  insLen: Uint8Array;
  codeOwner: Int32Array;
  skip: Set<Addr>;
  xrefs: Map<Addr, XRef[]>;
  entryKind: Map<Addr, EntryKind>;
  entry: Addr | null;
  basics: BasicInfo[];
  music: MusicInfo[];
  vic: VicEvidence;
  gfx: GfxCandidate[];
  tm: Uint8Array; // TypeId per byte
  blocks: Block[];
  labels: Map<Addr, LabelInfo>;
  zp: Map<Addr, ZpVar>;
  hints: Map<Addr, ImmediateHint>; // #<label / #>label
  smc: Map<Addr, Addr>;
  offsetOf: Map<Addr, Addr>;
  lohiTabs: Map<Addr, LohiTable>;
  ijumps: IndirectJump[];
  inlineCalls: Set<Addr>;
  log: LogEntry[];
  stats: Stats;
  textPtrs: Map<Addr, TextEncoding>;
  /** memory configuration and VIC bank per instruction; null when `bankTracking` is off */
  mcfg: MemConfigInfo | null;
  /** the fast, IRQ and tape loaders found, and the KERNAL's LOAD (analyze/loaders.ts) */
  loaders: LoaderFinding[];
  /** the IRQ handlers and the raster lines they run at (5.16) */
  raster: RasterIrq[];
  /** timing code (5.4b): branches the code points into a delay by a timer */
  delays: DelaySled[];
  /** Spindle's effect drivers (5.4c), in the order the parts run */
  spindle: SpindleDriver[];
  /** what the deep analysis did (`Settings.deepAnalysis`); null without it */
  deep: DeepReport | null;
}

export type LoaderId = 'spindle' | 'krill' | 'bitfire' | 'sparkle' | 'covert' | 'fastloader' | 'tape' | 'kernal';
/** part of a loader: the code on the C64 that receives the data (resident), the code that runs in the drive, the drive
 *  commands that upload and start it, the code that sends them, a tape loader's code, a KERNAL LOAD call, or its name */
export interface LoaderPart { start: Addr; end: Addr; role: 'resident' | 'drivecode' | 'command' | 'install' | 'tape' | 'kernal' | 'text'; what: string }
export interface LoaderFinding {
  id: LoaderId; name: string;
  /** 'match': its own code (or name) was found; 'likely': what loaders do was found */
  sure: 'match' | 'likely';
  /** how it works, in a few words */
  how: string;
  parts: LoaderPart[];
}

/** Result of following $01 and the VIC bank along the traced code (masks, see c64/memconfig). */
export interface MemConfigInfo {
  /** possible $01 configurations (bit c: $01 & 7 may be c) on entry to each instruction; 0 = not code */
  port: Uint8Array;
  /** possible VIC banks (bit b: bank b) on entry to each instruction */
  vic: Uint8Array;
  /** instructions that change $01 or the VIC bank: the masks right after them */
  changes: Map<Addr, { port?: number; vic?: number; via: '$01' | '$dd00' | '$dd02' }>;
  /** where the user set the state (BankZone), per address: 0 = detected */
  forcedPort: Uint8Array;
  forcedVic: Uint8Array;
}

/* ---------- symbols ---------- */
export interface SymbolRef {
  name: string;
  desc: string;
  cat: string;
  addr: Addr;
  size?: number;
  call?: boolean;
}
export interface HwSymbol extends SymbolRef { size: number; call: boolean }
export interface SymbolRegion { name: string; start: Addr; size: number; desc: string; cat: string; grid: boolean }
export interface HwMatch { sym: SymbolRef; off: number; text: string; mirror?: boolean }

/* ---------- line model ---------- */
export type TokenKind = 'lbl' | 'hw' | 'kw' | 'num' | 'str' | 'dir' | 'def' | 'p';
export interface Token {
  t: TokenKind;
  s: string;
  to?: Addr;
  sym?: SymbolRef;
  /** true on references to zero-page variables, the address on `.label` definitions */
  zp?: boolean | number;
}

export type ForcedMode = '' | '.abs' | '.zp';

export type Line =
  /** `preview`: listing only, the block is shown as code (RenderOptions.dataAsCode) */
  | { k: 'hdr'; a: Addr; blk: number; type: TypeId; text: string; preview?: boolean; excluded?: boolean; binary?: string }
  | { k: 'lbl'; a: Addr; name: string }
  | { k: 'ins'; a: Addr; n: number; mn: string; ext: ForcedMode; tok: Token[]; cmt: string; ill?: boolean; userCmt?: boolean; preview?: boolean; delay?: boolean }
  | { k: 'dat'; a: Addr; n: number; dir: '.byte' | '.word' | '.text'; tok: Token[]; cmt: string; mn?: string; ill?: boolean; userCmt?: boolean; preview?: boolean }
  | { k: 'dir'; a: Addr; n: number; tok: Token[]; cmt?: string; zp?: Addr; userCmt?: boolean }
  /** `raw`: written as it is (the lines of a block comment); `note`: part of a user Note; `zp`: the note is on the
   *  zero-page variable at this address (its `.label` line in the file head, whose `a` is the file's load address);
   *  `mark`: a mark the analysis made (where a loader part starts or ends) */
  | { k: 'cmt'; a: Addr; text: string; raw?: boolean; note?: boolean; zp?: Addr; mark?: boolean }
  | { k: 'blank'; a: Addr };

/** Listing-only separator between the files of a multi-file project. */
export interface FileLine { k: 'file'; a: Addr; text: string; fi: number }
export type ListingLine = Line | FileLine;

export interface RenderLabel { name: string; kind: string; user: boolean }
export interface RenderProblem { lvl: 'err'; msg: string; addr: Addr | undefined }

export interface RenderResult {
  lines: ListingLine[];
  files: Record<string, string | Uint8Array>;
  fileLines: Record<string, Line[]>;
  labels: Map<Addr, RenderLabel>;
  zp: Map<Addr, ZpVar>;
  fileNames: string[];
  problems: RenderProblem[];
  usedHw: Set<Addr>;
  /** blocks left out of the build (project.excluded): their bytes are not in the output, `name` is the #if symbol */
  excluded: ExcludedRange[];
}

export interface ExcludedRange { start: Addr; end: Addr; file: number; name: string }

/* ---------- verification ---------- */
export type Vfs = Record<string, string | Uint8Array>;
export interface AsmError { msg: string; file: string; line: number }
export interface AsmBlock { start: Addr; name: string; end: Addr }
export interface AssembleResult {
  mem: Uint8Array;
  written: Uint8Array;
  min: number;
  max: number;
  errors: AsmError[];
  prg: Uint8Array | null;
  blocks: AsmBlock[];
  symbols: Map<string, unknown>;
}
export interface VerifyDiff { addr: number; msg?: string; exp?: number; got?: number | null }
export interface FileVerifyResult {
  file: string;
  path: string;
  ok: boolean;
  same: number;
  total: number;
  diffs: VerifyDiff[];
  errors: AsmError[];
  prg: Uint8Array | null;
  blocks: AsmBlock[];
  /** bytes of blocks left out of the build: not compared (`total` counts only the compared bytes) */
  excluded: number;
}
export interface VerifyResult { ok: boolean; results: FileVerifyResult[] }

/** A diagnostic reported by the real Kick Assembler (parsed from its output). */
export interface KickProblem {
  severity: 'error' | 'warning';
  file: string;
  line: number;
  column: number;
  message: string;
}
