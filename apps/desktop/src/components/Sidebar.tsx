/* Sidebar: Explorer (files, the mounted disk, program start, memory map), Blocks (filterable), Symbols (labels, hardware registers), Bookmarks, Pack.
 * The Explorer's sections are cards that fold up (the user's choice is kept), each with what it holds in a few words
 * beside its title. */
import { useMemo, useState } from 'react';
import { h2, h4, hwSymbol, kindInfo, overwritesSystemArea, parseVsf, patchEnd, patchFileName, SYSTEM_AREA, type Addr, type AnalysisResult, type D64File, type LoaderPart, type PackingInfo, type Patch, type Project, type RenderResult, type SymbolRef } from '@mimir/core';
import { Icon } from '../lib/icons';
import { parseGoto } from '../lib/goto';
import { cx, fmtBytes, groupOfKind } from '../lib/util';
import type { MountedDisk } from '../lib/types';
import type { QuicksaveInfo } from '../../shared/ipc';
import type { Activity } from '../store/ui';
import { BookmarksView, type BookmarkEditing } from './Bookmarks';
import { MemoryStrip, type CanvasColors } from './Heatmap';
import { PackView, type PackViewProps } from './Pack';
import { SideSection } from './SideSection';

interface SidebarProps {
  view: Activity; A: AnalysisResult; R: RenderResult; project: Project; colors: CanvasColors; cursor: Addr | null;
  onNavigate: (a: Addr) => void; onOpen: () => void; onAdd: () => void; onDemo: () => void; onRemoveFile: (i: number) => void;
  /** set the program start (null: back to the detected one) */
  onSetStart: (a: Addr | null) => void;
  disk: MountedDisk | null; onMount: () => void; onEject: () => void;
  /** open the Spindle script tab (a Spindle disk's load script) */
  onShowSpindle: () => void;
  /** per file: packed (or maybe packed), else null */
  packing: (PackingInfo | null)[];
  /** open a file from the mounted disk (`add`: add it to the project) */
  onOpenFromDisk: (f: D64File, add: boolean) => void;
  /** the bookmark whose note is shown in the Bookmarks view */
  bmSel: Addr | null; onBmSelect: (a: Addr | null) => void;
  onBmGo: (a: Addr) => void; onBmAdd: () => void; onBmEdit: (a: Addr) => void; onBmDelete: (a: Addr) => void;
  /** the bookmark editor at the top of the Bookmarks view */
  bmEditing: BookmarkEditing | null;
  /** the Pack view (Exomizer) */
  pack: PackViewProps;
  /** VICE's quicksave snapshot (Alt+F11 in VICE) */
  quicksave: QuicksaveProps;
  /** the user's patches (spec 10.2) */
  patches: PatchesProps;
}

interface PatchesProps {
  list: readonly Patch[];
  onGo: (p: Patch) => void; onEdit: (p: Patch) => void; onSave: (p: Patch) => void; onRemove: (p: Patch) => void;
  /** switch it on (written over the bytes) or off (the original bytes back) */
  onSwitch: (p: Patch, on: boolean) => void;
}

interface QuicksaveProps {
  /** the newest quicksave and when it was saved, or where VICE writes one (null: unknown, outside the desktop app) */
  info: QuicksaveInfo | null;
  /** each new quicksave opens by itself */
  follow: boolean;
  onOpen: () => void; onFollow: (v: boolean) => void;
}

