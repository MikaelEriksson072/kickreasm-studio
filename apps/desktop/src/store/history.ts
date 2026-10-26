/* Undo/redo with Immer patches (spec 3): each step stores its forward and inverse patches instead
 * of a full snapshot. Pure functions, so they are unit-tested without React. */
import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';

enablePatches();

export const HISTORY_LIMIT = 100;

export interface HistoryStep { label: string; patches: Patch[]; inverse: Patch[] }
export interface History<T> { present: T; past: HistoryStep[]; future: HistoryStep[] }

export const initHistory = <T,>(present: T): History<T> => ({ present, past: [], future: [] });

/** Apply a recipe; no-op recipes leave the history untouched. */
export function commit<T>(h: History<T>, label: string, recipe: (draft: Draft<T>) => void): History<T> {
  const [next, patches, inverse] = produceWithPatches(h.present, recipe);
  if (!patches.length) return h;
  return { present: next, past: [...h.past.slice(-(HISTORY_LIMIT - 1)), { label, patches, inverse }], future: [] };
}

/** The whole value replaced as one step (a VICE quicksave opened over the project: Ctrl+Z brings the project back). */
export function commitReplace<T>(h: History<T>, label: string, next: T): History<T> {
  const [present, patches, inverse] = produceWithPatches(h.present, () => next as never);
  if (!patches.length) return h;
  return { present: present as T, past: [...h.past.slice(-(HISTORY_LIMIT - 1)), { label, patches, inverse }], future: [] };
}

export function undo<T extends object>(h: History<T>): History<T> {
  const step = h.past[h.past.length - 1];
  if (!step) return h;
  return { present: applyPatches(h.present, step.inverse) as T, past: h.past.slice(0, -1), future: [step, ...h.future] };
}

export function redo<T extends object>(h: History<T>): History<T> {
  const step = h.future[0];
  if (!step) return h;
  return { present: applyPatches(h.present, step.patches) as T, past: [...h.past, step], future: h.future.slice(1) };
}
