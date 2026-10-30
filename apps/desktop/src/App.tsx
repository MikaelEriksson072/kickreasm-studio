/* =====================================================================
 * Mimir Studio — renderer root. The project lives in the Zustand
 * store; analysis and rendering run in a Web Worker; file system and
 * toolchain access go through the typed `window.kr` bridge.
 * ===================================================================== */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  bankRange, buildScripts, comparePrg, createProject, cyclePath, d64FileName, detectPacking, makePrg, mergeOverride, portName, portText, deserializeProject, exportFiles, findBlock, h2, h4, kindInfo, lineMove, lineText, MARK_AS, MARK_TYPE, moveBlockKeys,
  formatOverride, openC64File, overwritesSystemArea, parseVsf, patchSnapshot, editRanges, showcaseProject, parseD64, parsePrg, projectNameFor, rangeCover, readD64File, readSpindleDisk, spinChunkName, projectTextFiles, shellWord, SYSTEM_AREA, TOOLCHAIN_KEYS, validLabel, withId,
  patchAt, patchEnd, patchesOn, patchFileName, patchPrg, switchPatch, withoutPatch, withPatch,
  type Addr, type AnalysisResult, type Block, type Bookmark, type BuildScript, type ByteMove, type D64File, type NumberFormat, type Override, type PackingInfo, type PackPrefs, type KickProblem, type ListingLine, type LoadedFile, type Patch, type PatchPlan, type Project, type RenderResult,
  type SerializedProject, type Settings, type SpindleChunk, type SpindleDisk, type SpindleJob, type Token, type ToolchainSettings, type VerifyResult,
} from '@mimir/core';
import { useProject } from './store/project';
import { useUi, type Activity } from './store/ui';
import { useAnalysis, verifyInWorker } from './lib/analysis';
import { cx, errorText, filesKey, ROW, uid } from './lib/util';
import { foldLines } from './lib/fold';
import { withIdentified } from './lib/packing';
import { packDefaults, packKeyOf } from './lib/pack';
import { Icon, LVL_ICON } from './lib/icons';
import type { BuildState, Command, ContextMenuState, Editing, KickBuild, MountedDisk, NavOptions, ScrollReq, Sel, Toast, ToastKind, UiProblem } from './lib/types';
import { TitleBar } from './components/TitleBar';
import { ActivityBar } from './components/ActivityBar';
import { StatusBar } from './components/StatusBar';
import { Sidebar } from './components/Sidebar';
import { Listing } from './components/Listing';
import { Inspector } from './components/Inspector';
import { BOTTOM_TABS, BuildPanel, LogList, ProblemsPanel, RasterPanel, SpindlePanel, StatsPanel, XrefPanel } from './components/BottomPanel';
import { SettingsModal } from './components/Settings';
import { CommandPalette, GotoModal } from './components/CommandPalette';
import { MergeRangeModal } from './components/MergeRange';
import { PatchModal, type PatchDraft } from './components/Patch';
import { MemoryGfx } from './components/MemoryGfx';
import { MemoryDump } from './components/MemoryDump';
import { bookmarkList } from './components/Bookmarks';
import type { PackResult } from './components/Pack';
import { ContextMenu } from './components/ContextMenu';
import { Splitter } from './components/Splitter';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useCanvasColors, type HeatMode } from './components/Heatmap';
import type { IdentifyResponse, OpenedPrg, QuicksaveEntry, QuicksaveInfo } from '../shared/ipc';

const SourceView = lazy(() => import('./components/SourceView').then(m => ({ default: m.SourceView })));
const SpecView = lazy(() => import('./components/SpecView').then(m => ({ default: m.SpecView })));

const kr = window.kr;
const pickToolchain = (s: Settings): ToolchainSettings => Object.fromEntries(TOOLCHAIN_KEYS.map(k => [k, s[k]])) as ToolchainSettings;

type Range = { start: Addr; end: Addr };
/** The selection from its anchor (or `from` when there is none yet) to `r`; anchor and target both stay whole. */
function extendSel(s: Sel | null, from: Range | null, r: Range): Sel {
  const a0 = s?.anchor ?? from?.start ?? r.start;
  const a1 = s?.anchor != null ? (s.anchorEnd ?? a0 + 1) : (from?.end ?? a0 + 1);
  return { start: Math.min(a0, r.start), end: Math.max(a1, r.end), multi: true, anchor: a0, anchorEnd: a1 };
}

export function App() {
  const project = useProject(s => s.present);
  const theme = useUi(s => s.theme);
  const dataAsCode = useUi(s => s.dataAsCode);
  const { analysis, error, busy } = useAnalysis(project, { dataAsCode });
  const [toolchain, setToolchain] = useState<ToolchainSettings>(() => pickToolchain(project.settings));
  useEffect(() => { if (kr) kr.getSettings().then(setToolchain).catch(() => { /* keep project defaults */ }); }, []);
  useEffect(() => { const root = document.documentElement; root.dataset.theme = theme; root.dataset.resolved = theme; }, [theme]);

  if (!analysis) return <div className="boot">{error ? `Analysis failed: ${error}` : 'Analysing…'}</div>;
  return <Workspace A={analysis.A} R={analysis.R} aKey={analysis.aKey} renderMs={analysis.renderMs} rProject={analysis.project} busy={busy} toolchain={toolchain} setToolchain={setToolchain} />;
}

interface WorkspaceProps { A: AnalysisResult; R: RenderResult; aKey: number; renderMs: number; /** the project A and R were computed for */ rProject: Project; busy: boolean; toolchain: ToolchainSettings; setToolchain: (t: ToolchainSettings) => void }