export function Sidebar({ view, A, R, project, colors, cursor, onNavigate, onOpen, onAdd, onDemo, onRemoveFile, onSetStart, disk, onMount, onEject, onShowSpindle, onOpenFromDisk, packing, bmSel, onBmSelect, onBmGo, onBmAdd, onBmEdit, onBmDelete, bmEditing, pack, quicksave, patches }: SidebarProps) {
  const [q, setQ] = useState('');
  const [symTab, setSymTab] = useState<'labels' | 'hw'>('labels');
  if (view === 'explorer') {
    const segs = A.blocks.filter(b => b.end - b.start >= 48 || (b.type === 'code' && A.entryKind.get(b.start) && A.entryKind.get(b.start) !== 'sub'));
    return (
      <div className="side-inner">
        <div className="side-title">Explorer</div>
        <SideSection id="files" title="Files" summary={`${project.files.length} file${project.files.length === 1 ? '' : 's'}`}
          actions={<>
            <button className="btn tiny ghost" onClick={onDemo} title="Load the showcase: a C64 intro with one block of every type and a guided tour (F2)">Demo</button>
            <button className="icon-btn" title="Add PRG to this project" aria-label="Add PRG to this project" onClick={onAdd}><Icon name="plus" size={14} /></button>
          </>}>
          {project.files.map((f, i) => (
            <div key={f.id || i} className="file-row" onClick={() => onNavigate(f.load)}>
              <Icon name="doc" size={14} />
              <div className="file-meta"><div className="file-name">{f.name}</div><div className="muted mono small">${h4(f.load)}–${h4(f.load + f.bytes.length - 1)} · {fmtBytes(f.bytes.length)}</div></div>
              {packing[i] && <span className="pill pack" title={`${packing[i]!.verdict === 'packed' ? 'Packed' : 'Maybe packed'}${packing[i]!.signature ? ` (${packing[i]!.signature})` : ''}:\n${packing[i]!.reasons.join('\n')}`}>{packing[i]!.verdict === 'packed' ? 'packed' : 'packed?'}</span>}
              {project.files.length > 1 && <button className="icon-btn" title={`Remove ${f.name}`} aria-label={`Remove ${f.name}`} onClick={e => { e.stopPropagation(); onRemoveFile(i); }}><Icon name="x" size={13} /></button>}
            </div>
          ))}
          <div className="side-actions two">
            <button className="btn small" onClick={onOpen} title="Open a .prg, or a VICE snapshot (.vsf), as a new project"><Icon name="upload" size={13} />Open PRG…</button>
            <button className="btn small ghost" onClick={onMount} title="Mount a .d64 disk image and open its files"><Icon name="disk" size={13} />Mount D64…</button>
          </div>
          <p className="side-hint">Or drop .prg, .vsf or .d64 files on the window; with Shift they are added.</p>
        </SideSection>
        {disk && <DiskSection disk={disk} onEject={onEject} onOpenFromDisk={onOpenFromDisk} onShowSpindle={onShowSpindle} />}
        <QuicksaveSection {...quicksave} />
        {patches.list.length > 0 && <PatchesSection {...patches} />}
        <LoadersSection A={A} packed={packing.some(p => p?.verdict === 'packed')} onNavigate={onNavigate} />
        <ProgramStart A={A} R={R} project={project} onNavigate={onNavigate} onSetStart={onSetStart} />
        <SideSection id="map" title="Memory map" summary={`${segs.length} block${segs.length === 1 ? '' : 's'}`}>
          <div className="mmap">
            <MemoryStrip A={A} colors={colors} cursor={cursor} onNavigate={onNavigate} />
            <div className="seg-list">
              {segs.map(b => { const l = R.labels.get(b.start); return (
                <button key={b.id} className={cx('seg-row', cursor != null && cursor >= b.start && cursor < b.end && 'on')} onClick={() => onNavigate(b.start)}>
                  <i style={{ background: `var(--g-${groupOfKind(b.type)})` }} /><span className="mono">${h4(b.start)}</span><span className="seg-name">{l ? l.name : kindInfo(b.type).label}</span>
                </button>); })}
            </div>
          </div>
        </SideSection>
      </div>
    );
  }
  if (view === 'bookmarks') return <BookmarksView A={A} editing={bmEditing} bookmarks={project.bookmarks} R={R} cursor={cursor} selected={bmSel} onSelect={onBmSelect} onGo={onBmGo} onAdd={onBmAdd} onEdit={onBmEdit} onDelete={onBmDelete} />;
  if (view === 'pack') return <PackView {...pack} />;
  if (view === 'blocks') {
    const ql = q.toLowerCase();
    const list = A.blocks.filter(b => { const l = R.labels.get(b.start); return !ql || (l && l.name.toLowerCase().includes(ql)) || kindInfo(b.type).label.toLowerCase().includes(ql) || h4(b.start).includes(ql); });
    return (
      <div className="side-inner">
        <div className="side-title">Blocks <span className="muted">{A.blocks.length}</span></div>
        <div className="side-search"><Icon name="search" size={14} /><label htmlFor="blk-q" className="sr-only">Filter blocks</label><input id="blk-q" value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by name, type or address" /></div>
        <div className="blk-list">
          {list.map(b => { const l = R.labels.get(b.start); const on = cursor != null && cursor >= b.start && cursor < b.end; return (
            <button key={b.id} className={cx('blk-row', on && 'on')} onClick={() => onNavigate(b.start)}>
              <i style={{ background: `var(--g-${groupOfKind(b.type)})` }} />
              <span className="blk-main"><span className="blk-name">{l ? l.name : kindInfo(b.type).label}</span><span className="muted mono small">${h4(b.start)} · {b.end - b.start} B</span></span>
              <span className="blk-type">{kindInfo(b.type).label}{b.user && <Icon name="pencil" size={11} />}</span>
            </button>); })}
        </div>
      </div>
    );
  }
  // symbols
  const ql = q.toLowerCase();
  const labels = [...R.labels.entries()].filter(([, l]) => !ql || l.name.toLowerCase().includes(ql)).sort((x, y) => x[0] - y[0]);
  const hwUse = new Map<string, { sym: SymbolRef; n: number; addr: Addr }>();
  for (const [to, l] of A.xrefs) { const hs = (A.owner[to] < 0 || (to >= 0xd000 && to < 0xe000)) ? hwSymbol(to) : null; if (hs) { const k = hs.sym.name; const e = hwUse.get(k) || { sym: hs.sym, n: 0, addr: to }; e.n += l.length; hwUse.set(k, e); } }
  const hw = [...hwUse.values()].filter(e => !ql || e.sym.name.toLowerCase().includes(ql)).sort((x, y) => y.n - x.n);
  return (
    <div className="side-inner">
      <div className="side-title">Symbols</div>
      <div className="seg wide" role="tablist">{([['labels', `Labels ${R.labels.size}`], ['hw', `Hardware ${hwUse.size}`]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={symTab === k} className={cx(symTab === k && 'on')} onClick={() => setSymTab(k)}>{l}</button>)}</div>
      <div className="side-search"><Icon name="search" size={14} /><label htmlFor="sym-q" className="sr-only">Filter symbols</label><input id="sym-q" value={q} onChange={e => setQ(e.target.value)} placeholder="Filter symbols" /></div>
      <div className="blk-list">
        {symTab === 'labels' ? labels.map(([a, l]) => (
          <button key={a} className={cx('sym-row', cursor === a && 'on')} onClick={() => onNavigate(a)}>
            <span className={cx('mono sym-name', l.user && 'user')}>{l.name}</span><span className="muted mono small">${h4(a)}</span><span className="sym-refs">{(A.xrefs.get(a) || []).length}</span>
          </button>)) : hw.map(e => (
          <div key={e.sym.name} className="sym-row static" title={e.sym.desc}>
            <span className="mono sym-name syn-hw">{e.sym.name}</span><span className="muted small">{e.sym.cat}</span><span className="sym-refs">{e.n}</span>
          </div>))}
      </div>
    </div>
  );
}

/** when a quicksave was saved: the time today, else the date and time */
const savedText = (ms: number) => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? `today ${d.toLocaleTimeString()}` : d.toLocaleString();
};

