/* Bottom panel: analysis log, problems, cross-references, raster IRQs, the Spindle script, a Bitfire disk's files,
 * statistics, build output. */
import {
  BITFIRE_VERSION, bitfireFileName, d64writeScript, decode, h2, h4, hwSymbol, kickMnemonic, lineText, OPC, spinChunkName, spindleCondition, spindleLabel, spindleName, spindleRoutines, spindleScript, spinScript,
  type Addr, type AnalysisResult, type BitfireFile, type CartBuild, type DeepReport, type RasterIrq, type RenderResult, type Settings, type SpindleChunk, type SpindleDriver, type SpindleJob,
} from '@mimir/core';
import { Icon, LVL_ICON } from '../lib/icons';
import { cx, fmtBytes, GROUP_LABEL, GROUP_ORDER, groupOfType } from '../lib/util';
import type { BottomTab } from '../store/ui';
import type { BuildState, MountedDisk, UiProblem } from '../lib/types';
import type { TypeGroup } from '@mimir/core';

export function LogList({ items, onNavigate, empty }: { items: UiProblem[]; onNavigate: (a: Addr) => void; empty: string }) {
  if (!items.length) return <div className="empty">{empty}</div>;
  return (
    <div className="loglist">
      {items.map((l, i) => (
        <div key={i} className={cx('logrow', `lvl-${l.lvl}`)}>
          <Icon name={LVL_ICON[l.lvl] || 'info'} size={14} className="lvl-icon" />
          <span className="log-cat">{l.cat}</span>
          <span className="log-msg">{l.msg}</span>
          {l.action && <button className="btn small primary log-action" onClick={l.action.run}>{l.action.label}</button>}
          {l.addr != null && <button className="addr-link" onClick={() => onNavigate(l.addr!)}>${h4(l.addr)}</button>}
        </div>
      ))}
    </div>
  );
}

/** The Problems tab: the deep analysis (on or off, and what it did) over the list. */
export function ProblemsPanel({ items, onNavigate, deep, on, busy, onDeep }: { items: UiProblem[]; onNavigate: (a: Addr) => void; deep: DeepReport | null; on: boolean; busy: boolean; onDeep: (on: boolean) => void }) {
  const s = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  return (
    <>
      <div className="problems-head">
        <label className="check" title="Slower: traces every guess on trial and keeps it only when it runs into no problem, does not follow calls into ROM or through operands the code writes, decides branches by the flags before them, and analyses again until the problems are at a minimum">
          <input type="checkbox" checked={on} onChange={e => onDeep(e.target.checked)} aria-label="Deep analysis" /><span>Deep analysis</span>
        </label>
        <span className="muted small" role="status" aria-label="Deep analysis result">
          {on && deep ? `${deep.before} → ${s(deep.after, 'problem')} in ${s(deep.rounds, 'round')}, ${(deep.ms / 1000).toFixed(1)} s · the Log tells what it left out`
            : on ? (busy ? 'Analysing…' : '')
              : 'Slower: tests every guess and analyses again until the problems are at a minimum'}
        </span>
      </div>
      <LogList items={items} onNavigate={onNavigate} empty="No problems found." />
    </>
  );
}

const XREF_KIND: Record<string, string> = { call: 'call', jump: 'jump', branch: 'branch', read: 'read', write: 'write', rmw: 'read+write', ptr: 'pointer' };