function Workspace({ A, R, aKey, renderMs, rProject, busy, toolchain, setToolchain }: WorkspaceProps) {
  const project = useProject(s => s.present);
  const past = useProject(s => s.past), future = useProject(s => s.future), projectPath = useProject(s => s.path);
  const { update, replace, undo, redo, setPath } = useProject.getState();
  /** analysis settings from the project, toolchain paths from the app */
  const S: Settings = useMemo(() => ({ ...A.S, ...toolchain }), [A.S, toolchain]);
  // the newest analysis, project and settings, for work that awaits (verify, build, export) and must not use a stale
  // render: an export right after a settings change runs with the settings of the analysis it waited for
  const latest = useRef({ A, R, aKey, project, rProject, S });
  latest.current = { A, R, aKey, project, rProject, S };
  /** resolves once A and R belong to the latest edit (the store, read directly: an edit made a moment ago may not
   *  have rendered yet, so render-time flags cannot tell); gives up after 15 s */
  const analysisSettled = () => new Promise<void>(resolve => {
    const t0 = Date.now();
    const tick = () => { if (latest.current.rProject === useProject.getState().present || Date.now() - t0 > 15000) resolve(); else setTimeout(tick, 25); };
    tick();
  });
  const ui = useUi();
  const { theme, tab, bottom, activity, panelOpen, welcome, sizes, gutter, dataAsCode, cycles, followQuicksave } = ui;
  const setUi = ui.set;

  const [srcPath, setSrcPath] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Addr | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [scrollReq, setScrollReq] = useState<ScrollReq | null>(null);
  const [heatMode, setHeatMode] = useState<HeatMode>('type');
  const [modal, setModal] = useState<'settings' | 'goto' | 'palette' | 'merge' | 'patch' | null>(null);
  /** the patch dialog's range and code */
  const [patchDraft, setPatchDraft] = useState<PatchDraft | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [build, setBuild] = useState<BuildState | null>(null);
  const [buildBusy, setBuildBusy] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [disk, setDisk] = useState<MountedDisk | null>(null);
  /** the folder of the last Kick Assembler export in this session (the terminal opens there) */
  const [exportDir, setExportDir] = useState<string | null>(null);
  /** the last run of the external unpacker (shown above the listing with its output) */
  const [unpacked, setUnpacked] = useState<{ ok: boolean; title: string; output: string } | null>(null);
  /** the last pack with Exomizer (the Pack view shows it) */
  const [packRes, setPackRes] = useState<PackResult | null>(null);
  // a packed file belongs to the program it was packed from: other files (a new project, an added PRG) drop it
  useEffect(() => setPackRes(null), [project.files]);
  /** files whose "packed" notice was dismissed */
  const [packHidden, setPackHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [drawer, setDrawer] = useState<'side' | 'insp' | null>(null);
  const navHist = useRef<{ back: Addr[]; fwd: Addr[] }>({ back: [], fwd: [] });
  const listRef = useRef<HTMLDivElement | null>(null);
  const colors = useCanvasColors(theme);

  // folded blocks (by start address) show only their header; the view maps addresses to the visible lines
  const [folded, setFolded] = useState<ReadonlySet<Addr>>(() => new Set());
  const view = useMemo(() => foldLines(R.lines, A.blocks, folded), [R, A, folded]);
  const excludedSet = useMemo(() => new Set(project.excluded), [project.excluded]);
  const lineOf = view.lineOf;
  useEffect(() => { if (cursor == null && A.entry != null) { setCursor(A.entry); setScrollReq({ addr: A.entry, center: true, n: Date.now() }); } }, [A]); // eslint-disable-line react-hooks/exhaustive-deps

  const toast = useCallback((msg: string, kind: ToastKind = 'info') => { const id = uid(); setToasts(t => [...t.slice(-3), { id, msg, kind }]); setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200); }, []);
  const needDesktop = () => { toast('This needs the desktop app (file system and toolchain access go through the Electron main process).', 'warn'); };

  const navigate = useCallback((addr: Addr, opts: NavOptions = {}) => {
    if (addr == null || addr < 0 || addr > 0xffff) return;
    if (A.owner[addr] < 0) { toast(`$${h4(addr)} is not part of any loaded file`, 'warn'); return; }
    // going to an address inside a folded block (Go to, a link, the sidebar) unfolds it
    if (opts.center) { const b = findBlock(A.blocks, addr); if (b && addr !== b.start && folded.has(b.start)) setFolded(f => { const n = new Set(f); n.delete(b.start); return n; }); }
    if (cursor != null && cursor !== addr && !opts.noHistory) { navHist.current.back.push(cursor); navHist.current.fwd = []; }
    setCursor(addr);
    if (!opts.keepSel) setSel(null);
    if (!opts.fromSource) setScrollReq({ addr, center: !!opts.center, n: Date.now() });
    if (opts.listing && useUi.getState().tab !== 'listing') setUi({ tab: 'listing' });
  }, [A, cursor, toast, setUi, folded]);
  const goBack = () => { const b = navHist.current.back.pop(); if (b != null && cursor != null) { navHist.current.fwd.push(cursor); navigate(b, { noHistory: true }); } };
  const goFwd = () => { const f = navHist.current.fwd.pop(); if (f != null && cursor != null) { navHist.current.back.push(cursor); navigate(f, { noHistory: true }); } };
  const resetView = () => { setCursor(null); setBuild(null); setSel(null); setFolded(new Set()); navHist.current = { back: [], fwd: [] }; };
  /** fold or unfold the block that starts at (or contains) `a` */
  const toggleFold = (a: Addr) => { const b = findBlock(A.blocks, a); if (!b) return; setFolded(f => { const n = new Set(f); if (n.has(b.start)) n.delete(b.start); else n.add(b.start); return n; }); if (cursor != null && cursor > b.start && cursor < b.end) setCursor(b.start); };
  const foldAll = (which: 'data' | 'all' | 'none') => setFolded(which === 'none' ? new Set() : new Set(A.blocks.filter(b => which === 'all' || b.type !== 'code').map(b => b.start)));

  /* ---- files ---- */
  /** PRGs, and VICE snapshots as their RAM from $0200: the PC and interrupt handlers they hold become entry points */
  /** `undoLabel`: the new project is an undoable step (Ctrl+Z brings the one before back); `note`: the toast instead */
  const addFiles = (opened: OpenedPrg[], add: boolean, opts: { undoLabel?: string; note?: string } = {}) => {
    if (!opened.length) return;
    // a snapshot is kept with its file: Build & Run restarts it as it was
    const files: LoadedFile[] = opened.map(({ id, name, load, bytes, vsf }) => ({ id, name, load, bytes, ...(vsf ? { vsf } : {}) }));
    const entries = [...new Set(opened.flatMap(f => f.entries ?? []))];
    // a snapshot's BASIC SYS is the program start: its RAM from $0200 cannot be started with RUN
    const start = add ? undefined : opened.find(f => f.start != null)?.start;
    if (add) update(`Add ${files.map(f => f.name).join(', ')}`, d => { d.files.push(...files); for (const e of entries) if (!d.entries.includes(e)) d.entries.push(e); });
    else { replace({ ...createProject({ name: projectNameFor(files[0].name), files, settings: project.settings }), entries, entryPoint: start ?? null }, null, opts.undoLabel); resetView(); }
    if (opts.note) { toast(opts.note, 'ok'); return; }
    toast(`Loaded ${opened.map(f => `${f.name} at $${h4(f.load)}${f.snapshot ? ` from a ${f.snapshot}${f.entries?.length ? `; traced from ${f.entries.map(e => `$${h4(e)}`).join(', ')}` : ''}${f.start != null && !add ? `; program start $${h4(f.start)}` : ''}` : ''}`).join(', ')}`, 'ok');
  };
  const openPrgs = async (add: boolean) => {
    if (!kr) return needDesktop();
    try { addFiles(await kr.openPrg({ zeroPage: !!project.settings.snapshotZeroPage }), add); } catch (e) { toast(errorText(e), 'err'); }
  };
  /* ---- VICE's quicksave snapshot: Alt+F11 in VICE writes it, F9 here opens it, and each new one opens by itself ---- */
  const openQuicksave = async () => {
    if (!kr) return needDesktop();
    try {
      const r = await kr.openQuicksave({ zeroPage: !!project.settings.snapshotZeroPage });
      if (!r.found) { toast(`No VICE quicksave yet: in VICE, Snapshot → Quicksave snapshot (Alt+F11) writes ${r.path}`, 'warn'); return; }
      const f = r.files[0], at = new Date(r.saved).toLocaleTimeString();
      const traced = f.entries?.length ? `, traced from ${f.entries.map(e => `$${h4(e)}`).join(', ')}` : '';
      addFiles(r.files, false, { undoLabel: 'Open the VICE quicksave', note: `Opened the VICE quicksave from ${at}: ${f.snapshot ?? f.name}${traced}. Ctrl+Z goes back to the project before` });
    } catch (e) { toast(`VICE quicksave: ${errorText(e)}`, 'err'); }
  };
  /** what the Explorer says about it: the newest quicksave and when it was saved, or where VICE will write one */
  const [qsInfo, setQsInfo] = useState<QuicksaveInfo | null>(null);
  /** the newest quicksaves the app keeps, with the names given them */
  const [qsList, setQsList] = useState<QuicksaveEntry[]>([]);
  const refreshQuicksave = useCallback(() => {
    kr?.quicksaveInfo().then(setQsInfo, () => setQsInfo(null));
    kr?.quicksaves().then(setQsList, () => setQsList([]));
  }, []);
  /** a kept quicksave opened as a new project, like the latest one with F9 */
  const openKeptQuicksave = async (q: QuicksaveEntry) => {
    if (!kr) return needDesktop();
    try {
      const r = await kr.openQuicksaveEntry({ id: q.id, zeroPage: !!project.settings.snapshotZeroPage });
      if (!r.found) return;
      const f = r.files[0];
      const traced = f.entries?.length ? `, traced from ${f.entries.map(e => `$${h4(e)}`).join(', ')}` : '';
      addFiles(r.files, false, { undoLabel: `Open the quicksave "${q.name}"`, note: `Opened the quicksave "${q.name}": ${f.snapshot ?? f.name}${traced}. Ctrl+Z goes back to the project before` });
    } catch (e) { toast(`VICE quicksave: ${errorText(e)}`, 'err'); refreshQuicksave(); }
  };
  const renameKeptQuicksave = async (q: QuicksaveEntry, name: string) => {
    if (!kr || !name.trim() || name.trim() === q.name) return;
    try { setQsList(await kr.renameQuicksave({ id: q.id, name: name.trim() })); } catch (e) { toast(errorText(e), 'err'); }
  };
  const saveKeptQuicksave = async (q: QuicksaveEntry) => {
    if (!kr) return needDesktop();
    try { const r = await kr.saveQuicksave({ id: q.id }); if (r) toast(`The quicksave "${q.name}" saved to ${r.path}`, 'ok'); } catch (e) { toast(`Save failed: ${errorText(e)}`, 'err'); }
  };
  /** a favourite stays when VICE saves new quicksaves; one no more goes like the others */
  const favouriteKeptQuicksave = async (q: QuicksaveEntry, on: boolean) => {
    if (!kr) return;
    try {
      setQsList(await kr.favouriteQuicksave({ id: q.id, on }));
      toast(on ? `"${q.name}" is a favourite: it stays when VICE saves new quicksaves` : `"${q.name}" is no favourite now: it goes when VICE saves a new quicksave, unless it is among the newest 5`, 'ok');
    } catch (e) { toast(errorText(e), 'err'); refreshQuicksave(); }
  };
  useEffect(refreshQuicksave, [refreshQuicksave, toolchain.viceQuicksave]);
  // the main process watches the quicksave file: a new one opens (or is announced) without a click
  const quicksaveRef = useRef(openQuicksave);
  quicksaveRef.current = openQuicksave;
  useEffect(() => kr?.onQuicksave(() => {
    refreshQuicksave();
    if (useUi.getState().followQuicksave) void quicksaveRef.current();
    else toast('VICE saved a new quicksave: F9 opens it', 'info');
  }), [toast, refreshQuicksave]);
  /* ---- the mounted .d64 ---- */
  const mountBytes = (name: string, path: string | null, bytes: Uint8Array) => {
    const img = parseD64(bytes);
    let spindle: SpindleDisk | null = null;
    try { spindle = readSpindleDisk(bytes); } catch { /* not one */ }
    setDisk({ name, path, bytes, img, spindle });
    setUi({ activity: 'explorer' });
    toast(`Mounted ${name}: "${img.name}", ${img.files.length} file${img.files.length === 1 ? '' : 's'}${spindle ? `, a Spindle 3 disk with ${spindle.jobs.length} job${spindle.jobs.length === 1 ? '' : 's'}` : ''}`, 'ok');
  };
  const mountDisk = async () => {
    if (!kr) return needDesktop();
    try { const r = await kr.openDisk(); if (r) mountBytes(r.name, r.path, r.bytes); } catch (e) { toast(errorText(e), 'err'); }
  };
  const ejectDisk = () => { if (disk) toast(`Ejected ${disk.name}`, 'info'); setDisk(null); };
  const openFromDisk = (f: D64File, add: boolean) => {
    if (!disk) return;
    try { addFiles([withId(parsePrg(d64FileName(f), readD64File(disk.bytes, f)))], add); } catch (e) { toast(`"${f.name}": ${errorText(e)}`, 'err'); }
  };
  /** a chunk of a Spindle disk's job, as a PRG at its address */
  const openChunk = (j: SpindleJob, c: SpindleChunk, add: boolean) => {
    try { addFiles([withId(parsePrg(spinChunkName(j, c).replace(/\.bin$/, '.prg'), makePrg(c.start, c.bytes)))], add); } catch (e) { toast(errorText(e), 'err'); }
  };
  /* ---- packed programs ---- */
  // a decruncher in front of compressed data (detectPacking), and what unp64 -i says about each file when unp64 is
  // the unpacker; the external unpacker then turns it into the program
  const unpackerName = toolchain.unpackerPath ? (toolchain.unpackerPath.split(/[\\/]/).pop() ?? 'unp64').replace(/\.exe$/i, '') : 'unp64';
  const [identified, setIdentified] = useState<Record<string, IdentifyResponse>>({});
  const asked = useRef(new Set<string>());
  const idKey = (f: LoadedFile) => `${f.id}:${toolchain.unpackerPath}`;
  useEffect(() => {
    if (!kr || !/^unp64(\.exe)?$/i.test(toolchain.unpackerPath.split(/[\\/]/).pop() ?? '')) return;
    for (const f of project.files) {
      const key = idKey(f);
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      kr.identifyPacker({ name: f.name, prg: makePrg(f.load, f.bytes) }).then(r => setIdentified(m => ({ ...m, [key]: r }))).catch(() => { /* the heuristics still report it */ });
    }
  }, [project.files, toolchain.unpackerPath]); // eslint-disable-line react-hooks/exhaustive-deps
  const packing = useMemo(() => A.files.map((af, i): PackingInfo | null => {
    const f = project.files[i];
    return withIdentified(detectPacking(A, i), f ? identified[idKey(f)] : undefined, { index: i, size: af.bytes.length, entry: A.entry }, unpackerName);
  }), [A, identified, project.files, unpackerName]); // eslint-disable-line react-hooks/exhaustive-deps
  const unpackFile = async (i: number) => {
    if (!kr) return needDesktop();
    const f = project.files[i];
    if (!f) return;
    if (!toolchain.unpackerPath) { toast('No unpacker is set: give the path to unp64 in Settings → Toolchain', 'warn'); setModal('settings'); return; }
    setBuildBusy(`Unpacking with ${unpackerName}`);
    try {
      const r = await kr.unpack({ name: f.name, prg: makePrg(f.load, f.bytes) });
      const output = `> ${r.argv.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n${r.output.trim()}`;
      if (!r.ok || !r.prg) {
        setUnpacked({ ok: false, title: `${unpackerName} could not unpack ${f.name}: ${r.error ?? 'no result'}.`, output });
        toast(`${unpackerName} could not unpack ${f.name}`, 'err');
        return;
      }
      const out = withId(parsePrg(`${f.name.replace(/\.prg$/i, '')}-unpacked.prg`, r.prg));
      const entry = r.entry != null && r.entry >= out.load && r.entry < out.load + out.bytes.length ? r.entry : null;
      if (project.files.length === 1) { replace({ ...createProject({ name: projectNameFor(out.name), files: [out], settings: project.settings }), entryPoint: entry }); resetView(); }
      else update(`Unpack ${f.name}`, d => {
        // a patch written over the packed file has nothing to stand on in the unpacked one
        const was = d.files[i];
        d.files[i] = out;
        d.patches = d.patches.filter(p => !(p.start >= was.load && patchEnd(p) <= was.load + was.bytes.length));
      });
      const at = `$${h4(out.load)}-$${h4(out.load + out.bytes.length - 1)}`;
      setUnpacked({ ok: true, title: `Unpacked ${f.name} with ${unpackerName}${r.packer ? ` (${r.packer})` : ''}: ${out.name}, ${at}${entry != null ? `, starting at $${h4(entry)}${project.files.length === 1 ? ' (set as the program start)' : ''}` : ''}.`, output: `${output}\n\nKept ${r.name} from ${r.dir}` });
      toast(`Unpacked ${f.name}: ${out.bytes.length} bytes at ${at}`, 'ok');
    } catch (e) { toast(errorText(e), 'err'); } finally { setBuildBusy(null); }
  };
  const openProject = async () => {
    if (!kr) return needDesktop();
    try { const r = await kr.openProject(); if (r) { replace(r.project, r.path); resetView(); toast(`Opened project ${r.path}`, 'ok'); } } catch (e) { toast(errorText(e), 'err'); }
  };
  const readDropped = async (list: FileList, add: boolean) => {
    const prgs: OpenedPrg[] = [];
    for (const f of Array.from(list)) {
      const buf = new Uint8Array(await f.arrayBuffer());
      try {
        if (/\.json$/i.test(f.name)) { replace(deserializeProject(JSON.parse(new TextDecoder().decode(buf)) as SerializedProject)); resetView(); toast(`Opened project ${f.name}`, 'ok'); continue; }
        if (/\.d64$/i.test(f.name)) { mountBytes(f.name, null, buf); continue; }
        // a .prg, or a VICE snapshot (known by its header)
        const o = openC64File(f.name, buf, { zeroPage: !!project.settings.snapshotZeroPage });
        prgs.push({ ...withId(o), ...(o.entries ? { entries: o.entries } : {}), ...(o.snapshot ? { snapshot: o.snapshot } : {}), ...(o.start != null ? { start: o.start } : {}) });
      } catch (e) { toast(errorText(e), 'err'); }
    }
    addFiles(prgs, add);
  };
  useEffect(() => {
    const over = (e: DragEvent) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDropping(true); } };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDropping(false); };
    const drop = (e: DragEvent) => { e.preventDefault(); setDropping(false); if (e.dataTransfer?.files.length) void readDropped(e.dataTransfer.files, e.shiftKey); };
    window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  });
  useEffect(() => kr?.onFsChanged(e => toast(`Changed outside the app: ${e.path}`, 'info')), [toast]);

  /* ---- edits ---- */
  const curLine: ListingLine | null = cursor != null && lineOf[cursor] >= 0 ? view.lines[lineOf[cursor]] : null;
  /** the bytes a listing line stands for; a block header stands for its whole block */
  const lineRange = (l: ListingLine): Range | null => {
    if (l.k === 'hdr') { const b = A.blocks[l.blk]; return b ? { start: b.start, end: b.end } : null; }
    if (l.k === 'file' || l.k === 'blank') return null;
    return { start: l.a, end: l.a + Math.max(1, 'n' in l ? l.n : 0) };
  };
  /** Shift+click, Shift+arrows and dragging: extend the selection to line `l` */
  const extendTo = (l: ListingLine): boolean => {
    const r = lineRange(l); if (!r) return false;
    const from = curLine ? lineRange(curLine) : cursor != null ? { start: cursor, end: cursor + 1 } : null;
    setSel(s => extendSel(s, from, r));
    return true;
  };
  const targetRange = () => {
    if (sel && sel.multi && sel.end > sel.start) return sel;
    if (cursor == null) return null;
    const b = findBlock(A.blocks, cursor); if (!b) return null;
    return { start: curLine && curLine.a != null ? curLine.a : cursor, end: b.end };
  };
  const mark = (id: string, range?: { start: Addr; end: Addr }) => {
    const r = range || targetRange(); if (!r) return;
    const m = MARK_AS.find(x => x.id === id);
    // the analysis merges every block (and earlier override) inside the range into the new one; code stays split per routine
    const merged = id === 'code' ? 0 : A.blocks.filter(b => b.start < r.end && b.end > r.start).length;
    update(`Mark $${h4(r.start)}-$${h4(r.end - 1)} as ${m ? m.label : id}`, d => { d.overrides.push({ start: r.start, end: r.end, type: MARK_TYPE[id], ...(m?.props ? { props: { ...m.props } } : {}) }); });
    toast(`$${h4(r.start)}–$${h4(r.end - 1)} marked as ${m ? m.label : id}${merged > 1 ? `, merging ${merged} blocks into one` : ''}`, 'ok');
  };
  /** a data, table or word block's number format and items a row (an override like the block, with them) */
  const setFormat = (b: Block, change: { fmt?: NumberFormat | null; row?: number | null }) => {
    const what = change.fmt !== undefined ? `${change.fmt === 'bin' ? 'binary' : change.fmt === 'dec' ? 'decimal' : change.fmt === 'hex' ? 'hex' : 'addresses'} numbers` : `${change.row ?? 'default'} a row`;
    update(`$${h4(b.start)}-$${h4(b.end - 1)}: ${what}`, d => { d.overrides.push(formatOverride(b, change, d.overrides)); });
  };
  /** the code in `r` runs with this $01 value / VIC bank; null returns it to detection */
  const setBankZone = (r: Range, part: 'port' | 'vicBank', v: number | null) => {
    const what = part === 'port' ? (v == null ? 'the detected $01' : `$01 = ${portName(v)} (${portText(v)})`) : (v == null ? 'the detected VIC bank' : `VIC bank ${v} (${bankRange(v)})`);
    update(`$${h4(r.start)}-$${h4(r.end - 1)} runs with ${what}`, d => { d.bankZones.push({ start: r.start, end: r.end, [part]: v }); });
    toast(`$${h4(r.start)}–$${h4(r.end - 1)} runs with ${what}`, 'ok');
  };
  /** one block of the type of the block at `at` (default: the cursor) and its neighbour before or after it */
  const mergeBlock = (dir: 'prev' | 'next', at?: Addr) => {
    const a = at ?? cursor; if (a == null) return;
    const m = mergeOverride(A, a, dir);
    if (!m) { toast(`There is no ${dir === 'prev' ? 'previous' : 'next'} block in this file to merge with`, 'warn'); return; }
    const o = m.override, what = kindInfo(m.into).label;
    update(`Merge $${h4(o.start)}-$${h4(o.end - 1)} into one ${what} block`, d => { d.overrides.push(o); });
    toast(m.into === 'code' ? `$${h4(o.start)}–$${h4(o.end - 1)} marked as Code (code stays split per routine)` : `$${h4(o.start)}–$${h4(o.end - 1)} merged into one ${what} block`, 'ok');
  };
  /** a line at a block's edge was dragged into the neighbouring block (or the menu said so): its bytes join that block */
  const moveInto = (m: ByteMove) => {
    const what = m.end - m.start > 1 ? `$${h4(m.start)}-$${h4(m.end - 1)}` : `$${h4(m.start)}`, into = kindInfo(m.into.type).label;
    const start = Math.min(m.start, m.into.start), end = Math.max(m.end, m.into.end);
    update(`Move ${what} into the ${into} block`, d => { d.overrides.push(...m.overrides); if (m.rekey) moveBlockKeys(d, m.rekey.from, m.rekey.to); });
    setSel(null);
    navigate(m.start, { noHistory: true });
    toast(`${what.replace('-', '–')} moved into the ${into} block, now $${h4(start)}–$${h4(end - 1)}`, 'ok');
  };
  /** the Merge range dialog was confirmed: one block of the chosen type replaces every block in the range */
  const mergeRangeInto = (o: Override, label: string, replaced: number) => {
    update(`Merge $${h4(o.start)}-$${h4(o.end - 1)} into one ${label} block`, d => { d.overrides.push(o); });
    setModal(null);
    setSel(null);
    navigate(o.start, { center: true });
    toast(`Merged ${replaced} block${replaced === 1 ? '' : 's'} into one ${label} block $${h4(o.start)}–$${h4(o.end - 1)}`, 'ok');
  };
  /** leave the block at `a` out of the build (it stays in the source under #if), or put it back */
  const toggleExcluded = (a: Addr) => {
    const b = findBlock(A.blocks, a); if (!b) return;
    const out = project.excluded.includes(b.start);
    update(`${out ? 'Include' : 'Exclude'} $${h4(b.start)}-$${h4(b.end - 1)} ${out ? 'in' : 'from'} the build`, d => { d.excluded = out ? d.excluded.filter(x => x !== b.start) : [...d.excluded, b.start]; });
    toast(out ? `$${h4(b.start)}–$${h4(b.end - 1)} is built again` : `$${h4(b.start)}–$${h4(b.end - 1)} is left out of the build (still in the source under #if)`, 'ok');
  };
  /** save the block at `a` as a binary file (data/<label>.bin, loaded with .import binary), or write it out again */
  const toggleBinary = (a: Addr) => {
    const b = findBlock(A.blocks, a); if (!b) return;
    const on = project.binary.includes(b.start), name = R.labels.get(b.start)?.name ?? `block_${h4(b.start)}`;
    update(`${on ? 'Write' : 'Save'} $${h4(b.start)}-$${h4(b.end - 1)} ${on ? 'in the source' : 'as a binary file'}`, d => { d.binary = on ? d.binary.filter(x => x !== b.start) : [...d.binary, b.start]; });
    toast(on ? `$${h4(b.start)}–$${h4(b.end - 1)} is written in the source again` : `$${h4(b.start)}–$${h4(b.end - 1)} is saved as data/${name}.bin and loaded with .import binary`, 'ok');
  };
  const clearOverride = (r?: { start: Addr; end: Addr }) => {
    const rr = r || targetRange(); if (!rr) return;
    update('Clear override', d => { d.overrides.push({ start: rr.start, end: rr.end, type: 'auto' }); });
    toast(`$${h4(rr.start)}–$${h4(rr.end - 1)} returned to automatic analysis`, 'ok');
  };
  const rename = (addr: Addr, name: string): boolean => {
    if (name && !validLabel(name)) { setLabelError('Use letters, digits and _ only, start with a letter or _, and avoid mnemonic names.'); toast(`"${name}" is not a valid Kick Assembler label`, 'err'); return false; }
    for (const [a, l] of R.labels) if (a !== addr && l.name === name) { setLabelError(`"${name}" is already used at $${h4(a)}.`); toast(`"${name}" is already used at $${h4(a)}`, 'err'); return false; }
    // zero-page variables share the name space (a pointer's high byte is <name>+1, not a name of its own)
    for (const [a, z] of R.zp) if (a !== addr && !z.off && z.name === name) { setLabelError(`"${name}" is already the zero-page variable at $${h2(a)}.`); toast(`"${name}" is already the zero-page variable at $${h2(a)}`, 'err'); return false; }
    update(name ? `Rename $${h4(addr)} to ${name}` : `Restore label at $${h4(addr)}`, d => { if (name) d.labels[addr] = name; else delete d.labels[addr]; });
    return true;
  };
  const setComment = (addr: Addr, text: string) => update(`Comment at $${h4(addr)}`, d => { if (text) d.comments[addr] = text; else delete d.comments[addr]; });
  const setBlockComment = (addr: Addr, text: string) => { if ((project.blockComments[addr] || '') === text) return; update(`Block comment at $${h4(addr)}`, d => { if (text) d.blockComments[addr] = text; else delete d.blockComments[addr]; }); };
  const setNote = (addr: Addr, text: string, block: boolean) => {
    const old = project.notes[addr];
    if (old ? old.text === text && !!old.block === block : !text) return;
    update(text ? `Comment ${block ? 'block' : 'line'} above $${h4(addr)}` : `Remove comment above $${h4(addr)}`, d => { if (text) d.notes[addr] = block ? { text, block } : { text }; else delete d.notes[addr]; });
  };
  // `at`: the line the context menu was opened on (its closures were made before the cursor moved there)
  const lineAddr = (at?: Addr) => at ?? (curLine && curLine.a != null ? curLine.a : cursor);
  /** the program starts at `a`; null clears it: the analysis uses the detected start (BASIC SYS or the load
   * address) again and Build & Run autostarts the program with RUN */
  const setStart = (a: Addr | null) => {
    if (project.entryPoint === a) return;
    update(a == null ? 'Clear program start' : `Program start $${h4(a)}`, d => { d.entryPoint = a; });
    toast(a == null ? 'Program start cleared: Build & Run starts the program with RUN, and the analysis uses the detected start again' : `The program starts at $${h4(a)}; tracing from there`, 'ok');
    if (a != null) navigate(a, { center: true, listing: true });
  };
  /* ---- bookmarks: a title and a note per address, in the project file only ---- */
  /** the bookmark whose note the Bookmarks list shows, and the address the bookmark editor is open on */
  const [bmSel, setBmSel] = useState<Addr | null>(null);
  const [bmEdit, setBmEdit] = useState<Addr | null>(null);
  const showBookmarks = (a?: Addr) => {
    setUi({ activity: 'bookmarks' });
    if (a !== undefined) setBmSel(a);
    if (window.matchMedia?.('(max-width: 900px)').matches) setDrawer('side');
  };
  /** the bookmark on the line of `a` (the line of a data row or a folded block holds several addresses), else `a` */
  const bookmarkOnLine = (a: Addr): Addr => {
    if (project.bookmarks[a] || lineOf[a] < 0) return a;
    for (const k of Object.keys(project.bookmarks)) if (lineOf[Number(k)] === lineOf[a]) return Number(k);
    return a;
  };
  /** the editor opens in the Bookmarks view, and the listing beside it shows the code at the address */
  const openBookmarkEditor = (a: Addr) => { setBmEdit(a); showBookmarks(); navigate(a, { center: true, listing: true, noHistory: true }); };
  const startBookmark = (at?: Addr) => {
    const a = lineAddr(at);
    if (a == null) { toast('Put the cursor on a line in the listing first', 'warn'); return; }
    openBookmarkEditor(bookmarkOnLine(a));
  };
  const saveBookmark = (from: Addr, to: Addr, b: Bookmark) => {
    const old = project.bookmarks[from];
    setBmEdit(null); setBmSel(to);
    setTimeout(() => listRef.current?.focus(), 0);
    if (old && from === to && old.title === b.title && old.text === b.text) return;
    update(old ? `Bookmark $${h4(to)}` : `Add bookmark $${h4(to)}`, d => { delete d.bookmarks[from]; d.bookmarks[to] = b; });
    toast(old ? `Bookmark $${h4(to)} saved` : `Bookmark added at $${h4(to)}: Ctrl+B shows the list`, 'ok');
  };
  const deleteBookmark = (a: Addr) => {
    if (!project.bookmarks[a]) return;
    update(`Remove bookmark $${h4(a)}`, d => { delete d.bookmarks[a]; });
    if (bmEdit === a) setBmEdit(null);
    toast(`Bookmark $${h4(a)} removed (Ctrl+Z brings it back)`, 'ok');
  };
  const goBookmark = (a: Addr) => {
    if (A.owner[a] < 0) { toast(`$${h4(a)} is not loaded: the file with this bookmark is not in the project`, 'warn'); return; }
    navigate(a, { center: true, listing: true });
    setDrawer(null);
    setTimeout(() => listRef.current?.focus(), 0);
  };
  /** F2 / Shift+F2: the next / previous bookmark after the cursor line, round to the first / last */
  const jumpBookmark = (dir: 1 | -1) => {
    const all = bookmarkList(project.bookmarks).map(([a]) => a).filter(a => A.owner[a] >= 0);
    if (!all.length) { toast('No bookmarks yet: press B on a line to add one', 'info'); return; }
    const c = cursor ?? -1, here = c >= 0 ? lineOf[c] : -1;
    const other = (a: Addr) => here < 0 || lineOf[a] !== here;
    const a = dir > 0 ? (all.find(x => x > c && other(x)) ?? all[0]) : ([...all].reverse().find(x => x < c && other(x)) ?? all[all.length - 1]);
    navigate(a, { center: true, listing: true });
    setBmSel(a);
    toast(`Bookmark $${h4(a)}: ${project.bookmarks[a].title}`, 'info');
  };
  /* ---- patches: new code written over a range of the loaded bytes (spec 10.2) ---- */
  const patchSpan = (p: Patch) => `$${h4(p.start)}–$${h4(patchEnd(p) - 1)}`;
  /** the code of start..end as the listing writes it: its instructions and data, and the labels and comment lines in it */
  const rangeLines = (start: Addr, end: Addr): string[] => {
    const out: string[] = [];
    for (const l of R.lines) {
      if (l.k === 'file' || l.k === 'hdr' || l.a < start || l.a >= end) continue;
      if ((l.k === 'dir' && !l.n) || (l.k === 'cmt' && (l.zp != null || l.mark))) continue;
      out.push(lineText(l, S));
    }
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  };
  const editPatch = (p: Patch) => {
    setPatchDraft({ start: p.start, end: p.end, name: p.name, source: p.source, fill: p.fill, over: p.over, cycles: !!p.cycles, id: p.id });
    setModal('patch');
  };
  /** P: the selection, else the line at the cursor (a range with a patch in it edits that patch) */
  const startPatch = (range?: Range | null) => {
    const r = range ?? (sel && sel.multi && sel.end > sel.start ? { start: sel.start, end: sel.end } : curLine && ('n' in curLine && curLine.n > 0 || curLine.k === 'hdr') ? lineRange(curLine) : null);
    if (!r) { toast('Select the lines to patch, or put the cursor on one', 'info'); return; }
    const hit = project.patches.filter(p => p.start < r.end && patchEnd(p) > r.start);
    if (hit.length === 1) { editPatch(hit[0]); return; }
    if (hit.length > 1) { toast(`The selection holds ${hit.length} patches (${hit.map(p => `"${p.name}"`).join(', ')}): edit them one at a time`, 'warn'); return; }
    if (A.owner[r.start] < 0) { toast(`$${h4(r.start)} is not part of any loaded file`, 'warn'); return; }
    setPatchDraft({ start: r.start, end: r.end, name: `patch_${h4(r.start)}`, source: rangeLines(r.start, r.end).join('\n'), fill: 'nop', over: false, cycles: false });
    setModal('patch');
  };
  const closePatch = () => { setModal(null); setPatchDraft(null); setTimeout(() => listRef.current?.focus(), 0); };
  const savePatchPlan = (plan: PatchPlan) => {
    const p = plan.patch, was = project.patches.some(x => x.id === p.id), w = withPatch(project, p);
    update(`${was ? 'Edit patch' : 'Patch'} "${p.name}" ${patchSpan(p)}`, d => { d.files = w.files; d.patches = w.patches; });
    closePatch();
    toast(p.off ? `Patch "${p.name}" saved; it is switched off (Explorer → Patches switches it on)`
      : `Patch "${p.name}" written over ${patchSpan(p)} (${p.bytes.length} byte${p.bytes.length === 1 ? '' : 's'}): the listing marks it, Ctrl+Z takes it back`, 'ok');
  };
  const removePatch = (p: Patch) => {
    const w = withoutPatch(project, p.id);
    update(`Remove patch "${p.name}"`, d => { d.files = w.files; d.patches = w.patches; });
    toast(`Patch "${p.name}" removed${p.off ? '' : `: ${patchSpan(p)} has its bytes back`}`, 'ok');
  };
  /** off: the bytes it wrote over come back, and it stays in the list; on: it is written again */
  const switchOnePatch = (p: Patch, on: boolean) => {
    const w = switchPatch(project, p.id, on);
    update(`Switch ${on ? 'on' : 'off'} patch "${p.name}"`, d => { d.files = w.files; d.patches = w.patches; });
    toast(on ? `Patch "${p.name}" is on: written over ${patchSpan(p)}` : `Patch "${p.name}" is off: ${patchSpan(p)} has its original bytes`, 'ok');
  };
  const savePatchPrg = async (p: Patch) => {
    if (!kr) return needDesktop();
    try {
      const r = await kr.saveFile({ name: patchFileName(p.name), bytes: patchPrg(p), title: `Save patch "${p.name}" as PRG` });
      if (r) toast(`Patch "${p.name}" saved to ${r.path} (loads at $${h4(p.start)})`, 'ok');
    } catch (e) { toast(`Save failed: ${errorText(e)}`, 'err'); }
  };
  const goPatch = (p: Patch) => { navigate(p.start, { center: true, listing: true }); setSel({ start: p.start, end: patchEnd(p), multi: true, anchor: p.start, anchorEnd: patchEnd(p) }); setTimeout(() => listRef.current?.focus(), 0); };
  /* ---- cycle counting: the branches the user marks as taken (view state, not in the project) ---- */
  const [taken, setTaken] = useState<ReadonlySet<Addr>>(() => new Set());
  const toggleTaken = (pc: Addr) => setTaken(t => { const n = new Set(t); if (n.has(pc)) n.delete(pc); else n.add(pc); return n; });
  const addEntry = (at?: Addr) => { const a = lineAddr(at); if (a == null) return; update(`Entry point $${h4(a)}`, d => { if (!d.entries.includes(a)) d.entries.push(a); }); toast(`Added entry point $${h4(a)}; tracing from there`, 'ok'); };
  /** the label a `.label name = $xxxx` line defines (the zero-page variables and the labels of other files in the file
   *  head, those inside binary blocks); null for any other line and for hardware symbols written inline */
  const labelDefAt = (l: ListingLine | null | undefined): { addr: Addr; zp: boolean } | null => {
    if (!l || l.k !== 'dir' || l.tok[0]?.s !== '.label') return null;
    if (l.zp != null) return { addr: l.zp, zp: true };
    const def = l.tok.find(t => t.t === 'def');
    if (def) for (const [a, x] of R.labels) if (x.name === def.s) return { addr: a, zp: false };
    return null;
  };
  /** the `.label` line clicked last: the cursor is only an address, and the file head's lines all share one */
  const [pickedDef, setPickedDef] = useState<{ addr: Addr; zp: boolean; line: number; at: Addr } | null>(null);
  /** the zero-page variable of a listing line: its `.label` line in the file head, or one of the comment lines above
   *  it; `line` is the `.label` line (where the editors open) */
  const zpDefOf = (l: ListingLine, i: number): { addr: Addr; zp: true; line: number } | null => {
    if ((l.k !== 'dir' && l.k !== 'cmt') || l.zp == null) return null;
    let j = i;
    while (j < view.lines.length) { const x = view.lines[j]; if (x.k === 'dir' && x.zp === l.zp) break; j++; }
    return { addr: l.zp, zp: true, line: j < view.lines.length ? j : i };
  };
  /** the line of the `.label` clicked last while the cursor is still there (the listing marks it): a zero-page
   *  variable's line moves when comment lines go in above it, so it is looked up by its address, nearest the click */
  const pickedLine = useMemo(() => {
    if (!pickedDef || pickedDef.at !== cursor) return null;
    if (!pickedDef.zp) return pickedDef.line;
    let best = -1;
    view.lines.forEach((l, i) => { if (l.k === 'dir' && l.zp === pickedDef.addr && (best < 0 || Math.abs(i - pickedDef.line) < Math.abs(best - pickedDef.line))) best = i; });
    return best >= 0 ? best : null;
  }, [pickedDef, cursor, view]);
  /** the zero-page variable clicked last, while the cursor is still there: `;`, `/`, `*` and N act on it */
  const pickedZp = (at?: Addr) => (at == null && pickedDef?.zp && pickedDef.at === cursor ? { ...pickedDef, line: pickedLine ?? pickedDef.line } : null);
  const startDefRename = (d: { addr: Addr; zp: boolean }, line: number) => {
    setLabelError(null);
    setEditing({ kind: 'label', addr: d.addr, value: (d.zp ? R.zp.get(d.addr)?.name : R.labels.get(d.addr)?.name) ?? '', zp: d.zp, line });
    setUi({ tab: 'listing' });
  };
  const startRename = (at?: Addr) => {
    if (at == null && pickedDef && pickedDef.at === cursor) { startDefRename(pickedDef, pickedLine ?? pickedDef.line); return; }
    const p = lineAddr(at); if (p == null) return; const a = A.codeOwner[p] >= 0 ? A.codeOwner[p] : p; setLabelError(null); setEditing({ kind: 'label', addr: a, value: R.labels.get(a)?.name ?? '' }); setUi({ tab: 'listing' });
  };
  /** `;`: the comment at the end of a line; `z`: of a zero-page variable's `.label` line (Project.comments at its address) */
  const startComment = (at?: Addr, z: { addr: Addr; line: number } | null = pickedZp(at)) => {
    if (z) { setEditing({ kind: 'comment', addr: z.addr, value: project.comments[z.addr] || '', zp: true, line: z.line }); setUi({ tab: 'listing' }); return; }
    const a = lineAddr(at); if (a == null) return; setEditing({ kind: 'comment', addr: a, value: project.comments[a] || '' }); setUi({ tab: 'listing' });
  };
  /** `/` and `*`: write or edit the comment line or block on lines of its own above a line (`z`: above a zero-page
   *  variable's `.label` line) */
  const startNote = (block: boolean, at?: Addr, z: { addr: Addr; line: number } | null = pickedZp(at)) => {
    const a = z ? z.addr : lineAddr(at); if (a == null) return;
    const old = project.notes[a]?.text ?? '';
    setEditing({ kind: 'note', addr: a, value: block ? old : old.replace(/\s*\n\s*/g, ' '), block, ...(z ? { zp: true, line: z.line } : {}) });
    setUi({ tab: 'listing' });
  };
  const commitEdit = (v: string) => {
    if (!editing) return;
    if (editing.kind === 'label') {
      const what = editing.zp ? `Zero-page variable $${h2(editing.addr)}` : null;
      if (rename(editing.addr, v.trim())) { setEditing(null); toast(v.trim() ? `${what ? `${what} renamed` : 'Renamed'} to ${v.trim()}; all references updated` : `${what ?? 'Label'}: automatic name restored`, 'ok'); }
    }
    else if (editing.kind === 'note') { setNote(editing.addr, editing.block ? v.replace(/^(\s*\n)+/, '').trimEnd() : v.trim(), !!editing.block); setEditing(null); }
    else { setComment(editing.addr, v.trim()); setEditing(null); }
    setTimeout(() => listRef.current?.focus(), 0);
  };

  /* ---- verify / build / run / export ---- */
  const extraFiles = useMemo(() => projectTextFiles(project, R, S), [project, R, S]);
  /** build.bat / build.sh edited in the source view; the generated text again (or null) drops the edit */
  const setScript = (path: BuildScript, text: string | null) => {
    const value = text == null || text === buildScripts(S, R.fileNames)[path] ? null : text;
    if ((project.scripts?.[path] ?? null) === value) return;
    update(value == null ? `Restore generated ${path}` : `Edit ${path}`, d => { d.scripts ??= {}; if (value == null) delete d.scripts[path]; else d.scripts[path] = value; });
    if (text == null) toast(`${path} is generated again from the toolchain settings`, 'ok');
  };
  const kickAvailable = !!kr && !!toolchain.kickJar;

  /** Built-in verifier in the worker, then (when configured) the real KickAss.jar in a temp build folder. */
  const runVerify = async (opts: { quiet?: boolean } = {}): Promise<BuildState | null> => {
    try {
      setBuildBusy('Verifying');
      // verify what the listing will show: F7 right after an edit waits for the analysis of that edit, or it would
      // check the previous state and mark the result stale ("round-trip not verified") once the new one arrives
      await analysisSettled();
      const { R, aKey, project: snapshot } = latest.current;
      const key = filesKey(R);
      const V: VerifyResult & { ms: number } = await verifyInWorker(snapshot, aKey);
      const log: string[] = [];
      for (const r of V.results) {
        log.push(`> built-in Kick-subset assembler: ${r.path}`);
        if (r.errors.length) { log.push('Errors:'); for (const e of r.errors.slice(0, 20)) log.push(`  ${e.file}:${e.line}  ${e.msg}`); }
        log.push('Memory map:'); for (const b of r.blocks) log.push(`  $${h4(b.start)}-$${h4(Math.max(b.start, b.end))} ${b.name}`);
        log.push(`${r.ok ? 'Round-trip OK' : 'Round-trip FAILED'}: ${r.same} / ${r.total} bytes identical to ${r.file}${r.excluded ? ` (${r.excluded} bytes left out of the build)` : ''}`);
        for (const d of r.diffs.slice(0, 12)) log.push(d.msg ? `  ${d.msg}` : `  $${h4(d.addr)}: expected $${h2(d.exp ?? 0)}, got ${d.got == null ? 'nothing' : '$' + h2(d.got)}`);
        log.push('');
      }
      log.push(`Built-in verification took ${V.ms.toFixed(0)} ms.`, '');
      let kick: KickBuild | null = null;
      if (kickAvailable && kr) {
        setBuildBusy('Assembling with KickAss.jar');
        const w = await kr.writeExport({ target: 'temp', name: snapshot.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40), files: R.files });
        if (w) {
          const res = await kr.build({ dir: w.dir, entries: R.fileNames.map(n => `${n}.asm`) });
          log.push(res.stdout.trim());
          if (!res.outputs.length) log.push('', `KickAss.jar was not run: ${res.problems.map(p => p.message).join('; ')}`, 'Verified with the built-in assembler only.');
          else {
            const compared = res.outputs.map((o, i) => { const c = comparePrg(snapshot.files[i], o.prg, R.excluded.filter(x => x.file === i)); return { entry: o.entry, ok: o.ok && c.ok, same: c.same, total: c.total, excluded: c.excluded, prgPath: o.prgPath, vsPath: o.vsPath, prg: o.prg, diffs: c.diffs }; });
            kick = { ok: res.ok && compared.every(c => c.ok), dir: w.dir, problems: res.problems, compared };
            log.push('');
            for (const c of compared) {
              log.push(`KickAss.jar round-trip ${c.ok ? 'OK' : 'FAILED'}: ${c.entry} ${c.same} / ${c.total} bytes identical${c.excluded ? `, ${c.excluded} left out of the build` : ''} (${res.ms} ms total)`);
              for (const d of c.diffs.slice(0, 8)) log.push(d.msg ? `  ${d.msg}` : `  $${h4(d.addr)}: expected $${h2(d.exp ?? 0)}, got ${d.got == null ? 'nothing' : '$' + h2(d.got)}`);
            }
            log.push(`Build folder: ${w.dir}`);
          }
        }
      }
      const res: BuildState = { ok: V.ok && (kick ? kick.ok : true), log: log.join('\n'), key, at: Date.now(), V, kick };
      setBuild(res);
      if (!opts.quiet) {
        setUi({ bottom: 'build', panelOpen: true });
        toast(res.ok ? `Round-trip verified${kick ? ' with KickAss.jar' : ''}: output is byte-identical` : 'Round-trip found differences; see Build output', res.ok ? 'ok' : 'err');
      }
      return res;
    } catch (e) {
      toast(`Verification failed: ${errorText(e)}`, 'err');
      return null;
    } finally {
      setBuildBusy(null);
    }
  };

  /** the mounted disk for drive 8, as a copy in a build folder: a program that saves to it leaves the original alone */
  const diskCopy = async (): Promise<string | undefined> => {
    if (!disk || !kr) return undefined;
    const copy = /\.d64$/i.test(disk.name) ? disk.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') : 'disk.d64'; // eslint-disable-line no-control-regex
    const w = await kr.writeExport({ target: 'temp', name: 'disk', files: { [copy]: disk.bytes } });
    return w ? `${w.dir}/${copy}` : undefined;
  };

  const runBuild = async () => {
    if (!kr) return needDesktop();
    const res = await runVerify({ quiet: true });
    setUi({ bottom: 'build', panelOpen: true });
    if (!res) return;
    if (!res.ok) { toast('Build failed verification; VICE was not started', 'err'); return; }
    // the analysis and render that were verified (runVerify waited for the latest edit)
    const { A, R, project } = latest.current;
    try {
      setBuildBusy('Starting VICE');
      const diskPath = await diskCopy();
      const drive = diskPath && disk ? `, ${disk.name} in drive 8 (a copy: ${diskPath})` : '';
      // a project opened from a VICE snapshot: VICE restarts the snapshot as it was taken (CPU, $01, VIC, SID, CIAs,
      // colour RAM, drives) and goes on from its PC, with the programs just built in its RAM; the program start is not used
      const snapAt = project.files.findIndex(f => f.vsf);
      if (snapAt >= 0) {
        const prgs = project.files.map((_, i) => res.kick?.compared[i]?.prg ?? res.V.results[i]?.prg).filter((p): p is Uint8Array => !!p);
        const vsf = patchSnapshot(project.files[snapAt].vsf!, prgs);
        const name = `${R.fileNames[snapAt]}.vsf`;
        const w = await kr.writeExport({ target: 'temp', name: 'run', files: { [name]: vsf } });
        if (!w) return;
        const vsfPath = `${w.dir}/${name}`, labels = res.kick?.compared[snapAt]?.vsPath ?? undefined;
        const s = parseVsf(vsf, name);
        const at = [s.cpu ? `PC $${h4(s.cpu.pc)}` : null, `$01 = $${h2(s.port.data)}`].filter(Boolean).join(', ');
        const { pid } = await kr.run({ prgPath: vsfPath, labelsPath: labels, disk: diskPath });
        setBuild(b => b && { ...b, log: `${b.log}\n\n> VICE started (pid ${pid}): ${vsfPath}${labels ? ` with labels from ${labels}` : ''}, the snapshot restarted as it was taken (${at}), the built program in its RAM${drive}` });
        toast(`VICE restarted the snapshot as it was taken (${at}), with the built program in its RAM${labels ? '; labels in the monitor' : ''}`, 'ok');
        return;
      }
      let prgPath: string, labelsPath: string | undefined;
      if (res.kick?.compared[0]) { prgPath = res.kick.compared[0].prgPath; labelsPath = res.kick.compared[0].vsPath ?? undefined; }
      else {
        // no KickAss.jar: run the PRG produced by the built-in verifier
        const prg = res.V.results[0]?.prg;
        if (!prg) throw new Error('nothing to run');
        const w = await kr.writeExport({ target: 'temp', name: 'run', files: { [`${R.fileNames[0]}.prg`]: prg } });
        if (!w) return;
        prgPath = `${w.dir}/${R.fileNames[0]}.prg`;
      }
      // a program start the user set: VICE loads the PRG without RUN and types `sys <start>`, or, for a program over
      // BASIC's work area, loads and starts it from the monitor (only the first file is run)
      const ep = project.entryPoint;
      const start = ep != null && A.owner[ep] === 0 ? ep : undefined;
      if (ep != null && start == null && A.owner[ep] >= 0) toast(`The program start $${h4(ep)} is in another file than the one VICE runs; it starts with RUN`, 'warn');
      const f0 = A.files[0];
      const overSystem = !!f0 && overwritesSystemArea(f0.load, f0.bytes.length);
      // the RAM of a snapshot opened before snapshots were kept with the project: it can only start like a PRG
      if (f0 && (f0.load === 0x0200 || f0.load === 0x0002) && f0.load + f0.bytes.length === 0x10000) toast('This file looks like a VICE snapshot that was opened before Mimir kept snapshots, so VICE starts it like a PRG: open the .vsf again and Build & Run restarts it as it was', 'warn');
      else if (start == null && overSystem) toast(`The program overwrites BASIC's work area ($${h4(SYSTEM_AREA.start)}-$${h4(SYSTEM_AREA.end - 1)}), so RUN cannot start it: set the program start`, 'warn');
      const { pid, via } = await kr.run({ prgPath, labelsPath, start, disk: diskPath });
      const how = start == null ? '' : via === 'monitor'
        ? `, starting at $${h4(start)} (loaded and started from the VICE monitor: the program overwrites BASIC's work area $${h4(SYSTEM_AREA.start)}-$${h4(SYSTEM_AREA.end - 1)})`
        : `, starting at $${h4(start)} (sys ${start} after loading)`;
      setBuild(b => b && { ...b, log: `${b.log}\n\n> VICE started (pid ${pid}): ${prgPath}${labelsPath ? ` with labels from ${labelsPath}` : ''}${how}${drive}` });
      toast(`VICE started${start != null ? ` at $${h4(start)}` : ''}${labelsPath ? ' with labels in the monitor' : ''}${diskPath && disk ? `, ${disk.name} in drive 8` : ''}`, 'ok');
    } catch (e) {
      toast(errorText(e), 'err');
      setBuild(b => b && { ...b, log: `${b.log}\n\n> VICE: ${errorText(e)}` });
    } finally { setBuildBusy(null); }
  };

  /** a terminal in the folder you work in: the last export, else the saved project's folder (else the main process
   * picks the folder of the last dialog, or home); VICE is on PATH there and `kickass` runs KickAss.jar */
  const openTerminal = async () => {
    if (!kr) return needDesktop();
    const projectDir = projectPath ? projectPath.replace(/[\\/][^\\/]*$/, '').replace(/^([A-Za-z]:)$/, '$1\\') : null;
    const dir = exportDir ?? projectDir;
    try { const r = await kr.openTerminal(dir ? { dir } : {}); toast(`Terminal opened in ${r.dir}`, 'ok'); } catch (e) { toast(errorText(e), 'err'); }
  };

  /* ---- pack with Exomizer (the Pack view) ---- */
  const setPack = (p: PackPrefs, label: string) => update(label, d => { d.pack = p; });
  /** pack the range too (on) or leave it out; the Pack view then shows the chosen blocks */
  const packRange = (r: { start: Addr; end: Addr }, on: boolean) => {
    const prefs = project.pack ?? packDefaults(A, project);
    const what = `$${h4(r.start)}-$${h4(r.end - 1)}`;
    setPack({ ...prefs, ranges: editRanges(prefs.ranges ?? [], r.start, r.end, on) }, `${on ? 'Pack' : 'Do not pack'} ${what}`);
    setUi({ activity: 'pack' });
    toast(on ? `${what} is packed with the chosen blocks (Pack view)` : `${what} is left out of the pack`, 'ok');
  };
  /** Build and verify like Build & Run, then pack the PRGs it built with Exomizer as the Pack view says. */
  const runPack = async () => {
    if (!kr) return needDesktop();
    if (!toolchain.exomizerPath) { toast('Set Exomizer in Settings → Toolchain first', 'warn'); setModal('settings'); return; }
    const res = await runVerify({ quiet: true });
    if (!res) return;
    if (!res.ok) { setUi({ bottom: 'build', panelOpen: true }); toast('The build failed verification; nothing was packed', 'err'); return; }
    // the analysis, render and pack settings that were verified (runVerify waited for the latest edit)
    const { A, R, project } = latest.current;
    const prefs = project.pack ?? packDefaults(A, project);
    const files = R.fileNames.map((n, i) => ({ name: `${n}.prg`, prg: res.kick?.compared[i]?.prg ?? res.V.results[i]?.prg ?? null }));
    if (files.some(f => !f.prg)) { toast('The build gave no PRG to pack', 'err'); return; }
    try {
      setBuildBusy('Packing with Exomizer');
      const r = await kr.pack({ files: files.map(f => ({ name: f.name, prg: f.prg! })), prefs });
      setPackRes({ ...r, key: packKeyOf(prefs, filesKey(R)) });
      const from = res.kick?.compared[0] ? `the PRG KickAss.jar built, ${res.kick.compared[0].prgPath}` : 'the PRG the built-in assembler built';
      const check = r.check ? `\n\n> ${r.check.argv.map(shellWord).join(' ')}\n${r.check.output.trim()}\n${r.check.text}` : '';
      setBuild(b => b && { ...b, log: `${b.log}\n\n> ${r.argv.map(shellWord).join(' ')}\n(in ${r.dir}, from ${from})\n${r.output.trim()}${check}${r.ok ? '' : `\n${r.error}`}` });
      if (!r.ok) { setUi({ bottom: 'build', panelOpen: true }); toast(`Exomizer: ${r.error}`, 'err'); return; }
      const bad = r.check?.status === 'differs';
      toast(`Packed ${r.packed?.length ?? 0} bytes into ${r.name} (${r.prg?.length ?? 0} bytes)${r.check?.status === 'same' ? ', decrunch verified' : bad ? ', but it does not decrunch to the same bytes' : ''}`, bad ? 'err' : 'ok');
    } catch (e) { toast(errorText(e), 'err'); } finally { setBuildBusy(null); }
  };
  /** the packed file in VICE (with the build's labels, which name the decrunched program) */
  const runPacked = async () => {
    if (!kr) return needDesktop();
    if (!packRes?.path) return;
    try {
      const vs = build?.kick?.compared[0]?.vsPath ?? undefined;
      const diskPath = await diskCopy();
      const { pid } = await kr.run({ prgPath: packRes.path, labelsPath: vs, disk: diskPath });
      setBuild(b => b && { ...b, log: `${b.log}\n\n> VICE started (pid ${pid}): ${packRes.path}` });
      toast(`VICE started with ${packRes.name}`, 'ok');
    } catch (e) { toast(errorText(e), 'err'); }
  };
  /** the Graphics tab's selection as a file, through a save dialog */
  const saveGraphics = async (name: string, bytes: Uint8Array) => {
    if (!kr) return needDesktop();
    try { const r = await kr.saveFile({ name, bytes, title: 'Save graphics' }); if (r) toast(`Saved ${r.path} (${bytes.length} bytes)`, 'ok'); } catch (e) { toast(`Save failed: ${errorText(e)}`, 'err'); }
  };
  const savePacked = async () => {
    if (!kr) return needDesktop();
    if (!packRes?.prg || !packRes.name) return;
    try { const r = await kr.saveFile({ name: packRes.name, bytes: packRes.prg, title: 'Save the packed file' }); if (r) toast(`Saved ${r.path}`, 'ok'); } catch (e) { toast(`Save failed: ${errorText(e)}`, 'err'); }
  };

  const exportProject = async () => {
    if (!kr) return needDesktop();
    const res = await runVerify({ quiet: true });
    if (!res) return;
    try {
      // the render that was verified (runVerify waited for the latest analysis)
      const { R: R1, project: p1, S: S1 } = latest.current;
      const w = await kr.writeExport({ target: 'pick', files: exportFiles(p1, R1, S1, res.V, new Date()) });
      if (w) setExportDir(w.dir);
      if (w) toast(res.ok ? `Exported verified Kick Assembler project to ${w.dir} (${w.written.length} files)` : `Exported to ${w.dir}, but the round-trip check failed; see Build output`, res.ok ? 'ok' : 'warn');
    } catch (e) { toast(`Export failed: ${errorText(e)}`, 'err'); }
  };
  const saveProject = async () => {
    if (!kr) return needDesktop();
    try { const r = await kr.saveProject({ project, path: projectPath ?? undefined }); if (r) { setPath(r.path); toast(`Project saved to ${r.path}`, 'ok'); } } catch (e) { toast(`Save failed: ${errorText(e)}`, 'err'); }
  };
  const copyText = async (t: string | undefined, what = 'Copied to clipboard') => { if (!t) return; try { await navigator.clipboard.writeText(t); toast(what, 'ok'); } catch { toast('The clipboard is not available; select the text and copy it manually', 'warn'); } };
  /**
   * The lines of the selection as the source writes them, in order: its instructions and data, the labels and
   * comment lines inside it, and the header of a block it holds whole. A folded block in it comes along whole.
   */
  const selectedLines = (): string[] => {
    if (!sel || !sel.multi || sel.end <= sel.start) return [];
    const inside = (a: Addr) => a >= sel.start && a < sel.end;
    const out: string[] = [];
    for (const l of R.lines) {
      if (l.k === 'file' || !inside(l.a)) continue;
      if (l.k === 'hdr') { const b = A.blocks[l.blk]; if (!b || b.start < sel.start || b.end > sel.end) continue; }
      // the file head's lines (a .label and the note on it) stand at the load address, not in the program
      else if ((l.k === 'dir' && !l.n) || (l.k === 'cmt' && l.zp != null)) continue;
      out.push(lineText(l, S));
    }
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  };
  /** Ctrl+C in the listing: the selected lines, else the line at the cursor */
  const copyLines = () => {
    const ls = selectedLines();
    if (ls.length) return void copyText(ls.join('\n'), `Copied ${ls.length} line${ls.length === 1 ? '' : 's'} to the clipboard`);
    if (curLine) void copyText(lineText(curLine, S).trim());
  };
  /** the showcase (core/showcase.ts) with its tour in the Bookmarks view. It needs bank tracking: its bitmap logo sits
   *  above a text screen, and only that tells the two $d018 values apart */
  const loadDemo = () => {
    replace(showcaseProject({ ...project.settings, bankTracking: true }));
    resetView();
    setUi({ activity: 'bookmarks' });
    toast('Showcase loaded: the Bookmarks view is a tour of it, F2 goes to the next stop', 'ok');
  };
  const saveSettings = async (s: Settings) => {
    const tc = pickToolchain(s);
    try { setToolchain(kr ? await kr.setSettings(tc) : tc); } catch (e) { toast(`Toolchain settings rejected: ${errorText(e)}`, 'err'); return; }
    update('Settings', d => { for (const k of Object.keys(s) as (keyof Settings)[]) if (!(TOOLCHAIN_KEYS as readonly string[]).includes(k)) (d.settings as Record<string, unknown>)[k] = s[k]; });
    setModal(null); toast('Settings saved', 'ok');
  };

  /* ---- commands & keys ---- */
  const undoLabel = past.length ? past[past.length - 1].label : null;
  const commands: Command[] = [
    { id: 'open', label: 'Open PRG files…', key: 'Ctrl+O', run: () => void openPrgs(false) },
    { id: 'add', label: 'Add PRG to project…', run: () => void openPrgs(true) },
    { id: 'mount', label: 'Mount D64 disk image…', run: () => void mountDisk() },
    { id: 'quicksave', label: 'Open the VICE quicksave snapshot (Alt+F11 in VICE saves one)', key: 'F9', run: () => void openQuicksave() },
    { id: 'quicksave-follow', label: followQuicksave ? 'Stop opening each new VICE quicksave' : 'Open each new VICE quicksave (Alt+F11 in VICE) by itself', run: () => setUi({ followQuicksave: !followQuicksave }) },
    ...packing.flatMap((p, i) => (p ? [{ id: `unpack-${i}`, label: `Unpack ${project.files[i]?.name} with ${unpackerName}`, run: () => void unpackFile(i) }] : [])),
    { id: 'terminal', label: 'Open a terminal in the project folder (VICE on PATH, kickass runs Kick Assembler)', run: () => void openTerminal() },
    ...(disk ? [{ id: 'eject', label: `Eject ${disk.name}`, run: ejectDisk }] : []),
    { id: 'demo', label: 'Load the showcase demo (every block type, with a guided tour)', run: loadDemo },
    { id: 'goto', label: 'Go to address, label or range…', key: 'G', run: () => setModal('goto') },
    { id: 'select-range', label: 'Select address range… (e.g. $2000-$27ff)', run: () => setModal('goto') },
    { id: 'back', label: 'Navigate back', key: 'Esc', run: goBack },
    { id: 'rename', label: 'Rename label at cursor', key: 'N', run: startRename },
    { id: 'comment', label: 'Comment at the end of the cursor line', key: ';', run: () => startComment() },
    { id: 'note-line', label: 'Insert comment line above the cursor line (//)', key: '/', run: () => startNote(false) },
    { id: 'note-block', label: 'Insert comment block above the cursor line (/* */)', key: '*', run: () => startNote(true) },
    { id: 'bookmark', label: 'Add or edit the bookmark on the cursor line…', key: 'B', run: () => startBookmark() },
    { id: 'bookmarks', label: 'Show bookmarks (notes on addresses)', key: 'Ctrl+B', run: () => showBookmarks() },
    { id: 'bookmark-next', label: 'Go to the next bookmark', key: 'F2', run: () => jumpBookmark(1) },
    { id: 'bookmark-prev', label: 'Go to the previous bookmark', key: 'Shift+F2', run: () => jumpBookmark(-1) },
    ...MARK_AS.map(m => ({ id: 'mark-' + m.id, label: `Mark as ${m.label}`, key: m.key, run: () => mark(m.id) })),
    { id: 'auto', label: 'Clear override (automatic)', key: 'U', run: () => clearOverride() },
    { id: 'fold', label: 'Fold / unfold the block at the cursor', key: 'F', run: () => { if (cursor != null) toggleFold(cursor); } },
    { id: 'fold-data', label: 'Fold every block that is not code', run: () => foldAll('data') },
    { id: 'fold-all', label: 'Fold all blocks', run: () => foldAll('all') },
    { id: 'unfold-all', label: 'Unfold all blocks', run: () => foldAll('none') },
    { id: 'exclude', label: 'Exclude / include the block at the cursor in the build', run: () => { if (cursor != null) toggleExcluded(cursor); } },
    { id: 'binary', label: 'Save the block at the cursor as a binary file (.import binary) / write it in the source', run: () => { if (cursor != null) toggleBinary(cursor); } },
    { id: 'merge-prev', label: 'Merge the block at the cursor with the previous block', run: () => mergeBlock('prev') },
    { id: 'merge-next', label: 'Merge the block at the cursor with the next block', run: () => mergeBlock('next') },
    { id: 'merge-range', label: 'Merge range into one block… (start, end, block type)', key: 'M', run: () => setModal('merge') },
    { id: 'patch', label: 'Patch the selection (or the cursor line) with new code… (a patch on it: edit it)', key: 'P', run: () => startPatch() },
    ...project.patches.flatMap(p => [
      { id: `patch-switch-${p.id}`, label: `Switch ${p.off ? 'on' : 'off'} patch "${p.name}" (${patchSpan(p)})`, run: () => switchOnePatch(p, !!p.off) },
      { id: `patch-save-${p.id}`, label: `Save patch "${p.name}" (${patchSpan(p)}) as PRG…`, run: () => void savePatchPrg(p) },
    ]),
    { id: 'entry', label: 'Add entry point at cursor', key: 'E', run: addEntry },
    { id: 'start', label: 'Set the program start to the cursor line', run: () => { const a = lineAddr(); if (a != null) setStart(a); } },
    ...(project.entryPoint != null ? [{ id: 'start-clear', label: `Clear the program start $${h4(project.entryPoint)} (Build & Run starts the program with RUN)`, run: () => setStart(null) }] : []),
    { id: 'xrefs', label: 'Show cross-references', key: 'X', run: () => setUi({ bottom: 'xrefs', panelOpen: true }) },
    { id: 'copy-lines', label: 'Copy the selected lines (or the line at the cursor) as source', key: 'Ctrl+C', run: copyLines },
    { id: 'panel', label: 'Toggle bottom panel', key: 'Ctrl+J', run: () => setUi({ panelOpen: !useUi.getState().panelOpen }) },
    { id: 'verify', label: 'Verify round-trip (re-assemble and compare)', key: 'F7', run: () => void runVerify() },
    { id: 'build', label: 'Build with KickAss.jar & run in VICE', key: 'F5', run: () => void runBuild() },
    { id: 'pack', label: 'Pack with Exomizer (build, verify, pack as the Pack view says)', run: () => void runPack() },
    { id: 'pack-view', label: 'Show the Pack view (Exomizer)', run: () => setUi({ activity: 'pack' }) },
    ...(packRes?.ok && packRes.path ? [
      ...(packRes.argv[1] === 'sfx' ? [{ id: 'pack-run', label: `Run the packed ${packRes.name} in VICE`, run: () => void runPacked() }] : []),
      { id: 'pack-save', label: `Save the packed ${packRes.name} as…`, run: () => void savePacked() },
    ] : []),
    { id: 'export', label: 'Export Kick Assembler project to a folder…', key: 'Ctrl+E', run: () => void exportProject() },
    { id: 'save', label: 'Save project (.mimir.json)', key: 'Ctrl+S', run: () => void saveProject() },
    { id: 'openproj', label: 'Open project (.mimir.json)…', run: () => void openProject() },
    { id: 'settings', label: 'Settings', key: 'Ctrl+,', run: () => setModal('settings') },
    { id: 'theme', label: 'Toggle light / dark theme', run: () => setUi({ theme: theme === 'dark' ? 'light' : 'dark' }) },
    { id: 'undo', label: `Undo${undoLabel ? ': ' + undoLabel : ''}`, key: 'Ctrl+Z', run: undo },
    { id: 'redo', label: 'Redo', key: 'Ctrl+Y', run: redo },
    { id: 'tab-listing', label: 'Show listing', run: () => setUi({ tab: 'listing' }) },
    { id: 'cycles', label: cycles ? 'Listing: hide cycle counts' : 'Listing: show cycle counts (6510 cycles per instruction; select a range or block to count it)', run: () => setUi({ cycles: !cycles, tab: 'listing' }) },
    { id: 'data-as-code', label: dataAsCode ? 'Listing: show data as classified' : 'Listing: show data as code (find code that is marked as data)', run: () => setUi({ dataAsCode: !dataAsCode, tab: 'listing' }) },
    { id: 'gutter', label: gutter === 'line' ? 'Listing: show memory addresses' : 'Listing: show line numbers (as in the .asm file)', run: () => setUi({ gutter: gutter === 'line' ? 'addr' : 'line' }) },
    { id: 'tab-source', label: 'Show generated Kick Assembler source', run: () => setUi({ tab: 'source' }) },
    { id: 'tab-gfx', label: 'Show memory as graphics (characters, sprites, bitmaps) to find and mark graphics', run: () => setUi({ tab: 'gfx' }) },
    { id: 'tab-mem', label: 'Show memory as the VICE monitor does (m: hex and text, i: PETSCII, ii: screen codes)', run: () => setUi({ tab: 'mem' }) },
    { id: 'tab-spec', label: 'Open the technical specification', run: () => setUi({ tab: 'spec' }) },
  ];
  const keyRef = useRef({ commands, cursor, curLine, lineOf, R, lines: view.lines, folded, tab, sel, editing, modal, extendTo });
  keyRef.current = { commands, cursor, curLine, lineOf, R, lines: view.lines, folded, tab, sel, editing, modal, extendTo };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keyRef.current;
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest?.('input, textarea, select, .monaco-editor');
      const ctrl = e.ctrlKey || e.metaKey;
      const run = (id: string) => { const c = k.commands.find(x => x.id === id); if (c) { e.preventDefault(); c.run(); } };
      if (ctrl && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); setModal('palette'); return; }
      if (e.key === 'F1') { e.preventDefault(); setModal('palette'); return; }
      if (ctrl && !typing) {
        const map: Record<string, string> = { z: e.shiftKey ? 'redo' : 'undo', y: 'redo', o: 'open', s: 'save', e: 'export', g: 'goto', ',': 'settings', j: 'panel', b: 'bookmarks' };
        const id = map[e.key.toLowerCase()]; if (id) return run(id);
      }
      if (ctrl && (e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'o')) return run(e.key.toLowerCase() === 's' ? 'save' : 'open');
      // Ctrl+C in the listing copies its lines; text selected with the mouse elsewhere is copied as usual
      if (ctrl && !e.shiftKey && !typing && !k.modal && !k.editing && e.key.toLowerCase() === 'c' && k.tab === 'listing' && (t?.closest?.('.listing') || !window.getSelection()?.toString())) return run('copy-lines');
      if (e.key === 'F5') return run('build');
      if (e.key === 'F9') return run('quicksave');
      if (e.key === 'F7') return run('verify');
      if (typing || k.editing || k.modal || ctrl || (e.altKey && !['ArrowLeft', 'ArrowRight'].includes(e.key))) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goFwd(); return; }
      if (e.key === 'F2') return run(e.shiftKey ? 'bookmark-prev' : 'bookmark-next');
      if (k.tab !== 'listing') return;
      const lines = k.lines;
      // the cursor stops on lines with bytes, and on the header of a folded block
      const stop = (l: ListingLine) => ('n' in l && l.n > 0) || (l.k === 'hdr' && k.folded.has(l.a));
      const moveTo = (i0: number, dirn: number, extend?: boolean) => {
        let i = i0; while (i >= 0 && i < lines.length && !stop(lines[i])) i += dirn;
        if (i < 0 || i >= lines.length) return;
        const l = lines[i];
        if (extend) {
          k.extendTo(l);
          navigate(l.a, { keepSel: true, noHistory: true });
        } else navigate(l.a, { noHistory: true });
      };
      const ci = k.cursor != null ? k.lineOf[k.cursor] : 0;
      const page = Math.max(5, Math.floor((listRef.current?.clientHeight || 400) / ROW) - 3);
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); moveTo(ci + 1, 1, e.shiftKey); return;
        case 'ArrowUp': e.preventDefault(); moveTo(ci - 1, -1, e.shiftKey); return;
        case 'PageDown': e.preventDefault(); moveTo(Math.min(lines.length - 1, ci + page), 1, e.shiftKey); return;
        case 'PageUp': e.preventDefault(); moveTo(Math.max(0, ci - page), -1, e.shiftKey); return;
        case 'Home': e.preventDefault(); moveTo(0, 1, e.shiftKey); return;
        case 'End': e.preventDefault(); moveTo(lines.length - 1, -1, e.shiftKey); return;
        case 'Enter': { const l = k.curLine; const tk = l && 'tok' in l ? l.tok.find(x => x.to != null && (x.t === 'lbl' || x.t === 'kw')) : undefined; if (tk) { e.preventDefault(); navigate(tk.to!); } return; }
        case 'Escape': case 'Backspace': e.preventDefault(); goBack(); return;
        default: break;
      }
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const single: Record<string, string> = { B: 'bookmark', F: 'fold', G: 'goto', M: 'merge-range', P: 'patch', N: 'rename', ';': 'comment', '/': 'note-line', '*': 'note-block', U: 'auto', E: 'entry', X: 'xrefs', C: 'mark-code', D: 'mark-bytes', W: 'mark-words', T: 'mark-text' };
      if (single[key]) run(single[key]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  const onClickLine = (l: ListingLine, i: number, e: ReactMouseEvent, dbl?: boolean) => {
    // Shift+click extends the selection; on a block header it takes in the whole block
    if (e.shiftKey && cursor != null) { if (extendTo(l)) setCursor(l.a); return; }
    const def = labelDefAt(l), zl = zpDefOf(l, i);
    setPickedDef(def ? { ...def, line: zl?.line ?? i, at: l.a } : zl ? { ...zl, at: l.a } : null);
    // a comment line of a zero-page variable opens its editor
    if (zl && dbl && l.k === 'cmt') { navigate(l.a, { noHistory: true }); startNote(!!project.notes[zl.addr]?.block, undefined, zl); return; }
    if (def && dbl) { navigate(l.a, { noHistory: true }); startDefRename(def, i); return; }
    if (l.k === 'hdr') { navigate(l.a, { noHistory: true }); const b = A.blocks[l.blk]; if (b) setSel({ start: b.start, end: b.end, multi: true, anchor: b.start, anchorEnd: b.end }); return; }
    if (l.a == null) return;
    const n = 'n' in l ? l.n : 0;
    navigate(l.a, { noHistory: true });
    if (n > 0) setSel({ start: l.a, end: l.a + n, multi: false, anchor: l.a, anchorEnd: l.a + n });
    if (dbl) {
      if (l.k === 'cmt' && l.note) startNote(!!project.notes[l.a]?.block, l.a);
      else if (l.k === 'lbl' || l.k === 'ins') { setLabelError(null); setEditing({ kind: 'label', addr: l.a, value: R.labels.get(l.a)?.name ?? '' }); }
      else startComment(l.a);
    }
    listRef.current?.focus();
  };
  const onToken = (t: Token) => { if (t.to != null && A.owner[t.to] >= 0) navigate(t.to, { center: true }); else if (t.sym) toast(`${t.sym.name}: ${t.sym.desc}`, 'info'); };
  const onContext = (e: ReactMouseEvent, l: ListingLine) => {
    e.preventDefault();
    const inSel = !!(sel && sel.multi && l.a >= sel.start && l.a < sel.end);
    if (l.a != null && !inSel) navigate(l.a, { noHistory: true });
    // the items act on this line (or the selection around it): the cursor only moves here after this render
    const b = findBlock(A.blocks, l.a), zl = zpDefOf(l, view.lines.indexOf(l));
    if (zl) setPickedDef({ ...zl, at: l.a });
    const range = inSel && sel ? { start: sel.start, end: sel.end } : b ? { start: l.a, end: b.end } : null;
    setMenu({
      x: e.clientX, y: e.clientY, items: [
        (() => { const def = labelDefAt(l) ?? (zl ? { addr: zl.addr, zp: true } : null); return def
          ? { label: def.zp ? 'Rename zero-page variable…' : 'Rename label…', key: 'N', run: () => startDefRename(def, zl?.line ?? view.lines.indexOf(l)) }
          : { label: 'Rename label…', key: 'N', run: () => startRename(l.a) }; })(),
        // on a zero-page variable's .label line (or its comment lines) these comment the variable
        { label: zl ? 'Comment at the end of the .label line…' : 'Comment at the end of the line…', key: ';', run: () => (zl ? startComment(undefined, zl) : startComment(l.a)) },
        { label: zl ? 'Insert comment line above the .label line…' : 'Insert comment line above…', key: '/', run: () => (zl ? startNote(false, undefined, zl) : startNote(false, l.a)) },
        { label: zl ? 'Insert comment block above the .label line…' : 'Insert comment block above…', key: '*', run: () => (zl ? startNote(true, undefined, zl) : startNote(true, l.a)) },
        ...(() => { const at = l.a != null ? bookmarkOnLine(l.a) : null, has = at != null && !!project.bookmarks[at]; return [
          { label: has ? 'Edit bookmark…' : 'Add bookmark…', key: 'B', run: () => startBookmark(l.a) },
          ...(has ? [{ label: 'Remove bookmark', run: () => deleteBookmark(at!) }] : []),
        ]; })(),
        { sep: true },
        ...(() => {
          // a patched line: its patch; otherwise new code over the selection, the line or the block of a header
          const p = l.a != null ? patchAt(project.patches, l.a) : undefined;
          if (p) return [
            { label: `Edit patch "${p.name}"…`, key: 'P', run: () => editPatch(p) },
            { label: p.off ? `Switch patch "${p.name}" on` : `Switch patch "${p.name}" off (the original bytes come back)`, run: () => switchOnePatch(p, !!p.off) },
            { label: `Save patch "${p.name}" as PRG…`, run: () => void savePatchPrg(p) },
            { label: `Remove patch "${p.name}"${p.off ? '' : ' (the original bytes come back)'}`, run: () => removePatch(p) },
          ];
          const r = inSel && sel ? { start: sel.start, end: sel.end } : ('n' in l && l.n > 0) || l.k === 'hdr' ? lineRange(l) : null;
          return r ? [{ label: inSel ? 'Patch selection with new code…' : l.k === 'hdr' ? 'Patch block with new code…' : 'Patch line with new code…', key: 'P', run: () => startPatch(r) }] : [];
        })(),
        { label: inSel ? 'Mark selection as' : 'Mark from here as', children: MARK_AS.map(m => ({ label: m.label, key: m.key, run: () => { if (range) mark(m.id, range); } })) },
        { label: 'Clear override', key: 'U', run: () => { if (range) clearOverride(range); } },
        ...([['prev', 'previous'], ['next', 'next']] as const).flatMap(([dir, word]) => { const m = mergeOverride(A, l.a, dir); return m ? [{ label: `Merge with ${word} block (${kindInfo(m.other.type).label}) → ${kindInfo(m.into).label}`, run: () => mergeBlock(dir, l.a) }] : []; }),
        // a line at a block's edge: the same as dragging it into the neighbouring block
        ...([['prev', 'previous'], ['next', 'next']] as const).flatMap(([dir, word]) => { const m = lineMove(A, l, dir); return m ? [{ label: `Move $${h4(m.start)}${m.end - m.start > 1 ? `-$${h4(m.end - 1)}` : ''} into the ${word} block (${kindInfo(m.into.type).label})`, run: () => moveInto(m) }] : []; }),
        { label: 'Merge range into one block…', key: 'M', run: () => { if (!inSel) setCursor(l.a); setModal('merge'); } },
        { label: 'Add entry point here', key: 'E', run: () => addEntry(l.a) },
        { label: folded.has(findBlock(A.blocks, l.a)?.start ?? -1) ? 'Unfold block' : 'Fold block', key: 'F', run: () => toggleFold(l.a) },
        { label: project.excluded.includes(findBlock(A.blocks, l.a)?.start ?? -1) ? 'Include block in the build' : 'Exclude block from the build', run: () => toggleExcluded(l.a) },
        { label: project.binary.includes(findBlock(A.blocks, l.a)?.start ?? -1) ? 'Write block in the source again' : 'Save block as a binary file (.import binary)', run: () => toggleBinary(l.a) },
        ...(() => {
          // Exomizer: the selection, else the whole block
          const r = inSel && sel ? { start: sel.start, end: sel.end } : b ? { start: b.start, end: b.end } : null;
          if (!r) return [];
          const cover = project.pack?.ranges ? rangeCover(project.pack.ranges, r.start, r.end) : 0, what = inSel ? 'selection' : 'block';
          return [
            ...(cover < r.end - r.start ? [{ label: `Pack ${what} with Exomizer`, run: () => packRange(r, true) }] : []),
            ...(cover > 0 ? [{ label: `Leave ${what} out of the pack`, run: () => packRange(r, false) }] : []),
          ];
        })(),
        { label: 'Set as program start', run: () => setStart(l.a) },
        ...(project.entryPoint != null ? [{ label: `Clear program start ($${h4(project.entryPoint)})`, run: () => setStart(null) }] : []),
        ...(A.mcfg ? [
          { label: 'Memory configuration ($01)', children: [...[7, 6, 5, 4, 3, 2, 1, 0].map(c => ({ label: `${portName(c)} · ${portText(c)}`, run: () => { if (range) setBankZone(range, 'port', 0x30 + c); } })), { label: 'Detected (automatic)', run: () => { if (range) setBankZone(range, 'port', null); } }] },
          { label: 'VIC bank', children: [...[0, 1, 2, 3].map(b => ({ label: `Bank ${b} · ${bankRange(b)}`, run: () => { if (range) setBankZone(range, 'vicBank', b); } })), { label: 'Detected (automatic)', run: () => { if (range) setBankZone(range, 'vicBank', null); } }] },
        ] : []),
        { sep: true },
        { label: 'Show cross-references', key: 'X', run: () => setUi({ bottom: 'xrefs', panelOpen: true }) },
        { label: 'Copy address', run: () => void copyText('$' + h4(l.a ?? cursor ?? 0)) },
        ...(() => {
          // in the selection: all its lines; the line itself as well
          const n = inSel ? selectedLines().length : 0;
          return n > 1 ? [{ label: `Copy ${n} selected lines`, key: 'Ctrl+C', run: copyLines }] : [];
        })(),
        { label: 'Copy line', run: () => void copyText(lineText(l, S).trim()) },
      ],
    });
  };

  const rKey = useMemo(() => filesKey(R), [R]);
  const stale = !!build && build.key !== rKey;
  const packPrefs = useMemo(() => project.pack ?? packDefaults(A, project), [project.pack, project.entryPoint, A]); // eslint-disable-line react-hooks/exhaustive-deps
  const packKey = packKeyOf(packPrefs, rKey);
  const kickProblems: KickProblem[] = !stale && build?.kick ? build.kick.problems : [];
  const problems: UiProblem[] = useMemo(() => [
    ...kickProblems.map(p => ({ lvl: p.severity === 'error' ? 'err' as const : 'warn' as const, msg: `${p.file ? `${p.file}:${p.line}:${p.column} ` : ''}${p.message}`, addr: p.file ? (R.fileLines[p.file]?.[p.line - 1]?.a ?? null) : null, cat: 'kickass' })),
    ...R.problems.map(p => ({ ...p, cat: 'render' })),
    // without bank tracking I/O inside the loaded bytes is written as labels: the row turns it on
    ...A.log.filter(l => l.lvl === 'warn' || l.lvl === 'err' || l.lvl === 'hint').map(l => (l.cat === 'banks' ? { ...l, action: { label: 'Turn on', run: () => {
      update('Follow the memory configuration ($01) and VIC bank', d => { d.settings.bankTracking = true; });
      toast('Following the memory configuration ($01) and VIC bank: I/O accesses are written as registers', 'ok');
    } } } : l)),
    ...packing.flatMap((p, i) => (p ? [{ lvl: 'warn' as const, msg: `${A.files[i].name} ${p.verdict === 'packed' ? 'is packed' : 'may be packed'}${p.signature ? ` (${p.signature})` : ''}: ${p.reasons.join('; ')}. Unpack it (Unpack with ${unpackerName}) to see the program.`, addr: p.decruncher, cat: 'packing' }] : [])),
  ], [A, R, kickProblems, packing, unpackerName]);
  // the Spindle script tab is there when the analysis found Spindle's drivers
  const bottomTabs = BOTTOM_TABS.filter(([k]) => k !== 'spindle' || A.spindle.length > 0 || !!disk?.spindle);
  const shownBottom = bottomTabs.some(([k]) => k === bottom) ? bottom : 'log';
  const blk = cursor != null ? findBlock(A.blocks, cursor) : null;
  // cycle counting: the selection, else the code block at the cursor, along the path with the branches marked taken
  const cycleRange = !cycles ? null : sel && sel.multi ? { start: sel.start, end: sel.end } : blk && blk.type === 'code' ? { start: blk.start, end: blk.end } : null;
  const path = useMemo(() => (cycleRange ? cyclePath(A, cycleRange.start, cycleRange.end, taken) : null), [A, cycleRange?.start, cycleRange?.end, taken]); // eslint-disable-line react-hooks/exhaustive-deps
  const curLabel = cursor != null ? (() => { for (let p = cursor; p >= 0 && cursor - p < 4096; p--) { const l = R.labels.get(p); if (l) return p === cursor ? l.name : `${l.name}+${cursor - p}`; if (blk && p <= blk.start) break; } return null; })() : null;
  const narrow = window.matchMedia?.('(max-width: 900px)').matches;
  const nav = (a: Addr) => navigate(a, { center: true, listing: true });
  /** "Go to" with a range: select its loaded part as one anchor, like a block header */
  const selectRange = (s: Addr, e: Addr) => {
    let a = s, b = Math.min(e, 0x10000);
    while (a < b && A.owner[a] < 0) a++;
    while (b > a && A.owner[b - 1] < 0) b--;
    if (a >= b) { toast(`$${h4(s)}–$${h4(e - 1)} holds no loaded bytes`, 'warn'); return; }
    navigate(a, { center: true, listing: true, keepSel: true });
    setSel({ start: a, end: b, multi: true, anchor: a, anchorEnd: b });
  };
  const tabs: [typeof tab, 'list' | 'code' | 'doc' | 'image' | 'chip', string][] = [['listing', 'list', 'Listing'], ['gfx', 'image', 'Graphics'], ['mem', 'chip', 'Memory'], ['source', 'code', `${R.fileNames[0] || 'main'}.asm`], ['spec', 'doc', 'SPEC.md']];

  return (
    <div className={cx('app', drawer && `drawer-${drawer}`)} style={{ '--side-w': sizes.side + 'px', '--insp-w': sizes.insp + 'px', '--bottom-h': sizes.bottom + 'px' } as React.CSSProperties}>
      <TitleBar projectName={project.name} undoLabel={undoLabel} canRedo={!!future.length} theme={theme} busy={!!buildBusy} snapshot={project.files.some(f => f.vsf)}
        verifyState={build && !stale ? (build.ok ? 'ok' : 'bad') : null}
        onOpen={() => void openPrgs(false)} onSave={() => void saveProject()} onUndo={undo} onRedo={redo} onPalette={() => setModal('palette')}
        onVerify={() => void runVerify()} onExport={() => void exportProject()} onBuild={() => void runBuild()} onTerminal={() => void openTerminal()}
        onTheme={() => setUi({ theme: theme === 'dark' ? 'light' : 'dark' })} onSettings={() => setModal('settings')}
        onToggleSide={() => setDrawer(d => d === 'side' ? null : 'side')} onToggleInspector={() => setDrawer(d => d === 'insp' ? null : 'insp')} />

      <ActivityBar activity={activity} specOpen={tab === 'spec'} counts={{ bookmarks: Object.keys(project.bookmarks).length, pack: project.pack?.ranges?.length ?? 0 }} onActivity={(a: Activity) => { setUi({ activity: a }); if (narrow) setDrawer('side'); }} onSpec={() => setUi({ tab: 'spec' })} onPalette={() => setModal('palette')} />

      <aside className="sidebar"><ErrorBoundary>
        <Sidebar view={activity} A={A} R={R} project={project} colors={colors} cursor={cursor} onNavigate={a => { nav(a); setDrawer(null); }}
          onOpen={() => void openPrgs(false)} onAdd={() => void openPrgs(true)} onDemo={loadDemo}
          quicksave={{ info: qsInfo, follow: followQuicksave, onOpen: () => void openQuicksave(), onFollow: v => setUi({ followQuicksave: v }),
            kept: qsList, onOpenKept: q => void openKeptQuicksave(q), onRenameKept: (q, name) => void renameKeptQuicksave(q, name), onSaveKept: q => void saveKeptQuicksave(q),
            onFavouriteKept: (q, on) => void favouriteKeptQuicksave(q, on) }}
          onRemoveFile={i => update('Remove file', d => {
            d.files.splice(i, 1);
            // a patch goes with the file it was written over
            d.patches = d.patches.filter(p => d.files.some(f => p.start >= f.load && patchEnd(p) <= f.load + f.bytes.length));
          })} onSetStart={setStart}
          patches={{ list: project.patches, onGo: goPatch, onEdit: editPatch, onSwitch: switchOnePatch, onSave: p => void savePatchPrg(p), onRemove: removePatch }}
          disk={disk} packing={packing} onMount={() => void mountDisk()} onEject={ejectDisk} onShowSpindle={() => setUi({ bottom: 'spindle', panelOpen: true })} onOpenFromDisk={(f, add) => { openFromDisk(f, add); setDrawer(null); }}
          bmSel={bmSel} onBmSelect={setBmSel} onBmGo={goBookmark} onBmAdd={() => startBookmark()} onBmEdit={openBookmarkEditor} onBmDelete={deleteBookmark}
          bmEditing={bmEdit != null ? { addr: bmEdit, cursorAt: lineAddr() ?? null, onSave: saveBookmark, onCancel: () => { setBmEdit(null); listRef.current?.focus(); }, onPreview: a => navigate(a, { center: true, listing: true, noHistory: true }) } : null}
          pack={{ A, R, project, cursor, sel, prefs: packPrefs, exomizer: toolchain.exomizerPath, desktop: !!kr, busy: buildBusy, result: packRes, current: packKey,
            onChange: setPack, onPack: () => void runPack(), onRun: () => void runPacked(), onSave: () => void savePacked(), onSettings: () => setModal('settings'),
            onLog: () => setUi({ bottom: 'build', panelOpen: true }), onNavigate: a => { nav(a); setDrawer(null); } }} />
      </ErrorBoundary></aside>
      <Splitter dir="v" onDrag={d => setUi({ sizes: { ...useUi.getState().sizes, side: Math.max(200, Math.min(480, useUi.getState().sizes.side + d)) } })} />

      <main className="main">
        {/* the row fits the editor's width (container queries in app.css): the tools lose their labels, then the tabs
            theirs, and on the narrowest the tools move into the ⋯ menu */}
        <div className="tabs main-tabs" role="tablist">
          {tabs.map(([k, ic, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={cx('tab', tab === k && 'on')} title={l} onClick={() => setUi({ tab: k })}><Icon name={ic} size={14} /><span className="tab-label">{l}</span></button>
          ))}
          <span className="grow" />
          {tab === 'listing' && <>
            <div className="tab-tools">
              <button className="icon-btn" onClick={goBack} title="Back (Esc)" aria-label="Back"><Icon name="left" size={14} /></button>
              <button className="icon-btn" onClick={goFwd} title="Forward (Alt+→)" aria-label="Forward"><Icon name="right" size={14} /></button>
              <button className="btn ghost small" onClick={() => setModal('goto')} title="Go to an address or label, or select a range (G)"><Icon name="target" size={14} /><span className="tool-label">Go to</span><kbd>G</kbd></button>
              <button className={cx('btn ghost small', dataAsCode && 'on')} aria-pressed={dataAsCode} onClick={() => setUi({ dataAsCode: !dataAsCode })} title="Data as code: show every block that is not code disassembled, to find code that is marked as data. The export does not change."><Icon name="code" size={14} /><span className="tool-label">Data as code</span></button>
              <button className={cx('btn ghost small', cycles && 'on')} aria-pressed={cycles} onClick={() => setUi({ cycles: !cycles })} title="Cycles: show the 6510 cycles of every instruction. Select a range, or click a block header, to count it; click a branch's cycles to mark it taken."><Icon name="clock" size={14} /><span className="tool-label">Cycles</span></button>
              <div className="seg" role="group" aria-label="Left column" title="Left column of the listing: memory address or line number in the .asm file">
                {([['addr', 'Address', 'Adr'], ['line', 'Line', 'Line']] as const).map(([k, l, s]) => <button key={k} className={cx(gutter === k && 'on')} aria-pressed={gutter === k} aria-label={l} onClick={() => setUi({ gutter: k })}><span className="seg-long">{l}</span><span className="seg-short">{s}</span></button>)}
              </div>
            </div>
            <button className="icon-btn tab-more" aria-label="Listing tools" aria-haspopup="menu" aria-expanded={menu?.owner === 'tools'} title="Back, forward, Go to, Data as code, Cycles and the left column"
              onMouseDown={e => e.stopPropagation()}
              onClick={e => {
                if (menu?.owner === 'tools') { setMenu(null); return; }
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ owner: 'tools', x: r.right - 240, y: r.bottom + 2, items: [
                  { label: 'Back', key: 'Esc', run: goBack },
                  { label: 'Forward', key: 'Alt+→', run: goFwd },
                  { label: 'Go to…', key: 'G', run: () => setModal('goto') },
                  { sep: true },
                  { label: 'Data as code', checked: dataAsCode, run: () => setUi({ dataAsCode: !dataAsCode }) },
                  { label: 'Cycles', checked: cycles, run: () => setUi({ cycles: !cycles }) },
                  { sep: true },
                  { label: 'Left column: address', checked: gutter === 'addr', run: () => setUi({ gutter: 'addr' }) },
                  { label: 'Left column: line in the .asm', checked: gutter === 'line', run: () => setUi({ gutter: 'line' }) },
                ] });
              }}><Icon name="more" size={18} /></button>
          </>}
        </div>
        <div className="editor">
          <ErrorBoundary>
            {tab === 'listing' && <>
              {welcome && <div className="welcome">
                <div><b>{project.files.map(f => f.name).join(', ')}</b> is analysed: {A.blocks.length} blocks, {A.labels.size} labels, {A.music.length ? 'SID music, ' : ''}{A.gfx.length ? `${A.gfx.length} graphics block${A.gfx.length > 1 ? 's' : ''}, ` : ''}{A.stats.illegal} undocumented opcodes.</div>
                <div className="welcome-keys"><kbd>N</kbd> rename <kbd>;</kbd> comment <kbd>/</kbd><kbd>*</kbd> comment line/block above <kbd>B</kbd> bookmark<kbd>C</kbd><kbd>D</kbd><kbd>W</kbd><kbd>T</kbd> mark as code/bytes/words/text <kbd>G</kbd> go to or select a range · drag or <kbd>Shift</kbd>+click to select <kbd>X</kbd> xrefs <kbd>F</kbd> fold <kbd>F7</kbd> verify <kbd>F5</kbd> build &amp; run · right-click for more</div>
                <button className="icon-btn" aria-label="Dismiss" onClick={() => setUi({ welcome: false })}><Icon name="x" size={14} /></button>
              </div>}
              {packing.map((p, i) => p && !packHidden.has(project.files[i]?.id ?? String(i)) && <div key={`pack-${i}`} className="welcome preview-bar pack-bar" role="status">
                <div><b>{project.files[i]?.name} {p.verdict === 'packed' ? 'is packed' : 'may be packed'}{p.signature ? ` (${p.signature})` : ''}.</b> {p.reasons.join('; ')}. The listing shows the decruncher{p.decruncher != null ? ` at $${h4(p.decruncher)}` : ''} and the packed data, not the program.</div>
                <button className="btn small primary" disabled={!!buildBusy} onClick={() => void unpackFile(i)}>{toolchain.unpackerPath ? `Unpack with ${unpackerName}` : 'Set up an unpacker…'}</button>
                <button className="icon-btn" aria-label="Dismiss the packed notice" onClick={() => setPackHidden(s => new Set([...s, project.files[i]?.id ?? String(i)]))}><Icon name="x" size={14} /></button>
              </div>)}
              {unpacked && <div className={cx('welcome preview-bar unpack-bar', !unpacked.ok && 'bad')} role="status">
                <div><b>{unpacked.title}</b><details><summary>{unpackerName} output</summary><pre className="unpack-log">{unpacked.output}</pre></details></div>
                <button className="icon-btn" aria-label="Dismiss the unpacker result" onClick={() => setUnpacked(null)}><Icon name="x" size={14} /></button>
              </div>}
              {dataAsCode && <div className="welcome preview-bar">
                <div><b>Data as code:</b> blocks that are not code are shown disassembled from their start. Select the instructions that are real code and press <kbd>C</kbd> (or right-click → Mark selection as → Code). The export is unchanged.</div>
                <button className="btn small" onClick={() => setUi({ dataAsCode: false })}>Show as classified</button>
              </div>}
              <Listing lines={view.lines} lineNo={view.lineNo} folded={folded} hidden={view.hidden} onToggleFold={toggleFold} excluded={excludedSet} A={A} lineOf={lineOf} cursor={cursor} picked={pickedLine} sel={sel} onClickLine={onClickLine} onDragTo={l => { if (extendTo(l)) setCursor(l.a); }} onMove={moveInto} onToken={onToken} onContext={onContext}
                scrollReq={scrollReq} editing={editing} onCommitEdit={commitEdit} onCancelEdit={() => { setEditing(null); listRef.current?.focus(); }}
                labelError={labelError} setLabelError={setLabelError} listRef={listRef} gutter={gutter} bookmarks={project.bookmarks} onBookmark={a => showBookmarks(a)}
                patches={patchesOn(project.patches)} keepView={dataAsCode} cycles={cycles ? { path, taken, onToggle: toggleTaken } : null} />
            </>}
            <Suspense fallback={<div className="empty">Loading…</div>}>
              {tab === 'source' && <SourceView R={R} A={A} S={S} path={srcPath || `${R.fileNames[0]}.asm`} setPath={setSrcPath} cursor={cursor} onNavigate={(a, o) => navigate(a, o)} theme={theme} extraFiles={extraFiles} problems={kickProblems} onCopy={t => void copyText(t)} onExport={() => void exportProject()}
                scripts={project.scripts ?? {}} onEditScript={setScript} />}
              {tab === 'spec' && <SpecView />}
              {tab === 'gfx' && <MemoryGfx A={A} R={R} cursor={cursor} sel={sel}
                onSelect={(s, e) => { setSel({ start: s, end: e, multi: true, anchor: s, anchorEnd: e }); setCursor(s); }} onClear={() => setSel(null)}
                onMark={(id, r) => mark(id, r)} onShow={a => navigate(a, { center: true, listing: true })} onSave={(name, bytes) => void saveGraphics(name, bytes)} />}
              {tab === 'mem' && <MemoryDump A={A} R={R} cursor={cursor} sel={sel}
                onCursor={a => { navigate(a, { noHistory: true }); setSel({ start: a, end: a + 1, multi: false, anchor: a, anchorEnd: a + 1 }); }}
                onSelect={(s, e) => { setSel({ start: s, end: e, multi: true, anchor: s, anchorEnd: e }); setCursor(s); }} onClear={() => setSel(null)}
                onMark={(id, r) => mark(id, r)} onShow={a => navigate(a, { center: true, listing: true })} onCopy={t => void copyText(t)} />}
            </Suspense>
          </ErrorBoundary>
        </div>
        {tab !== 'spec' && panelOpen && <Splitter dir="h" onDrag={d => setUi({ sizes: { ...useUi.getState().sizes, bottom: Math.max(120, Math.min(520, useUi.getState().sizes.bottom - d)) } })} />}
        {tab !== 'spec' && <section className={cx('bottom', !panelOpen && 'collapsed')} aria-label="Panels">
          <div className="tabs small" role="tablist">
            {bottomTabs.map(([k, l]) => { const n = k === 'log' ? A.log.length : k === 'problems' ? problems.length : k === 'irqs' ? A.raster.length : k === 'spindle' ? A.spindle.length + (disk?.spindle?.jobs.length ?? 0) : null; return (
              <button key={k} role="tab" aria-selected={shownBottom === k} className={cx('tab', shownBottom === k && 'on')} onClick={() => setUi({ bottom: k, panelOpen: true })}>{l}{n != null && <span className={cx('count', k === 'problems' && problems.some(p => p.lvl === 'err') && 'bad')}>{n}</span>}</button>); })}
            <span className="grow" />
            <button className="icon-btn panel-toggle" onClick={() => setUi({ panelOpen: !panelOpen })} aria-label={panelOpen ? 'Collapse panel' : 'Expand panel'} title={panelOpen ? 'Collapse panel' : 'Expand panel'}><Icon name="down" size={14} className={panelOpen ? '' : 'flip'} /></button>
          </div>
          <div className="bottom-body"><ErrorBoundary>
            {shownBottom === 'log' && <LogList items={A.log} onNavigate={nav} empty="No analysis messages." />}
            {shownBottom === 'problems' && <ProblemsPanel items={problems} onNavigate={nav} deep={A.deep} on={!!project.settings.deepAnalysis} busy={busy} onDeep={on => update(on ? 'Deep analysis on' : 'Deep analysis off', d => { d.settings.deepAnalysis = on; })} />}
            {shownBottom === 'xrefs' && <XrefPanel A={A} R={R} cursor={cursor} onNavigate={nav} S={S} />}
            {shownBottom === 'irqs' && <RasterPanel A={A} R={R} onNavigate={nav} />}
            {shownBottom === 'spindle' && <SpindlePanel A={A} R={R} disk={disk} onNavigate={nav} onCopy={(t, what) => void copyText(t, what)} onOpenChunk={openChunk} />}
            {shownBottom === 'stats' && <StatsPanel A={A} />}
            {shownBottom === 'build' && <BuildPanel build={build} S={S} names={R.fileNames} stale={stale} busy={buildBusy} onVerify={() => void runVerify()} onRun={() => void runBuild()} onCopy={t => void copyText(t)} />}
          </ErrorBoundary></div>
        </section>}
      </main>

      <Splitter dir="v" onDrag={d => setUi({ sizes: { ...useUi.getState().sizes, insp: Math.max(260, Math.min(520, useUi.getState().sizes.insp - d)) } })} />
      <aside className="insp-col"><ErrorBoundary>
        <Inspector A={A} R={R} project={project} cursor={cursor} sel={sel} colors={colors} heatMode={heatMode} setHeatMode={setHeatMode}
          onNavigate={nav} onSelect={(s, e) => { setSel({ start: s, end: e, multi: true, anchor: s }); setCursor(s); }}
          onMark={mark} onMerge={mergeBlock} onMergeRange={() => setModal('merge')} onToggleExcluded={toggleExcluded} onToggleBinary={toggleBinary} onFormat={setFormat} onBankZone={setBankZone} onRename={(a, n) => rename(a, n)} onBlockComment={setBlockComment}
          zpVar={pickedDef?.zp && pickedDef.at === cursor ? pickedDef.addr : null} onZpNote={(a, t) => setNote(a, t, !!project.notes[a]?.block)} onZpComment={(a, t) => { if ((project.comments[a] || '') !== t) setComment(a, t); }} onClearOverride={b => clearOverride({ start: b.start, end: b.end })}
          cycles={cycles && path ? { path, onToggle: toggleTaken } : null} />
      </ErrorBoundary></aside>

      <StatusBar A={A} fileCount={project.files.length} cursor={cursor} curLabel={curLabel} blk={blk} sel={sel} renderMs={renderMs} busy={busy} cycles={path && path.instructions ? path.total : null}
        verify={build && !stale ? { ok: build.ok, kick: build.kick ? build.kick.ok : null } : null} />

      {drawer && <div className="drawer-back" onClick={() => setDrawer(null)} />}
      {dropping && <div className="drop"><div><Icon name="upload" size={28} /><p>Drop .prg files or VICE snapshots (.vsf) to open them, or a .d64 to mount it</p><small>Hold Shift to add them to the current project</small></div></div>}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {modal === 'settings' && <SettingsModal settings={S} desktop={!!kr} onSave={s => void saveSettings(s)} onClose={() => setModal(null)} />}
      {modal === 'goto' && <GotoModal R={R} onGo={a => { setModal(null); nav(a); }} onSelect={(s, e) => { setModal(null); selectRange(s, e); }} onClose={() => setModal(null)} />}
      {modal === 'palette' && <CommandPalette commands={commands} onClose={() => setModal(null)} />}
      {modal === 'merge' && <MergeRangeModal A={A} R={R} cursor={cursor} sel={sel} onMerge={mergeRangeInto} onClose={() => setModal(null)} />}
      {modal === 'patch' && patchDraft && <PatchModal A={A} R={R} project={project} draft={patchDraft} onApply={savePatchPlan} onClose={closePatch} />}
      <div className="toasts" aria-live="polite">{toasts.map(t => <div key={t.id} className={cx('toast', `t-${t.kind}`)}><Icon name={LVL_ICON[t.kind] || 'info'} size={15} />{t.msg}</div>)}</div>
    </div>
  );
}