/** VICE's quicksave snapshot: how to make one in VICE, the newest one, opening it, and opening each new one by itself. */
function QuicksaveSection({ info, follow, onOpen, onFollow }: QuicksaveProps) {
  const file = info?.path.split(/[\\/]/).pop() || 'C64SC.vsf';
  const time = info?.found && info.saved ? new Date(info.saved).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <SideSection id="quicksave" title="VICE quicksave" className="qs-sec" summary={time ?? 'none yet'}>
      <p className="side-hint qs-how">In VICE press <kbd>Alt</kbd>+<kbd>F11</kbd> (Snapshot → Quicksave snapshot): the snapshot {follow ? 'opens here by itself' : 'opens here with F9'}, analysed like a PRG.</p>
      <div className="qs-status small" role="status" aria-label="Latest VICE quicksave">
        {info?.found && info.saved
          ? <><Icon name="ok" size={13} className="qs-ok" /><span>Latest: <b>{savedText(info.saved)}</b> <span className="muted mono" title={info.path}>{file}</span></span></>
          : <><Icon name="info" size={13} /><span className="muted">None yet. VICE writes it as <span className="mono" title={info?.path}>{file}</span> in its settings folder.</span></>}
      </div>
      <button className="btn small qs-open" disabled={!!info && !info.found} onClick={onOpen} title="Open the newest quicksave as a new project (Ctrl+Z goes back to this one)"><Icon name="download" size={13} />Open the latest quicksave <kbd>F9</kbd></button>
      <label className="check small" title="When VICE writes a new quicksave (Alt+F11), it opens here. Ctrl+Z goes back to the project you had.">
        <input type="checkbox" aria-label="Open each new VICE quicksave" checked={follow} onChange={e => onFollow(e.target.checked)} />
        <span>Open new quicksaves automatically</span>
      </label>
    </SideSection>
  );
}