export function XrefPanel({ A, R, cursor, onNavigate, S }: { A: AnalysisResult; R: RenderResult; cursor: Addr | null; onNavigate: (a: Addr) => void; S: Settings }) {
  if (cursor == null) return <div className="empty">Place the cursor on a line to see who references it.</div>;
  const ins = A.insLen[cursor] ? cursor : A.codeOwner[cursor] >= 0 ? A.codeOwner[cursor] : cursor;
  const label = R.labels.get(ins);
  const to = (A.xrefs.get(ins) || []).slice().sort((x, y) => x.from - y.from);
  const text = (a: Addr) => { const l = R.lines.find(x => x.a === a && (x.k === 'ins' || x.k === 'dat')); return l ? lineText(l, S).trim().replace(/\s+\/\/.*$/, '') : ''; };
  const outgoing: Addr[] = [];
  if (A.insLen[ins]) { const d = decode(A.mem, ins); if (d.target != null) outgoing.push(d.target); }
  return (
    <div className="xref">
      <div className="xref-head">References to <b className="mono">{label ? label.name : '$' + h4(ins)}</b> <span className="muted">(${h4(ins)})</span> — {to.length}</div>
      {to.length ? (
        <table className="tbl"><thead><tr><th>From</th><th>Kind</th><th>Instruction</th></tr></thead><tbody>
          {to.map((x, i) => <tr key={i} onClick={() => onNavigate(x.from)}><td className="mono link-cell">${h4(x.from)}</td><td><span className={cx('kind', `kind-${x.kind}`)}>{XREF_KIND[x.kind] || x.kind}</span></td><td className="mono">{text(x.from)}</td></tr>)}
        </tbody></table>
      ) : <div className="empty small">No references. Entry points, vectors and data reached only through computed addresses have none.</div>}
      {outgoing.length > 0 && <div className="xref-out">This instruction targets <button className="addr-link" onClick={() => onNavigate(outgoing[0])}>${h4(outgoing[0])}</button>{R.labels.get(outgoing[0]) ? <span className="mono"> {R.labels.get(outgoing[0])!.name}</span> : (hwSymbol(outgoing[0]) ? <span className="mono syn-hw"> {hwSymbol(outgoing[0])!.text}</span> : null)}</div>}
    </div>
  );
}

