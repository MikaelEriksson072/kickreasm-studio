import type { Addr, D64Image, KickProblem, LogLevel, VerifyResult } from '@kickreasm/core';

/** The mounted .d64: its directory is listed in the Explorer, and a copy goes into VICE's drive 8 on Build & Run. */
export interface MountedDisk { name: string; path: string | null; bytes: Uint8Array; img: D64Image }

/** Selection in the listing/heatmap; `multi` = an explicit range (shift-click, drag, block header, Go to range).
 * `anchor`..`anchorEnd` is the line or block picked first; extending the selection always keeps it whole. */
export interface Sel { start: Addr; end: Addr; multi: boolean; anchor?: Addr; anchorEnd?: Addr }
export interface ScrollReq { addr: Addr; center: boolean; n: number }
/** inline edit popover: a label, a line's trailing comment, or a comment line / block (`block`) above a line */
/** `zp`: the label is a zero-page variable; `line`: open the editor under this listing line (a `.label` line in the
 *  file head, which has no address of the label itself) */
export interface Editing { kind: 'label' | 'comment' | 'note'; addr: Addr; value: string; block?: boolean; zp?: boolean; line?: number }
export interface NavOptions { center?: boolean; listing?: boolean; noHistory?: boolean; keepSel?: boolean; fromSource?: boolean }
export type ToastKind = 'info' | 'ok' | 'warn' | 'err';
export interface Toast { id: string; msg: string; kind: ToastKind }

/** One row in the log / problems lists. */
export interface UiProblem {
  lvl: LogLevel; msg: string; addr: Addr | null | undefined; cat: string;
  /** a button on the row that fixes it (turns a setting on, say) */
  action?: { label: string; run: () => void };
}

export interface Command { id: string; label: string; key?: string; run: () => void }
/** `checked`: a setting the item turns on or off (or one choice of several), shown with a check mark */
export type MenuItem = { sep: true } | { label: string; key?: string; checked?: boolean; run: () => void } | { label: string; children: { label: string; key?: string; run: () => void }[] };
/** `owner`: the button that opened it, which closes it again */
export interface ContextMenuState { x: number; y: number; items: MenuItem[]; owner?: string }

export interface KickBuild {
  ok: boolean;
  dir: string;
  problems: KickProblem[];
  /** per source file: bytes compared with the original */
  compared: { entry: string; ok: boolean; same: number; total: number; excluded: number; prgPath: string; vsPath: string | null; prg: Uint8Array | null }[];
}

export interface BuildState {
  ok: boolean;
  log: string;
  /** fingerprint of the generated files this result belongs to */
  key: string;
  at: number;
  V: VerifyResult;
  kick: KickBuild | null;
}
