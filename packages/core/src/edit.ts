/* Editing helpers the UI and the CLI share: they turn an intent into the override that does it. */
import type { Addr, AnalysisResult, Block, BlockKind, ListingLine, Override, OverrideProps, Project } from './types';
import { findBlock } from './analyze/classify';
import { MARK_AS, MARK_TYPE } from './model';
import { h4 } from './util/hex';

export interface BlockMerge {
  /** append it to `project.overrides` */
  override: Override;
  /** the block at the address and the neighbour it is merged with */
  block: Block;
  other: Block;
  /** the type the merged block gets (the type of `block`, as far as an override can say it) */
  into: BlockKind;
}

/** Detected-only kinds an override cannot reproduce over a longer range become plain data. */
const AS_OVERRIDE: Partial<Record<BlockKind, BlockKind>> = { lohi: 'data', basic: 'data' };

/** An override that gives `start`..`end` the type and settings of block `b` (text encoding, table kind, number
 *  format and row length, music init/play). */
function overrideLike(b: Block, start: Addr, end: Addr): Override {
  const type = AS_OVERRIDE[b.type] ?? b.type;
  const p = b.props, props: OverrideProps = {};
  if (type === 'text' && p.enc) props.enc = p.enc;
  if (type === 'table' && p.sub) props.sub = p.sub;
  if (type === 'data') { if (p.fmt) props.fmt = p.fmt; if (p.row) props.row = p.row; }
  if (type === 'music') { if (p.init != null) props.init = p.init; if (p.play != null) props.play = p.play; }
  return { start, end, type, ...(Object.keys(props).length ? { props } : {}) };
}

/** the neighbour of `b` before or after it, when it is in the same file and touches it */
function neighbour(A: AnalysisResult, b: Block, dir: 'prev' | 'next'): Block | null {
  const o = A.blocks[b.id + (dir === 'prev' ? -1 : 1)];
  return o && o.file === b.file && (dir === 'prev' ? o.end === b.start : o.start === b.end) ? o : null;
}

/**
 * Merge the block at `at` with the block before or after it into one block of `at`'s type and settings
 * (text encoding, table kind, number format and row length, music init/play). Null when there is no
 * neighbour in the same file. Code stays split per routine: merging code with data disassembles the data.
 */
export function mergeOverride(A: AnalysisResult, at: Addr, dir: 'prev' | 'next'): BlockMerge | null {
  const block = findBlock(A.blocks, at);
  if (!block) return null;
  const other = neighbour(A, block, dir);
  if (!other) return null;
  const override = overrideLike(block, Math.min(block.start, other.start), Math.max(block.end, other.end));
  return { override, block, other, into: override.type as BlockKind };
}

export interface ByteMove {
  /** append them to `project.overrides` */
  overrides: Override[];
  /** the bytes that move (end excluded), the block they leave and the block they join */
  start: Addr; end: Addr; from: Block; into: Block;
  /** the block whose start moves with them: its comment, build exclusion and binary file go along (`moveBlockKeys`) */
  rekey: { from: Addr; to: Addr } | null;
}

/** Kinds that detection could read differently once a block is shorter: the block the bytes leave keeps its type. */
const KEEP_TYPE: BlockKind[] = ['text', 'table', 'words', 'sprite', 'charset', 'bitmap', 'screen', 'music', 'fill'];

/**
 * Move `start`..`end` (end excluded), bytes at the start (`dir` 'prev') or the end ('next') of one block, into the
 * neighbouring block on that side. The neighbour grows by them and keeps its type and settings; the block they leave
 * keeps its type for the rest. Code stays split per routine, so an instruction cannot move from one code block to
 * another, and the BASIC stub is read from its lines.
 */
export function moveBytes(A: AnalysisResult, start: Addr, end: Addr, dir: 'prev' | 'next'): ByteMove | { error: string } {
  const what = end - start > 1 ? `$${h4(start)}-$${h4(end - 1)}` : `$${h4(start)}`;
  const from = findBlock(A.blocks, start);
  if (!from || !(start < end && end <= from.end)) return { error: `${what} is not inside one block` };
  if (dir === 'prev' ? start !== from.start : end !== from.end) return { error: `${what} is not at the ${dir === 'prev' ? 'start' : 'end'} of its block` };
  const into = neighbour(A, from, dir);
  if (!into) return { error: `there is no ${dir === 'prev' ? 'previous' : 'next'} block in this file` };
  if (from.type === 'basic' || into.type === 'basic') return { error: 'the BASIC stub is read from its lines' };
  if (from.type === 'code' && into.type === 'code') return { error: 'code stays split per routine' };
  const overrides: Override[] = [];
  const rest = dir === 'prev' ? { start: end, end: from.end } : { start: from.start, end: start };
  // a block the user typed keeps its own override for the rest
  if (rest.end > rest.start && !from.user && KEEP_TYPE.includes(from.type)) overrides.push(overrideLike(from, rest.start, rest.end));
  overrides.push(overrideLike(into, Math.min(into.start, start), Math.max(into.end, end)));
  const rekey = dir === 'next' ? { from: into.start, to: start } : rest.end > rest.start ? { from: from.start, to: end } : null;
  return { overrides, start, end, from, into, rekey };
}