/** The patches by address, each with a switch: a click goes to one (and selects what it wrote); edit, save as PRG,
 *  remove. */
function PatchesSection({ list, onGo, onEdit, onSave, onRemove, onSwitch }: PatchesProps) {
  const sorted = [...list].sort((x, y) => x.start - y.start);
  const on = list.filter(p => !p.off).length;
  return (
    <SideSection id="patches" title="Patches" summary={on === list.length ? `${list.length} on` : `${on} of ${list.length} on`}>
      <div role="list" aria-label="Patches">
        {sorted.map(p => (
          <div key={p.id} role="listitem" className={cx('file-row patch-row', p.off && 'off')} onClick={() => onGo(p)}
            title={`Go to the patch "${p.name}": $${h4(p.start)}–$${h4(patchEnd(p) - 1)}, ${p.bytes.length} bytes${p.over && patchEnd(p) > p.end ? `, ${patchEnd(p) - p.end} past the range` : ''}${p.off ? ' (off)' : ''}\n\n${p.source.length > 400 ? p.source.slice(0, 400) + '…' : p.source}`}>
            <input type="checkbox" role="switch" className="switch" checked={!p.off} aria-label={`Patch ${p.name} on`}
              title={p.off ? 'Off: the original bytes are there. Switch it on' : 'On: written over the original bytes. Switch it off'}
              onClick={e => e.stopPropagation()} onChange={e => onSwitch(p, e.target.checked)} />
            <div className="file-meta"><div className="file-name">{p.name}</div><div className="muted mono small">${h4(p.start)}–${h4(patchEnd(p) - 1)}</div></div>
            <button className="icon-btn" title={`Edit the patch "${p.name}" (P)`} aria-label={`Edit patch ${p.name}`} onClick={e => { e.stopPropagation(); onEdit(p); }}><Icon name="pencil" size={13} /></button>
            <button className="icon-btn" title={`Save as ${patchFileName(p.name)}, loading at $${h4(p.start)}`} aria-label={`Save patch ${p.name} as PRG`} onClick={e => { e.stopPropagation(); onSave(p); }}><Icon name="download" size={13} /></button>
            <button className="icon-btn" title={`Remove the patch${p.off ? '' : `: $${h4(p.start)}–$${h4(patchEnd(p) - 1)} gets its original bytes back`}`} aria-label={`Remove patch ${p.name}`} onClick={e => { e.stopPropagation(); onRemove(p); }}><Icon name="x" size={13} /></button>
          </div>
        ))}
      </div>
      <p className="side-hint">On: written over the loaded bytes. Off: the original bytes are back. The export writes each one's source to patches/ (.asm).</p>
    </SideSection>
  );
}

