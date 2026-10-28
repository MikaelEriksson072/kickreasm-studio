/* Shared mutable state of one analysis run. Every stage in analyze/* reads
 * and writes this object; the order of the stages is fixed in analyze/index. */
import type {
  Addr, BasicInfo, DelaySled, EntryKind, FileInput, ImmediateHint, IndirectJump, LogEntry, LogLevel,
  LohiTable, Override, ProjectInput, Settings, SpindleDriver, TextEncoding, XRef, XRefKind,
} from '../types';
import { DEFAULT_SETTINGS, T } from '../model';

/** Entry-point priority: a stronger kind replaces a weaker one at the same address. */
export const PRI: Record<EntryKind, number> = { entry: 9, irq: 8, nmi: 8, brk: 7, user: 7, sub: 6, ptr: 5, guess: 4, jmp: 3, branch: 2 };
export const VECTORS: Record<number, 'irq' | 'brk' | 'nmi' | undefined> = { 0x0314: 'irq', 0x0316: 'brk', 0x0318: 'nmi', 0xfffe: 'irq', 0xfffa: 'nmi' };
export const PET_CTRL = new Set([0x05, 0x0d, 0x0e, 0x11, 0x12, 0x13, 0x1c, 0x1d, 0x1e, 0x1f, 0x81, 0x8e, 0x90, 0x91, 0x92, 0x93, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f]);

/** Constant written to memory by a store instruction (evidence pass). */
export interface WriteEvidence { pc: Addr; dest: Addr; v: number | null; indexed?: boolean }
/** `LDA tA,X / STA p / LDA tB,X / STA p+1` pair candidate. */
export interface LohiPair { lo: Addr; hi: Addr; dest: Addr; r: 'x' | 'y'; pc: Addr }

/** Evidence collected by the linear constant-propagation pass; rebuilt on every pass. */
export interface Evidence {
  writes: WriteEvidence[];
  hints: Map<Addr, ImmediateHint>;
  ptrTargets: Map<Addr, Addr>;
  lohi: LohiPair[];
  dataEv: Map<Addr, Set<string>>;
  wordPtrs: Set<Addr>;
  textPtrs: Map<Addr, TextEncoding>;
  smc: Map<Addr, Addr>;
  /** interrupt handler -> the vector addresses it was installed through */
  vectors: Map<Addr, Set<Addr>>;
}

export interface Ctx {
  project: ProjectInput;
  S: Settings;
  files: FileInput[];
  mem: Uint8Array;
  owner: Int16Array;
  log: LogEntry[];
  /** the messages logged so far (each is logged once) */
  logged: Set<string>;
  L: (lvl: LogLevel, msg: string, addr?: Addr | null, cat?: string) => void;
  loaded: (a: number) => boolean;
  // overrides
  ov: Uint8Array;
  ovList: Override[];
  ovProps: Map<Addr, Override>;
  forcedData: (a: Addr) => boolean;
  // entry points and tracing
  basics: BasicInfo[];
  insLen: Uint8Array;
  codeOwner: Int32Array;
  skip: Set<Addr>;
  xrefs: Map<Addr, XRef[]>;
  addX: (to: Addr, from: Addr, kind: XRefKind) => void;
  entryKind: Map<Addr, EntryKind>;
  queue: Addr[];
  enqueue: (a: Addr, kind: EntryKind, sure?: boolean) => void;
  ijumps: IndirectJump[];
  inlineCalls: Set<Addr>;
  entry: Addr | null;
  // evidence and tables
  ev: Evidence;
  lohiTabs: Map<Addr, LohiTable>;
  /** .word tables of code addresses that an indirect JMP goes through: start -> length in bytes, vector, targets */
  wordTables: Map<Addr, { len: number; dest: Addr; targets: Addr[] }>;
  /** timing code (5.4b): the branches into a delay, and the delays' instructions */
  delays: Map<Addr, DelaySled>;
  delayIns: Set<Addr>;
  /** Spindle's effect drivers (5.4c), in the order the parts run */
  spindle: SpindleDriver[];
  // deep analysis (5.17); null without it
  deep: Deep | null;
  /** guesses waiting to be traced on trial: code islands, pointer-table targets, interrupt handlers, the load address */
  pending: { a: Addr; kind: EntryKind }[];
  /** guesses that tracing on trial showed to lead into problems: the first problem */
  rejected: Map<Addr, { kind: EntryKind; why: LogEntry }>;
  /** calls and jumps not followed, `from * 0x10000 + to` */
  cuts: Map<number, CutWhy>;
  /** conditional branches whose flags the instruction before (`by`) sets: the side not followed */
  flagCut: Map<Addr, { side: Addr; by: Addr }>;
  /** a copy that traces a guess on trial: a BRK or JAM where code is not there yet counts against it */
  onTrial: boolean;
}