/** Every IRQ handler with the raster line it runs at (spec 8.11d), by line; a row goes to its handler. */
export function RasterPanel({ A, R, onNavigate }: { A: AnalysisResult; R: RenderResult; onNavigate: (a: Addr) => void }) {
  if (!A.raster.length) return <div className="empty">No IRQ handlers found: the trace finds them where the code sets $0314 or $fffe, and in a snapshot where its vectors point.</div>;
  const link = (a: Addr | null) => a == null ? <span className="muted">—</span>
    : <button className="addr-link" title={`$${h4(a)}`} onClick={e => { e.stopPropagation(); onNavigate(a); }}>{R.labels.get(a)?.name ?? `$${h4(a)}`}</button>;
  const d011 = (r: RasterIrq) => !r.d011 ? '—' : r.d011.value != null ? `$${h2(r.d011.value)}` : r.d011.bit8 != null ? `bit 7 = ${r.d011.bit8}` : '?';
  const handlers = new Set(A.raster.map(r => r.handler)).size;
  return (
    <div className="xref raster">
      <div className="xref-head">{A.raster.length} raster interrupt{A.raster.length === 1 ? '' : 's'}, {handlers} handler{handlers === 1 ? '' : 's'} <span className="muted">· the line is $d012 with bit 7 of $d011 as bit 8 (0 where $d011 is not written)</span></div>
      <table className="tbl" aria-label="Raster IRQs"><thead><tr><th>Line</th><th>$d012</th><th>$d011</th><th>Handler</th><th>Set at</th><th>By</th></tr></thead><tbody>
        {A.raster.map((r, i) => (
          <tr key={i} onClick={() => onNavigate(r.handler)}>
            <td className="mono">{r.line != null ? `${r.line} ($${r.line.toString(16).padStart(3, '0')})` : '?'}</td>
            <td className="mono">{r.d012 != null ? `$${h2(r.d012)}` : r.setAt != null ? '?' : '—'}</td>
            <td className="mono">{d011(r)}</td>
            <td className="mono">{link(r.handler)}</td>
            <td className="mono">{link(r.setAt ?? r.installedAt)}</td>
            <td>{r.from == null ? (r.installedAt == null ? <span className="muted">no line found</span> : 'main code') : r.from === r.handler && r.installedAt == null ? 'itself' : link(r.from)}{r.vector != null && <span className="muted"> via ${h4(r.vector)}</span>}</td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

interface SpindlePanelProps {
  A: AnalysisResult; R: RenderResult;
  /** the mounted disk: its load script when it is a Spindle 3 disk */
  disk: MountedDisk | null;
  onNavigate: (a: Addr) => void; onCopy: (text: string, what: string) => void;
  /** open a job's chunk as a PRG (`add`: add it to the project) */
  onOpenChunk: (j: SpindleJob, c: SpindleChunk, add: boolean) => void;
}

/** The Spindle script tab: a mounted Spindle 3 disk's load script (Spin's jobs), and the effect drivers in memory. */
export function SpindlePanel({ A, R, disk, onNavigate, onCopy, onOpenChunk }: SpindlePanelProps) {
  if (!A.spindle.length && !disk?.spindle) return <div className="empty">No Spindle script: a Spindle 3 disk holds the jobs its load script lists, and a VICE snapshot of a trackmo linked with Pefchain holds its effect drivers.</div>;
  return (
    <>
      {disk?.spindle && <SpinDiskSection disk={disk} onCopy={onCopy} onOpenChunk={onOpenChunk} />}
      {A.spindle.length > 0 && <DriversSection A={A} R={R} onNavigate={onNavigate} onCopy={onCopy} />}
    </>
  );
}

/** A Spindle 3 disk's jobs (spec 13.5b), a row per chunk; a row opens the chunk as a PRG at its address, + adds it. */
function SpinDiskSection({ disk, onCopy, onOpenChunk }: { disk: MountedDisk; onCopy: (text: string, what: string) => void; onOpenChunk: (j: SpindleJob, c: SpindleChunk, add: boolean) => void }) {
  const d = disk.spindle!;
  const chunks = d.jobs.reduce((n, j) => n + j.chunks.length, 0);
  const notes = (j: SpindleJob) => [j.jump != null && `then jumps to $${h4(j.jump)}`, j.shadow && 'loads under I/O', j.missing > 0 && `${j.missing} bytes could not be decrunched`].filter(Boolean).join(' · ');
  return (
    <div className="xref spindle">
      <div className="xref-head spindle-head">
        <span>Load script of {disk.name} (Spin, Spindle 3): {d.jobs.length} job{d.jobs.length === 1 ? '' : 's'}, {chunks} chunk{chunks === 1 ? '' : 's'} <span className="muted">· a job is a loader call{d.start != null ? `; after job 1 the boot program goes to $${h4(d.start)}` : ''}{d.next != null ? '; then the next disk side' : ''}; the file names are not on the disk</span></span>
        <button className="btn small" onClick={() => onCopy(spinScript(d, disk.name).join('\n'), 'Copied the load script')}><Icon name="copy" size={14} />Copy script</button>
      </div>
      <table className="tbl" aria-label="Spindle load script"><thead><tr><th>Job</th><th>Loads</th><th>Bytes</th><th>File</th><th>Notes</th><th /></tr></thead><tbody>
        {d.jobs.flatMap(j => j.chunks.map((c, k) => {
          const name = spinChunkName(j, c);
          return (
            <tr key={`${j.n}-${c.start}`} className={cx(k === 0 && 'job-first')} title={`Open ${name} as a PRG at $${h4(c.start)}`} onClick={() => onOpenChunk(j, c, false)}>
              <td className="mono">{k === 0 && <>{j.n}{j.labels.map(l => <span key={l} className="pill">{h2(l)}:</span>)}</>}</td>
              <td className="mono">${h4(c.start)}–${h4(c.end - 1)}</td>
              <td className="mono">{c.end - c.start}</td>
              <td className="mono">{name}</td>
              <td className="muted">{k === 0 && notes(j)}</td>
              <td><button className="icon-btn" title={`Add ${name} to this project`} aria-label={`Add ${name} to this project`} onClick={e => { e.stopPropagation(); onOpenChunk(j, c, true); }}><Icon name="plus" size={13} /></button></td>
            </tr>
          );
        }))}
      </tbody></table>
    </div>
  );
}

/** The Bitfire script tab (spec 13.5c): a Bitfire disk's own files, a row each, in the order d64write wrote them (and
 *  the loader loads them); a row opens the file as a PRG, unpacked when it is packed (bitnax for 0.x, else dali), +
 *  adds it. */
export function BitfirePanel({ disk, onCopy, onOpenFile }: { disk: MountedDisk; onCopy: (text: string, what: string) => void; onOpenFile: (f: BitfireFile, add: boolean) => void }) {
  const d = disk.bitfire!;
  const unpacked = d.files.filter(f => f.unpacked).length, n = d.files.length, packer = d.format === '0.x' ? 'bitnax' : 'dali';
  // what the disk's own directory holds: the boot program and other files (and a dirart)
  const inDir = [d.boot != null ? 'the boot program' : '', d.standard.length ? `${d.standard.length} other file${d.standard.length === 1 ? '' : 's'}` : ''].filter(Boolean);
  const dirText = inDir.length ? `; ${inDir.join(' and ')} ${inDir.length > 1 || d.standard.length > 1 ? 'are' : 'is'} in the directory${d.dirart ? `, a dirart of ${d.dirart} lines` : ''}` : '';
  const notes = (f: BitfireFile) => [
    f.unpacked ? `packed with ${packer}${f.unpacked.inplace ? ', in place' : ''}` : d.format === '0.x' ? 'not packed (or bitnax copying from memory before it): as it is on the disk' : 'not packed',
    `from ${f.track}/${f.sector}${f.offset ? ` byte ${f.offset}` : ''}`,
  ].join(' · ');
  return (
    <div className="xref spindle">
      <div className="xref-head spindle-head">
        <span>Files of {disk.name} ({BITFIRE_VERSION[d.format]}{d.oldBitnax ? ', packed as in 2014–2015' : ''}, side {d.side}): {n} file{n === 1 ? '' : 's'}{unpacked ? `, ${unpacked} unpacked` : ''} <span className="muted">· Bitfire has no load script: a part loads the next file or one by its number, so this is the order they load in; d64write's command line rebuilds the disk{dirText}; the file names are not on the disk</span></span>
        <button className="btn small" onClick={() => onCopy(d64writeScript(d, disk.name).join('\n'), 'Copied the d64write command line')}><Icon name="copy" size={14} />Copy script</button>
      </div>
      <table className="tbl" aria-label="Bitfire files"><thead><tr><th>File</th><th>Loads</th><th>Unpacks to</th><th>Bytes</th><th>Name</th><th>Notes</th><th /></tr></thead><tbody>
        {d.files.map(f => {
          const name = bitfireFileName(f), u = f.unpacked;
          return (
            <tr key={f.n} title={u ? `Open ${name} unpacked, as a PRG at $${h4(u.start)}` : `Open ${name} as a PRG at $${h4(f.load)}, as it loads`} onClick={() => onOpenFile(f, false)}>
              <td className="mono">${h2(f.n)}</td>
              <td className="mono">${h4(f.load)}–${h4(f.end - 1)}</td>
              <td className="mono">{u ? `$${h4(u.start)}–$${h4(u.end - 1)}` : <span className="muted">—</span>}</td>
              <td className="mono">{u ? `${f.bytes.length} → ${u.end - u.start}` : f.bytes.length}</td>
              <td className="mono">{name}</td>
              <td className="muted">{notes(f)}</td>
              <td><button className="icon-btn" title={`Add ${name} to this project`} aria-label={`Add ${name} to this project`} onClick={e => { e.stopPropagation(); onOpenFile(f, true); }}><Icon name="plus" size={13} /></button></td>
            </tr>
          );
        })}
      </tbody></table>
    </div>
  );
}

/** Spindle's effect drivers (spec 8.11f), a row per line of the script they were built from; a row goes to its driver. */
function DriversSection({ A, R, onNavigate, onCopy }: { A: AnalysisResult; R: RenderResult; onNavigate: (a: Addr) => void; onCopy: (text: string, what: string) => void }) {
  const D = A.spindle;
  const link = (a: Addr) => <button className="addr-link" title={`$${h4(a)}`} onClick={e => { e.stopPropagation(); onNavigate(a); }}>{R.labels.get(a)?.name ?? `$${h4(a)}`}</button>;
  const then = (d: SpindleDriver, i: number) => {
    if (d.ends === 'stop') return <span className="muted">the end of the demo</span>;
    if (d.ends === 'stay') return <span className="muted">stays</span>;
    if (d.ends === 'flip') return <span className="muted">the next disk side</span>;
    const to = D.find(x => x.front === d.next);
    if (!to) return <>{link(d.next!)} <span className="muted">not in memory</span></>;
    if (to === D[i + 1] && to.part === d.part) return <span className="muted">its <span className="mono">|</span> line</span>;
    return <>{to === D[i + 1] ? 'part' : 'back to part'} {to.part}{d.seek != null && <span className="muted"> · seeks label {h2(d.seek)}</span>}</>;
  };
  return (
    <div className="xref spindle">
      <div className="xref-head spindle-head">
        <span>{D.length} Spindle effect driver{D.length === 1 ? '' : 's'} (Pefchain), read back as the script they were built from <span className="muted">· the parts are numbered in the order they run; their file names are not in the program</span></span>
        <button className="btn small" onClick={() => onCopy(spindleScript(D).join('\n'), 'Copied the Spindle script')}><Icon name="copy" size={14} />Copy script</button>
      </div>
      <table className="tbl" aria-label="Spindle script"><thead><tr><th>Part</th><th>Script line</th><th>Driver</th><th>Routines</th><th>Then</th></tr></thead><tbody>
        {D.map((d, i) => {
          const label = spindleLabel(d, D);
          const notes = [d.blank && `blank part${d.music != null ? `, plays $${h4(d.music)}` : ''}`, d.condition.kind === 'sync' && `interlock $${h2(d.condition.addr & 0xff)}`, d.jump && 'fadeout picks a label (J)', d.loads && 'loads'].filter(Boolean);
          return (
            <tr key={d.front} className={cx(d.running && 'running')} onClick={() => onNavigate(d.start)}>
              <td className="mono">{d.part}{d.running && <span className="pill hi">running</span>}</td>
              <td className="mono script-line">{label != null && <span className="muted">{h2(label)}: </span>}<span className="syn-label">{spindleName(d)}</span> <span>{spindleCondition(d.condition)}</span></td>
              <td className="mono">{link(d.front)}</td>
              <td className="routines">{!d.blank && spindleRoutines(d).map(([k, a]) => <span key={k} className="routine"><span className="muted">{k}</span> {link(a)}</span>)}{notes.length > 0 && <span className="muted">{notes.join(' · ')}</span>}</td>
              <td>{then(d, i)}</td>
            </tr>
          );
        })}
      </tbody></table>
    </div>
  );
}

const MODE_NAME: Record<string, string> = { imp: 'implied', acc: 'accumulator', imm: 'immediate', zp: 'zero page', zpx: 'zp,x', zpy: 'zp,y', izx: '(zp,x)', izy: '(zp),y', rel: 'relative', abs: 'absolute', abx: 'abs,x', aby: 'abs,y', ind: 'indirect' };

export function StatsPanel({ A }: { A: AnalysisResult }) {
  const st = A.stats;
  const top = Object.entries(st.mn).sort((a, b) => b[1] - a[1]).slice(0, 18);
  const max = top.length ? top[0][1] : 1;
  const modes = Object.entries(st.modes).sort((a, b) => b[1] - a[1]);
  const modeMax = modes.length ? modes[0][1] : 1;
  const groups: Partial<Record<TypeGroup, number>> = {};
  for (const [t, n] of Object.entries(st.bytesByType)) { const g = groupOfType(+t); groups[g] = (groups[g] || 0) + n; }
  const codePct = Math.round(100 * (groups.code || 0) / Math.max(1, st.total));
  return (
    <div className="stats">
      <div className="tiles">
        <div className="tile"><div className="tile-v">{st.ins}</div><div className="tile-l">instructions</div></div>
        <div className="tile"><div className="tile-v">{codePct}%</div><div className="tile-l">of loaded bytes are code</div></div>
        <div className="tile"><div className="tile-v">{A.blocks.length}</div><div className="tile-l">blocks</div></div>
        <div className="tile"><div className="tile-v">{st.xrefs}</div><div className="tile-l">cross-references</div></div>
        <div className="tile"><div className="tile-v">{st.illegal}</div><div className="tile-l">undocumented opcodes</div></div>
        <div className="tile"><div className="tile-v">{st.ms.toFixed(1)} ms</div><div className="tile-l">analysis time (worker)</div></div>
      </div>
      <div className="stat-cols">
        <section>
          <h4>Memory composition <span className="muted">({fmtBytes(st.total)} loaded)</span></h4>
          <div className="stack" role="img" aria-label="Share of loaded bytes per classification">
            {GROUP_ORDER.filter(g => groups[g]).map(g => <span key={g} style={{ flex: groups[g], background: `var(--g-${g})` }} title={`${GROUP_LABEL[g]}: ${groups[g]} bytes`} />)}
          </div>
          <ul className="legend">{GROUP_ORDER.filter(g => groups[g]).map(g => <li key={g}><i style={{ background: `var(--g-${g})` }} />{GROUP_LABEL[g]} <span className="muted mono">{fmtBytes(groups[g]!)}</span></li>)}</ul>
          <h4>Addressing modes</h4>
          <div className="bars">{modes.map(([m, n]) => <div key={m} className="bar-row" title={`${MODE_NAME[m]}: ${n}`}><span className="bar-l">{MODE_NAME[m]}</span><span className="bar-track"><span className="bar alt" style={{ width: `${(n / modeMax) * 100}%` }} /></span><span className="bar-v">{n}</span></div>)}</div>
        </section>
        <section>
          <h4>Opcode frequency <span className="muted">(top {top.length})</span></h4>
          <div className="bars">{top.map(([m, n]) => { const ill = OPC.some(o => o.mn === m && o.ill) && !OPC.some(o => o.mn === m && !o.ill); return <div key={m} className="bar-row" title={`${m}: ${n}`}><span className={cx('bar-l mono', ill && 'syn-ill')}>{kickMnemonic(m)}</span><span className="bar-track"><span className="bar" style={{ width: `${(n / max) * 100}%` }} /></span><span className="bar-v">{n}</span></div>; })}</div>
        </section>
      </div>
    </div>
  );
}

/** `cart`: the project's cartridge, whose own source is built last and whose image VICE attaches (spec 13.9) */
interface BuildPanelProps { build: BuildState | null; S: Settings; names: string[]; cart: CartBuild | null; stale: boolean; busy: string | null; onVerify: () => void; onRun: () => void; onCopy: (s: string) => void }

export function BuildPanel({ build, S, names, cart, stale, busy, onVerify, onRun, onCopy }: BuildPanelProps) {
  const name = names[0] || 'main';
  const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  const kick = (entry: string) => `${q(S.javaPath)} -jar ${q(S.kickJar)} ${entry} -odir ${S.outDir} ${S.kickArgs}`;
  const kickCmd = kick(`${name}.asm`);
  const cartCmd = cart ? kick(cart.entry) : null;
  const viceCmd = `${q(S.vicePath)} ${S.viceArgs} -moncommands ${S.outDir}/${name}.vs ${cart ? `-cartcrt ${S.outDir}/${cart.output}` : `-autostart ${S.outDir}/${name}.prg`}`;
  return (
    <div className="build">
      <div className="build-actions">
        <button className="btn" onClick={onVerify} disabled={!!busy}><Icon name="check" />Verify round-trip</button>
        <button className="btn primary" onClick={onRun} disabled={!!busy}><Icon name="play" />Build &amp; run</button>
        {busy ? <span className="small text-accent-hi">{busy}…</span> : <span className="muted small">The main process runs these with argument arrays (no shell), in a temporary build folder:</span>}
      </div>
      <div className="cmd"><code>{kickCmd}</code><button className="icon-btn" title="Copy command" onClick={() => onCopy(kickCmd)}><Icon name="copy" size={14} /></button></div>
      {cartCmd && <div className="cmd"><code>{cartCmd}</code><button className="icon-btn" title="Copy command" onClick={() => onCopy(cartCmd)}><Icon name="copy" size={14} /></button></div>}
      <div className="cmd"><code>{viceCmd}</code><button className="icon-btn" title="Copy command" onClick={() => onCopy(viceCmd)}><Icon name="copy" size={14} /></button></div>
      {build ? (
        <>
          <div className="mb-2 flex flex-wrap gap-2 text-[11.5px]">
            <span className={cx('rounded border px-2 py-0.5', build.V.ok ? 'border-ok text-ok' : 'border-err text-err')}>built-in verifier: {build.V.ok ? 'byte-identical' : 'differences'}</span>
            {build.kick
              ? <span className={cx('rounded border px-2 py-0.5', build.kick.ok ? 'border-ok text-ok' : 'border-err text-err')}>KickAss.jar: {build.kick.ok ? 'byte-identical' : `${build.kick.problems.length} problem${build.kick.problems.length === 1 ? '' : 's'}`}</span>
              : <span className="rounded border border-line-2 px-2 py-0.5 text-fg-3">KickAss.jar: not run (set its path in Settings → Toolchain)</span>}
            {build.cart && <span className={cx('rounded border px-2 py-0.5', build.cart.ok && (!build.kick?.cart || build.kick.cart.ok) ? 'border-ok text-ok' : 'border-err text-err')}>{build.cart.name}: {build.cart.ok && (!build.kick?.cart || build.kick.cart.ok) ? 'byte-identical' : 'differences'}</span>}
          </div>
          <pre className={cx('build-log', build.ok ? 'ok' : 'bad', stale && 'stale')}>{stale && '(project changed since this run — verify again)\n'}{build.log}</pre>
        </>
      ) : <div className="empty small">Run “Verify round-trip” to re-assemble the generated source with the built-in verifier and, when KickAss.jar is configured, with the real Kick Assembler, then compare every byte with the original PRG.</div>}
    </div>
  );
}

export const BOTTOM_TABS: [BottomTab, string][] = [['log', 'Analysis log'], ['problems', 'Problems'], ['xrefs', 'Cross-references'], ['irqs', 'Raster IRQs'], ['spindle', 'Spindle script'], ['bitfire', 'Bitfire script'], ['stats', 'Statistics'], ['build', 'Build output']];