/** The mounted .d64, listed the way the 1541 lists it. A PRG opens with a click; + adds it to the project. */
function DiskSection({ disk, onEject, onOpenFromDisk, onShowSpindle }: { disk: MountedDisk; onEject: () => void; onOpenFromDisk: (f: D64File, add: boolean) => void; onShowSpindle: () => void }) {
  const { img } = disk;
  return (
    <SideSection id="disk" title="Disk" summary={`"${img.name}"`} actions={<button className="icon-btn" title={`Eject ${disk.name}`} aria-label="Eject disk" onClick={onEject}><Icon name="eject" size={14} /></button>}>
      <div className="disk-head mono small" title={disk.path ?? disk.name}><Icon name="disk" size={13} /><span className="disk-title">"{img.name}"</span><span className="muted">{img.id} {img.dosType}</span></div>
      <div className="disk-list" role="list" aria-label={`Files on ${disk.name}`}>
        {img.files.map((f, i) => {
          const prg = f.type === 'PRG', kind = `${f.closed ? '' : '*'}${f.type}${f.locked ? '<' : ''}`;
          return (
            <div key={i} role="listitem" className={cx('disk-row', !prg && 'off')} title={prg ? `Open ${f.name} (${f.blocks} blocks)` : 'Only PRG files can be opened'}
              tabIndex={prg ? 0 : -1} onClick={() => { if (prg) onOpenFromDisk(f, false); }} onKeyDown={e => { if (prg && e.key === 'Enter') onOpenFromDisk(f, false); }}>
              <span className="mono small disk-blocks">{f.blocks}</span>
              <span className="mono disk-name">"{f.name}"</span>
              <span className="mono small muted">{kind}</span>
              {prg ? <button className="icon-btn" title={`Add ${f.name} to this project`} aria-label={`Add ${f.name} to this project`} onClick={e => { e.stopPropagation(); onOpenFromDisk(f, true); }}><Icon name="plus" size={13} /></button> : <span />}
            </div>
          );
        })}
        {!img.files.length && <div className="muted small">No files on this disk.</div>}
      </div>
      {disk.spindle && (
        <div className="disk-spindle">
          <span><b>Spindle 3 disk:</b> {disk.spindle.jobs.length} job{disk.spindle.jobs.length === 1 ? '' : 's'} the loader reads, not files</span>
          <button className="btn small" onClick={onShowSpindle}>Load script</button>
        </div>
      )}
      <div className="side-hint">{img.freeBlocks} blocks free{img.tracks !== 35 ? ` · ${img.tracks} tracks` : ''} · in drive 8 on Build &amp; Run</div>
    </SideSection>
  );
}

const LOADER_ROLE: Record<LoaderPart['role'], string> = { resident: 'on the C64', drivecode: 'drive code', command: 'drive command', install: 'installer', tape: 'tape loader', kernal: 'KERNAL LOAD', text: 'its name' };