/**
 * Why a deep analysis does not follow a call or jump: it reaches ROM, its operand is written by code, the routine is
 * not there yet (a BRK or JAM where it starts), or it never returns.
 */
export type CutWhy = 'rom' | 'smc' | 'empty' | 'noreturn';

/** What a round of a deep analysis learned for the next one (5.17). */
export interface Deep {
  /** the $01 configurations each instruction can run with (0: not code), and their union over all code */
  port: Uint8Array | null;
  main: number;
  /** the bytes code writes */
  written: Uint8Array | null;
  /** JSRs to routines that never return */
  noReturn: Set<Addr>;
}

/** The entry points a deep analysis traces on trial before it keeps them. */
export const WEAK: ReadonlySet<EntryKind> = new Set<EntryKind>(['guess', 'ptr', 'irq', 'nmi', 'brk']);
export const cutKey = (from: Addr, to: Addr): number => from * 0x10000 + (to & 0xffff);

export const emptyEvidence = (): Evidence => ({
  writes: [], hints: new Map(), ptrTargets: new Map(), lohi: [], dataEv: new Map(), wordPtrs: new Set(), textPtrs: new Map(), smc: new Map(), vectors: new Map(),
});

export function createContext(project: ProjectInput, deep: Deep | null = null): Ctx {
  const S: Settings = Object.assign({}, DEFAULT_SETTINGS, project.settings || {});
  const mem = new Uint8Array(0x10000);
  const owner = new Int16Array(0x10000).fill(-1);
  const loaded = (a: number) => a >= 0 && a < 0x10000 && owner[a] >= 0;
  const ov = new Uint8Array(0x10000);
  const ctx = {
    project, S, files: project.files, mem, owner, log: [], logged: new Set(), loaded,
    ov, ovList: [], ovProps: new Map(), forcedData: (a: Addr) => ov[a] !== 0 && ov[a] !== T.CODE,
    basics: [], insLen: new Uint8Array(0x10000), codeOwner: new Int32Array(0x10000).fill(-1), skip: new Set(), xrefs: new Map(),
    entryKind: new Map(), queue: [],
    ijumps: [], inlineCalls: new Set(), entry: null,
    ev: emptyEvidence(), lohiTabs: new Map(), wordTables: new Map(), delays: new Map(), delayIns: new Set(), spindle: [],
    deep: S.deepAnalysis ? deep ?? { port: null, main: 0, written: null, noReturn: new Set() } : null,
    pending: [], rejected: new Map(), cuts: new Map(), flagCut: new Map(), onTrial: false,
  } as unknown as Ctx;
  return bind(ctx);
}

/** The log, cross-reference and entry-point functions of `ctx`, over its own state. */
function bind(ctx: Ctx): Ctx {
  const { log, logged, xrefs, entryKind, queue, insLen, loaded, pending } = ctx;
  ctx.L = (lvl: LogLevel, msg: string, addr: Addr | null = null, cat = 'analysis') => {
    const key = lvl + msg; if (logged.has(key)) return; logged.add(key);
    log.push({ lvl, msg, addr, cat });
  };
  ctx.addX = (to, from, kind) => {
    to &= 0xffff; let l = xrefs.get(to);
    if (!l) xrefs.set(to, l = []);
    if (!l.some(x => x.from === from && x.kind === kind)) l.push({ from, kind });
  };
  // a deep analysis keeps a guess only once tracing it on trial shows no problems (`sure`: it did)
  ctx.enqueue = (a, kind, sure = false) => {
    a &= 0xffff;
    if (!loaded(a)) return;
    if (ctx.deep && !sure && WEAK.has(kind) && !insLen[a]) { pending.push({ a, kind }); return; }
    const k = entryKind.get(a);
    if (!k || PRI[kind] > PRI[k]) entryKind.set(a, kind);
    if (!insLen[a]) queue.push(a);
  };
  return ctx;
}

/** A copy of the trace state of `ctx` to trace a guess on trial: what it logs is its own, the rest is shared. */
export function forkTrace(ctx: Ctx): Ctx {
  return bind({
    ...ctx, insLen: ctx.insLen.slice(), codeOwner: ctx.codeOwner.slice(), skip: new Set(ctx.skip), xrefs: new Map(),
    entryKind: new Map(ctx.entryKind), queue: [], ijumps: [], inlineCalls: new Set(ctx.inlineCalls),
    log: [], logged: new Set(ctx.logged), pending: [], cuts: new Map(), flagCut: new Map(ctx.flagCut), onTrial: true,
  });
}
