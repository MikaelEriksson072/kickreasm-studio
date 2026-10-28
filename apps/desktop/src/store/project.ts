/* Project store (Zustand + Immer). The project is the single source of truth; every edit goes
 * through `update(label, recipe)` and becomes one undoable step. */
import { create } from 'zustand';
import type { Draft } from 'immer';
import { DEFAULT_SETTINGS, demoProject, deserializeProject, serializeProject, type Project, type SerializedProject } from '@mimir/core';
import { store } from '../lib/util';
import { commit, commitReplace, initHistory, redo, undo, type History } from './history';

const SAVED_KEY = 'kr.project';

function initialProject(): Project {
  const saved = store.get<SerializedProject | null>(SAVED_KEY, null);
  if (saved) {
    try { return deserializeProject(saved); } catch { /* fall through to the demo */ }
  }
  return demoProject();
}

interface ProjectState extends History<Project> {
  /** where the project was last opened from / saved to */
  path: string | null;
  update: (label: string, recipe: (draft: Draft<Project>) => void) => void;
  /** a new project; with `undoLabel` as an undoable step (Ctrl+Z brings the one before back), else with a new history */
  replace: (project: Project, path?: string | null, undoLabel?: string) => void;
  setPath: (path: string | null) => void;
  undo: () => void;
  redo: () => void;
}

export const useProject = create<ProjectState>((set) => ({
  ...initHistory(initialProject()),
  path: null,
  update: (label, recipe) => set(s => commit(s, label, recipe)),
  replace: (project, path = null, undoLabel) => set(s => {
    const next = { ...project, settings: { ...DEFAULT_SETTINGS, ...project.settings } };
    return undoLabel ? { ...commitReplace(s, undoLabel, next), path } : { ...initHistory(next), path };
  }),
  setPath: path => set({ path }),
  undo: () => set(s => undo(s)),
  redo: () => set(s => redo(s)),
}));

// autosave to the renderer's storage so a restart continues where the user left off
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useProject.subscribe((s, prev) => {
  if (s.present === prev.present) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set(SAVED_KEY, serializeProject(s.present)), 600);
});