/** The fast, IRQ and tape loaders the analysis found (spec 8.11c): what each is, how it works and where its parts are. */
function LoadersSection({ A, packed, onNavigate }: { A: AnalysisResult; packed: boolean; onNavigate: (a: Addr) => void }) {
  return (
    <SideSection id="loaders" title="Loaders" className="loader-sec" summary={A.loaders.length ? `${A.loaders.length} found` : 'none found'}>
      {A.loaders.length ? A.loaders.map(l => (
        <div key={l.id} className="loader" aria-label={l.name}>
          <div className="loader-name">{l.name}{l.sure === 'likely' && <span className="pill" title="Found by what loaders do (drive code, drive commands, a receive loop), not by its own code">by its traits</span>}</div>
          <div className="muted small">{l.how}</div>
          <ul className="loader-parts">
            {l.parts.slice(0, 12).map((p, i) => (
              <li key={i} className={p.outside ? 'outside' : undefined}>{p.outside
                ? <span className="mono" title={p.what}>${h4(p.start)}–${h4(p.end - 1)}</span>
                : <button className="mono" title={`${p.what}\nClick to go there`} onClick={() => onNavigate(p.start)}>${h4(p.start)}–${h4(p.end - 1)}</button>}
              <span>{LOADER_ROLE[p.role]}{p.outside && ' · not opened'}</span></li>
            ))}
            {l.parts.length > 12 && <li className="muted">and {l.parts.length - 12} more, marked in the listing</li>}
          </ul>
          {l.parts.some(p => p.outside) && <p className="side-hint">Part of it is in the snapshot's zero page or stack, which is not opened. Tick <i>VICE snapshots: include the zero page and the stack</i> in Settings → Analysis and open the snapshot again to see it.</p>}
        </div>
      )) : <p className="side-hint">{packed ? 'None found: the program is packed, and its loader with it. Unpack it (the notice above the listing) to find it.' : 'No fast, IRQ or tape loader found, and no KERNAL LOAD.'}</p>}
    </SideSection>
  );
}

/** How Build & Run starts the first file in VICE (see App.runBuild and prepareVice); `snapshot`: where the snapshot the
 *  project was opened from goes on, which Build & Run restarts instead */
function viceStartText(A: AnalysisResult, ep: Addr | null, snapshot?: string | null): { text: string; warn?: boolean } {
  if (snapshot) return { text: `VICE restarts the snapshot as it was taken (${snapshot}); the start is for the analysis` };
  const f0 = A.files[0];
  const overSystem = !!f0 && overwritesSystemArea(f0.load, f0.bytes.length);
  if (ep != null && A.owner[ep] === 0) return { text: overSystem ? `VICE loads it from the monitor and jumps to $${h4(ep)}` : `VICE loads it and types sys ${ep}` };
  if (ep != null && A.owner[ep] > 0) return { text: 'VICE starts it with RUN: the start is in another file', warn: true };
  return overSystem ? { text: `VICE starts it with RUN, which cannot work: it overwrites $${h4(SYSTEM_AREA.start)}-$${h4(SYSTEM_AREA.end - 1)}. Set a start.`, warn: true } : { text: 'VICE starts it with RUN, no start address' };
}

/** Where the program starts: detected (BASIC SYS target or the load address) or typed in by the user. */
function ProgramStart({ A, R, project, onNavigate, onSetStart }: Pick<SidebarProps, 'A' | 'R' | 'project' | 'onNavigate' | 'onSetStart'>) {
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  const sys = A.basics.find(b => b.sys != null)?.sys;
  const detected = sys != null ? { a: sys, from: 'BASIC SYS' } : A.files[0] ? { a: A.files[0].load, from: 'load address' } : null;
  const user = project.entryPoint != null && A.owner[project.entryPoint] >= 0;
  const name = A.entry != null ? R.labels.get(A.entry)?.name : undefined;
  // a project opened from a snapshot: where the CPU was when it was taken
  const vsf = project.files.find(f => f.vsf)?.vsf;
  const snapshot = useMemo(() => { if (!vsf) return null; try { const s = parseVsf(vsf); return [s.cpu ? `PC $${h4(s.cpu.pc)}` : null, `$01 = $${h2(s.port.data)}`].filter(Boolean).join(', '); } catch { return null; } }, [vsf]);
  const vice = viceStartText(A, project.entryPoint, snapshot);
  const apply = () => {
    const t = parseGoto(v, n => { for (const [a, l] of R.labels) if (l.name === n) return a; return undefined; });
    if (!('addr' in t)) { setErr('Enter one hex address like $0810 or a label name.'); return; }
    if (A.owner[t.addr] < 0) { setErr(`$${h4(t.addr)} is not part of any loaded file.`); return; }
    setErr(''); setV(''); onSetStart(t.addr);
  };
  return (
    <SideSection id="start" title="Program start" summary={A.entry != null ? `$${h4(A.entry)}` : 'none'}>
      {A.entry != null && <button className="seg-row start-at" onClick={() => onNavigate(A.entry!)}>
        <i style={{ background: 'var(--g-code)' }} /><span className="mono">${h4(A.entry)}</span><span className="seg-name">{name ?? ''}</span>
        <span className={cx('pill', user && 'user')}>{user ? 'set by you' : detected ? detected.from : ''}</span>
      </button>}
      <div className="start-row">
        <input className="mono" aria-label="Program start address" value={v} placeholder="$0810 or a label" spellCheck={false}
          onChange={e => { setV(e.target.value); setErr(''); }} onKeyDown={e => { if (e.key === 'Enter') apply(); }} />
        <button className="btn small" onClick={apply}>Set</button>
        {project.entryPoint != null && <button className="btn small ghost" title={`Clear the program start: the analysis uses the detected start again${detected ? ` (${detected.from} $${h4(detected.a)})` : ''} and VICE starts the program with RUN`}
          onClick={() => { setErr(''); setV(''); onSetStart(null); }}><Icon name="x" size={12} />Clear</button>}
      </div>
      {err && <div className="err-text small">{err}</div>}
      <div className={cx('small start-vice', vice.warn ? 'warn-text' : 'muted')}><Icon name="play" size={11} />Build &amp; Run: {vice.text}</div>
    </SideSection>
  );
}