/**
 * The move listing line `l` starts when it is dragged out of its block towards `dir`: the whole instruction in code
 * (and a code block's `.byte` line), a `.word`, and otherwise the one byte at that edge of the block. Null when the line
 * does not hold that edge of its block or the bytes cannot move there.
 */
export function lineMove(A: AnalysisResult, l: ListingLine, dir: 'prev' | 'next'): ByteMove | null {
  const n = 'n' in l ? l.n : 0;
  const b = n > 0 ? findBlock(A.blocks, l.a) : null;
  if (!b || (dir === 'prev' ? l.a !== b.start : l.a + n !== b.end)) return null;
  const whole = b.type === 'code' || (l.k === 'dat' && l.dir === '.word');
  const [s, e] = whole ? [l.a, l.a + n] : dir === 'prev' ? [b.start, b.start + 1] : [b.end - 1, b.end];
  const m = moveBytes(A, s, e, dir);
  return 'error' in m ? null : m;
}

/** What is kept by a block's start (its comment, build exclusion and binary file) follows the start to `to`.
 *  Works on an Immer draft too. */
export function moveBlockKeys(p: Pick<Project, 'blockComments' | 'excluded' | 'binary'>, from: Addr, to: Addr): void {
  if (from === to) return;
  if (p.blockComments[from] != null) { p.blockComments[to] = p.blockComments[from]; delete p.blockComments[from]; }
  for (const k of ['excluded', 'binary'] as const) if (p[k].includes(from)) p[k] = [...new Set(p[k].map(a => (a === from ? to : a)))];
}

const TEXT_MARK: Record<string, string> = { petscii: 'text', screen: 'textsc', 'petscii-mixed': 'textmix', 'screen-mixed': 'textscmix' };
const KIND_MARK: Partial<Record<BlockKind, string>> = { code: 'code', data: 'bytes', words: 'words', table: 'table', sprite: 'sprite', charset: 'charset', bitmap: 'bitmap', screen: 'screen', music: 'music', fill: 'fill', lohi: 'bytes', basic: 'bytes' };

/** The "Mark as" id (MARK_AS) that gives a block of this type, text encoding included; detected-only kinds are Bytes. */
export function markIdOf(b: Pick<Block, 'type' | 'props'>): string {
  return b.type === 'text' ? TEXT_MARK[b.props.enc ?? 'petscii'] ?? 'text' : KIND_MARK[b.type] ?? 'bytes';
}

export interface RangeMerge {
  /** append it to `project.overrides` */
  override: Override;
  /** the "Mark as" id and the kind the range becomes */
  id: string; into: BlockKind;
  /** blocks inside the range: they become the one new block */
  replaced: Block[];
  /** blocks the range starts or ends inside: the part outside keeps its type */
  cut: Block[];
}

/**
 * Turn `start`..`end` (end excluded) into one block of type `id` (a MARK_AS id), replacing every block inside it.
 * Settings such as the number format, row length, table kind and music init/play come from `from` when it has the
 * same type (the block the cursor was in). The range must lie in one loaded file. Code stays split per routine.
 */
export function mergeRange(A: AnalysisResult, start: Addr, end: Addr, id: string, from?: Block | null): RangeMerge | { error: string } {
  const m = MARK_AS.find(x => x.id === id);
  if (!m) return { error: `unknown block type "${id}"` };
  if (!(start >= 0 && end <= 0x10000 && start < end)) return { error: 'the end must come after the start' };
  const file = A.owner[start];
  if (file < 0) return { error: `$${h4(start)} is not part of any loaded file` };
  for (let a = start; a < end; a++) if (A.owner[a] !== file) return { error: `$${h4(start)}-$${h4(end - 1)} ${A.owner[a] < 0 ? `runs past the end of the file at $${h4(a)}` : `crosses into another file at $${h4(a)}`}` };
  const into = MARK_TYPE[id];
  const props: OverrideProps = { ...(m.props ?? {}) };
  if (from && markIdOf(from) === id) {
    const p = from.props;
    if (into === 'table' && p.sub) props.sub = p.sub;
    if (into === 'data') { if (p.fmt) props.fmt = p.fmt; if (p.row) props.row = p.row; }
    if (into === 'music') { if (p.init != null) props.init = p.init; if (p.play != null) props.play = p.play; }
  }
  const touched = A.blocks.filter(b => b.start < end && b.end > start);
  return {
    override: { start, end, type: into, ...(Object.keys(props).length ? { props } : {}) },
    id, into,
    replaced: touched.filter(b => b.start >= start && b.end <= end),
    cut: touched.filter(b => b.start < start || b.end > end),
  };
}
