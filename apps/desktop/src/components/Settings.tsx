/* Settings: toolchain (stored by the main process), analysis and Kick Assembler output (stored in the project). */
import { useState } from 'react';
import { DEFAULT_SETTINGS, type Settings } from '@mimir/core';
import { cx } from '../lib/util';
import { Modal } from './Modal';

type Key = keyof Settings;

export function SettingsModal({ settings, desktop, onSave, onClose }: { settings: Settings; desktop: boolean; onSave: (s: Settings) => void; onClose: () => void }) {
  const [s, setS] = useState<Settings>(settings);
  const [tab, setTab] = useState<'toolchain' | 'analysis' | 'output'>('toolchain');
  const set = <K extends Key>(k: K, v: Settings[K]) => setS(o => ({ ...o, [k]: v }));
  const txt = (k: Key, label: string, help?: string) => <label className="field"><span>{label}</span><input id={`set-${k}`} className="mono" value={String(s[k])} onChange={e => set(k, e.target.value as never)} spellCheck={false} />{help && <small className="muted">{help}</small>}</label>;
  const chk = (k: Key, label: string, help?: string) => <label className="check"><input id={`set-${k}`} type="checkbox" checked={!!s[k]} onChange={e => set(k, e.target.checked as never)} /><span>{label}{help && <small className="muted"> — {help}</small>}</span></label>;
  const sel = (k: Key, label: string, opts: [string | number, string][]) => <label className="field"><span>{label}</span><select id={`set-${k}`} value={String(s[k])} onChange={e => set(k, (isNaN(+e.target.value) ? e.target.value : +e.target.value) as never)}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="seg wide" role="tablist">{([['toolchain', 'Toolchain'], ['analysis', 'Analysis'], ['output', 'Kick Assembler output']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={cx(tab === k && 'on')} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="modal-body">
        {tab === 'toolchain' && <>
          {txt('javaPath', 'Java executable', 'Kick Assembler needs Java 8 or later.')}
          {txt('kickJar', 'KickAss.jar', 'Verify and Build & Run assemble with this jar when it exists.')}
          {txt('kickArgs', 'Extra Kick Assembler arguments', '-vicesymbols writes a VICE label file next to the PRG.')}
          {txt('vicePath', 'VICE emulator (x64sc)')}
          {txt('viceArgs', 'Extra VICE arguments')}
          {txt('viceQuicksave', 'VICE quicksave snapshot', 'Empty: C64SC.vsf (x64sc) or C64.vsf (x64) in VICE\'s settings folder (%APPDATA%\\vice), where Snapshot → Quicksave snapshot (Alt+F11) writes it. F9 opens the newest, and the Explorer can open each new one by itself.')}
          {txt('outDir', 'Output folder')}
          {txt('unpackerPath', 'External unpacker (optional)', 'Empty: Sindri, the built-in unpacker, unpacks packed (crunched) PRGs. It runs the program in an emulated C64, with the ROMs of the VICE above (or of another VICE it finds), and reports each layer it peels off. An external unpacker such as unp64 runs instead, on a copy of the PRG in a folder of its own.')}
          {txt('unpackerArgs', 'External unpacker arguments', '{in} is the packed PRG, {out} a name for the result; without {out} the file it writes is picked up. unp64: {in} · exomizer: desfx -o {out} {in}')}
          {txt('exomizerPath', 'Exomizer', 'Packs the PRG Build & Run builds, whole or the blocks you choose, in the Pack view. The installed app comes with Exomizer 3.1.1 (resources\\exomizer in its folder) and uses it unless you pick another. Empty: no packing.')}
          <p className="muted small">{desktop ? 'Stored by the app (not in the project). The main process starts Java, VICE, an external unpacker and Exomizer with argument lists, never through a shell.' : 'Running outside the desktop app: these paths only fill in the exported build scripts.'}</p>
        </>}
        {tab === 'analysis' && <>
          {chk('illegal', 'Trace undocumented opcodes', 'LAX, SAX, DCP, ISC… common in demos')}
          {chk('detectMusic', 'Detect SID music', 'JMP init/play tables, the code they reach (traced or not), SID register writes and note tables')}
          {chk('detectGfx', 'Detect graphics', 'from $d018/$dd00/sprite pointer writes, then sizes and alignment')}
          {chk('detectText', 'Detect text', 'PETSCII printed through KERNAL, screen codes copied to screen RAM')}
          {chk('codeIslands', 'Decode unreached code that reads as a routine', 'data nothing traced reaches becomes code when it is 6+ documented instructions ending in RTS or JMP (no BRK, branches inside it); mark it as data (D) where it is not')}
          {chk('deepAnalysis', 'Deep analysis (slower)', 'traces every guess (code island, pointer-table target, interrupt handler, load address) on trial and keeps it only when it runs into no problem; does not follow a JSR or JMP into ROM or through an operand the code writes, or past a routine that never returns; decides branches by the flags set before them; and analyses again until the problems are at a minimum. A large snapshot takes a second or two')}
          {chk('bankTracking', 'Follow the memory configuration ($01) and VIC bank', 'names I/O, KERNAL and BASIC accesses only where they are banked in; $dd00 and the $dd02 trick select the VIC bank')}
          {chk('snapshotZeroPage', 'VICE snapshots: include the zero page and the stack', 'opens the RAM from $0002 instead of $0200, for code that runs there (a PC or IRQ handler there is traced). Zero-page variables are then labels of the loaded bytes. Applies to the next snapshot you open')}
        </>}
        {tab === 'output' && <>
          <div className="grid2">
            {sel('hexCase', 'Hex digits', [['lower', '$d020'], ['upper', '$D020']])}
            {sel('bytesPerRow', 'Bytes per .byte row', [[8, '8'], [16, '16'], [4, '4']])}
            {sel('indent', 'Indent', [[8, '8 spaces'], [4, '4 spaces'], [2, '2 spaces']])}
            {sel('commentCol', 'Comment column', [[40, '40'], [48, '48'], [32, '32']])}
          </div>
          {sel('hwInclude', 'Hardware registers and KERNAL routines', [['import', 'Names from include/c64-hardware.asm (#import)'], ['inline', 'Names defined in the .asm file (.label lines)'], ['none', 'Real addresses ($d020, $ffd2), without include/c64-hardware.asm']])}
          <p className="muted small">With real addresses the listing and the export write <span className="mono">sta $d020</span> instead of <span className="mono">sta VIC_BORDER_COLOR</span>, and the comment below still names the register (hover shows its name). Saved in the project; a PRG you open next keeps it.</p>
          {chk('basicUpstart', 'Use BasicUpstart2() when the BASIC stub matches it')}
          {chk('musicAsSid', 'Export detected music as a .sid file loaded with LoadSid()')}
          {chk('gfxBinary', 'Export charsets and bitmaps as binary files with .import binary')}
          {chk('hwComments', 'Comment hardware register accesses', 'what the register or KERNAL routine does, with names or with real addresses')}
          {chk('addrComments', 'Add the original address to every line')}
          {sel('notesFormat', 'Bookmarks and comments in the export', [['html', 'NOTES.html: a formatted page with the code in colour (open it in a browser)'], ['txt', 'NOTES.txt: plain text'], ['none', 'No document']])}
          <p className="muted small">Written only when the project has bookmarks or comments. Both formats list them by address, each with its place in the .asm file and the code around it.</p>
          <p className="muted small">Mnemonics are always written in lower case: Kick Assembler 5.x rejects upper-case mnemonics.</p>
        </>}
      </div>
      <div className="modal-foot"><button className="btn ghost" onClick={() => setS({ ...DEFAULT_SETTINGS })}>Restore defaults</button><span className="grow" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onSave(s)}>Save settings</button></div>
    </Modal>
  );
}
