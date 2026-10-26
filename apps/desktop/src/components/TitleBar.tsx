import { Icon } from '../lib/icons';
import { cx } from '../lib/util';

interface TitleBarProps {
  projectName: string; undoLabel: string | null; canRedo: boolean; theme: string;
  verifyState: 'ok' | 'bad' | null; busy: boolean;
  /** the project was opened from a VICE snapshot: Build & Run restarts it as it was */
  snapshot?: boolean;
  onOpen: () => void; onSave: () => void; onUndo: () => void; onRedo: () => void; onPalette: () => void;
  onVerify: () => void; onExport: () => void; onBuild: () => void; onTerminal: () => void; onTheme: () => void; onSettings: () => void;
  onToggleSide: () => void; onToggleInspector: () => void;
}

export function TitleBar(p: TitleBarProps) {
  return (
    <header className="titlebar">
      <button className="icon-btn only-narrow" aria-label="Toggle sidebar" onClick={p.onToggleSide}><Icon name="menu" /></button>
      <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span className="brand-name">KickReasm</span><span className="brand-sub">Studio</span></div>
      <div className="tb-group hide-narrow">
        <button className="btn ghost" onClick={p.onOpen} title="Open PRG files (Ctrl+O)"><Icon name="upload" />Open</button>
        <button className="btn ghost" onClick={p.onSave} title="Save project (Ctrl+S)"><Icon name="download" />Save</button>
        <button className="icon-btn" onClick={p.onUndo} disabled={!p.undoLabel} title={p.undoLabel ? `Undo: ${p.undoLabel} (Ctrl+Z)` : 'Nothing to undo'} aria-label="Undo"><Icon name="undo" /></button>
        <button className="icon-btn" onClick={p.onRedo} disabled={!p.canRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><Icon name="redo" /></button>
      </div>
      <button className="cmd-search hide-narrow" onClick={p.onPalette}><Icon name="search" size={14} /><span>{p.projectName}</span><kbd>Ctrl+Shift+P</kbd></button>
      <span className="grow" />
      <div className="tb-group">
        <button className={cx('btn', p.verifyState === 'ok' ? 'okish' : p.verifyState === 'bad' ? 'badish' : '')} onClick={p.onVerify} disabled={p.busy} title="Re-assemble and compare byte by byte (F7)"><Icon name={p.verifyState === 'ok' ? 'ok' : 'check'} /><span className="hide-narrow">Verify</span></button>
        <button className="btn" onClick={p.onExport} disabled={p.busy} title="Export Kick Assembler project to a folder (Ctrl+E)"><Icon name="folder" /><span className="hide-narrow">Export</span></button>
        <button className="btn" onClick={p.onTerminal} aria-label="Terminal" title="Open a terminal in the project folder: VICE (x64sc) is on PATH and kickass <file.asm> runs Kick Assembler"><Icon name="prompt" /><span className="hide-narrow">Terminal</span></button>
        <button className="btn primary" onClick={p.onBuild} disabled={p.busy} title={p.snapshot ? 'Build with KickAss.jar and restart the snapshot in VICE as it was taken, with the built program in its RAM (F5)' : 'Build with KickAss.jar and run in VICE (F5)'}><Icon name="play" /><span className="hide-narrow">Build &amp; Run</span></button>
        <button className="icon-btn" onClick={p.onTheme} aria-label="Toggle theme" title="Toggle light/dark theme"><Icon name={p.theme === 'dark' ? 'sun' : 'moon'} /></button>
        <button className="icon-btn" onClick={p.onSettings} aria-label="Settings" title="Settings (Ctrl+,)"><Icon name="sliders" /></button>
        <button className="icon-btn only-narrow" aria-label="Toggle inspector" onClick={p.onToggleInspector}><Icon name="panel" /></button>
      </div>
    </header>
  );
}
