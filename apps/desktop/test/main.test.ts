/* Main-process logic without Electron: path policy, settings store, IPC schemas, toolchain runner. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, DEFAULT_PACK, demoProject, deserializeProject, LEGACY_PROJECT_FORMAT, makeD64, render, serializeProject, type SerializedProject, type ToolchainSettings } from '@mimir/core';
import { findKickAssJar, writeVfs } from '@mimir/core/node';
import { CHANNELS } from '../shared/ipc';
import { assertEntryName, PathPolicy } from '../electron/main/paths';
import { bringOldSettings } from '../electron/main/migrate';
import { RecentFolders } from '../electron/main/recent';
import { bundledExomizer, bundledUnp64, defaultToolchainSettings, SettingsStore } from '../electron/main/settings';
import { diskOpenSchema, exportWriteSchema, fileSaveSchema, packSchema, prgOpenSchema, projectSchema, runSchema, serializedProjectSchema } from '../electron/main/schemas';
import { buildWithKickAssembler, packWithExomizer } from '../electron/main/toolchain';
import { QUICKSAVE_FILE, QuicksaveWatcher, quicksaveFiles, quicksaveInfo, readQuicksave, viceConfigDir } from '../electron/main/quicksave';
import { readDiskImage, readPrgFiles, readProjectFile, writeProjectFile } from '../electron/main/project-fs';
import { charRomFiles, readCharRom } from '../electron/main/chargen';

const tmp = () => mkdtempSync(join(tmpdir(), 'mimir-desktop-test-'));
const toolchain = (patch: Partial<ToolchainSettings> = {}): ToolchainSettings => ({ javaPath: 'java', kickJar: '', vicePath: '', outDir: 'out', kickArgs: '-vicesymbols -showmem', viceArgs: '-autostartprgmode 1', unpackerPath: '', unpackerArgs: '{in}', exomizerPath: '', viceQuicksave: '', ...patch });

describe('IPC contract', () => {
  it('has exactly the channels of spec 13.4', () => {
    expect(Object.values(CHANNELS).sort()).toEqual(['disk:open', 'export:write', 'fs:changed', 'prg:open', 'project:open', 'project:save', 'settings:get', 'settings:set', 'terminal:open', 'toolchain:build', 'toolchain:identify', 'toolchain:pack', 'toolchain:run', 'toolchain:unpack', 'vice:attach', 'vice:command', 'file:save', 'vice:quicksave', 'vice:quicksave-info', 'vice:quicksaved', 'vice:chargen'].sort());
  });
});

describe('PathPolicy', () => {
  it('only allows paths inside picked folders', () => {
    const p = new PathPolicy();
    const root = p.allow(join(tmpdir(), 'picked'));
    expect(p.isAllowed(root)).toBe(true);
    expect(p.isAllowed(join(root, 'sub', 'a.asm'))).toBe(true);
    expect(p.isAllowed(join(root, '..', 'other'))).toBe(false);
    expect(p.isAllowed(join(root + '-sibling', 'x'))).toBe(false);
    expect(p.isAllowed('')).toBe(false);
    expect(() => p.assert(join(tmpdir(), 'elsewhere'), 'Build folder')).toThrow(/outside the folders/);
  });

  it('accepts only plain .asm names as build entries', () => {
    expect(assertEntryName('raster-demo.asm')).toBe('raster-demo.asm');
    for (const bad of ['../x.asm', 'a/b.asm', 'C:\\x.asm', 'x.prg', '-oops.asm', '']) expect(() => assertEntryName(bad)).toThrow();
  });
});

describe('SettingsStore', () => {
  it('starts from defaults, validates and persists changes', () => {
    const dir = tmp();
    const s = new SettingsStore(dir, () => toolchain());
    expect(s.get().outDir).toBe('out');
    s.set({ kickJar: 'C:\\C64\\KickAss.jar', outDir: 'build' });
    expect(new SettingsStore(dir, () => toolchain()).get()).toMatchObject({ kickJar: 'C:\\C64\\KickAss.jar', outDir: 'build' });
    expect(() => s.set({ outDir: '../escape' })).toThrow();
    expect(s.get().outDir).toBe('build');
  });

  it('ignores an unreadable settings file', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'settings.json'), '{ not json');
    expect(new SettingsStore(dir, () => toolchain()).get().javaPath).toBe('java');
  });

  describe('the unp64 that comes with the app', () => {
    /** a fake install: resources\unp64\unp64.exe, plus other unpackers elsewhere */
    const setup = () => {
      const root = tmp(), res = join(root, 'resources');
      mkdirSync(join(res, 'unp64'), { recursive: true });
      const exe = process.platform === 'win32' ? 'unp64.exe' : 'unp64';
      writeFileSync(join(res, 'unp64', exe), '');
      mkdirSync(join(root, 'C64', 'unp64'), { recursive: true });
      writeFileSync(join(root, 'C64', 'unp64', 'unp64.exe'), '');
      writeFileSync(join(root, 'C64', 'exomizer.exe'), '');
      return { dir: tmp(), res, bundled: bundledUnp64(res)!, own: join(root, 'C64', 'unp64', 'unp64.exe'), exo: join(root, 'C64', 'exomizer.exe') };
    };
    const stored = (dir: string) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));

    it('is found in resources\\unp64 and is the default unpacker', () => {
      const { res, bundled, dir } = setup();
      expect(bundled).toBe(join(res, 'unp64', process.platform === 'win32' ? 'unp64.exe' : 'unp64'));
      expect(bundledUnp64(tmp())).toBeNull();
      expect(bundledUnp64(undefined)).toBeNull();
      expect(defaultToolchainSettings(bundled).unpackerPath).toBe(bundled);
      expect(new SettingsStore(dir, () => toolchain(), bundled).get().unpackerPath).toBe(bundled);
      // nothing is written before the user saves settings
      expect(existsSync(join(dir, 'settings.json'))).toBe(false);
    });

    it('takes over once from another copy of unp64, then keeps what the user picks', () => {
      const { dir, bundled, own } = setup();
      new SettingsStore(dir, () => toolchain(), null).set({ unpackerPath: own, unpackerArgs: '{in} -x' });
      const s = new SettingsStore(dir, () => toolchain(), bundled);
      expect(s.get()).toMatchObject({ unpackerPath: bundled, unpackerArgs: '{in} -x' });
      expect(stored(dir)).toMatchObject({ unpackerPath: bundled, bundledUnpacker: bundled });
      // the user's own unp64 again, and later no unpacker at all: both are kept from then on
      s.set({ unpackerPath: own });
      expect(new SettingsStore(dir, () => toolchain(), bundled).get().unpackerPath).toBe(own);
      new SettingsStore(dir, () => toolchain(), bundled).set({ unpackerPath: '' });
      expect(new SettingsStore(dir, () => toolchain(), bundled).get().unpackerPath).toBe('');
    });

    it('keeps another unpacker, and replaces one that is gone', () => {
      const { dir, bundled, exo } = setup();
      new SettingsStore(dir, () => toolchain(), null).set({ unpackerPath: exo, unpackerArgs: 'desfx -o {out} {in}' });
      expect(new SettingsStore(dir, () => toolchain(), bundled).get()).toMatchObject({ unpackerPath: exo, unpackerArgs: 'desfx -o {out} {in}' });
      const gone = tmp();
      new SettingsStore(gone, () => toolchain(), null).set({ unpackerPath: join(tmp(), 'exomizer.exe'), unpackerArgs: 'desfx -o {out} {in}' });
      expect(new SettingsStore(gone, () => toolchain(), bundled).get()).toMatchObject({ unpackerPath: bundled, unpackerArgs: '{in}' });
    });
  });
});

describe('the Exomizer that comes with the app', () => {
  const setup = () => {
    const root = tmp(), res = join(root, 'resources');
    mkdirSync(join(res, 'exomizer'), { recursive: true });
    writeFileSync(join(res, 'exomizer', process.platform === 'win32' ? 'exomizer.exe' : 'exomizer'), '');
    writeFileSync(join(root, 'exomizer.exe'), '');
    return { dir: tmp(), bundled: bundledExomizer(res)!, own: join(root, 'exomizer.exe') };
  };

  it('is found in resources\\exomizer and is the default', () => {
    const { dir, bundled } = setup();
    expect(bundled).toMatch(/[\\/]resources[\\/]exomizer[\\/]exomizer(\.exe)?$/);
    expect(bundledExomizer(tmp())).toBeNull();
    expect(bundledExomizer(undefined)).toBeNull();
    expect(defaultToolchainSettings(null, bundled).exomizerPath).toBe(bundled);
    // settings saved before Exomizer was a setting get the default
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(toolchain()).replace(/,"exomizerPath":""/, ''));
    expect(new SettingsStore(dir, () => toolchain({ exomizerPath: bundled }), null, bundled).get().exomizerPath).toBe(bundled);
  });

  it('keeps another Exomizer and an empty setting, and replaces one that is gone', () => {
    const { dir, bundled, own } = setup();
    new SettingsStore(dir, () => toolchain(), null, null).set({ exomizerPath: own });
    expect(new SettingsStore(dir, () => toolchain(), null, bundled).get().exomizerPath).toBe(own);
    new SettingsStore(dir, () => toolchain(), null, null).set({ exomizerPath: '' });
    expect(new SettingsStore(dir, () => toolchain(), null, bundled).get().exomizerPath).toBe('');
    new SettingsStore(dir, () => toolchain(), null, null).set({ exomizerPath: join(tmp(), 'gone', 'exomizer.exe') });
    expect(new SettingsStore(dir, () => toolchain(), null, bundled).get().exomizerPath).toBe(bundled);
  });
});

describe('VICE quicksave snapshots', () => {
  const vsf = () => readFileSync(join(__dirname, '../../../fixtures/vsf/raster-demo.vsf'));

  it('looks where VICE writes them: C64SC.vsf and C64.vsf in its settings folder, or the file in Settings', () => {
    expect(viceConfigDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me')).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'vice'));
    expect(viceConfigDir({}, 'linux', '/home/me')).toBe(join('/home/me', '.config', 'vice'));
    expect(viceConfigDir({ XDG_CONFIG_HOME: '/cfg' }, 'darwin', '/home/me')).toBe(join('/cfg', 'vice'));
    expect(quicksaveFiles('', '/v')).toEqual([join('/v', 'C64SC.vsf'), join('/v', 'C64.vsf')]);
    expect(quicksaveFiles('  D:\\snaps\\mine.vsf ', '/v')).toEqual(['D:\\snaps\\mine.vsf']);
  });

  it('opens the newest one as a snapshot, and says where VICE writes it when there is none', async () => {
    const dir = tmp(), files = quicksaveFiles('', dir);
    expect(await readQuicksave(files)).toEqual({ found: false, path: files[0] });
    expect(await quicksaveInfo(files)).toEqual({ found: false, path: files[0] });
    writeFileSync(files[1], vsf());
    expect(await quicksaveInfo(files)).toMatchObject({ found: true, path: files[1], saved: expect.any(Number) });
    const r = await readQuicksave(files);
    expect(r).toMatchObject({ found: true, path: files[1] });
    if (!r.found) throw new Error('not found');
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ name: QUICKSAVE_FILE.replace(/\.vsf$/, '.prg'), load: 0x0200, start: 0x0810, entries: [0x08c7, 0x08b7] });
    expect(r.files[0].snapshot).toMatch(/^VICE 3\.10 snapshot/);
    const zp = await readQuicksave(files, { zeroPage: true });
    expect(zp.found && zp.files[0].load).toBe(0x0002);
    writeFileSync(files[0], 'not a snapshot');
    await expect(readQuicksave(files)).rejects.toThrow(/not a VICE snapshot/);
  });

  it('reports a new quicksave, once, when the file is written or created', async () => {
    const dir = tmp(), files = quicksaveFiles('', dir), seen: string[] = [];
    const w = new QuicksaveWatcher(e => seen.push(e.path), 50);
    try {
      w.watch(files);
      await new Promise(r => setTimeout(r, 200));
      writeFileSync(files[0], vsf());
      for (let i = 0; i < 40 && !seen.length; i++) await new Promise(r => setTimeout(r, 50));
      expect(seen).toEqual([files[0]]);
      // watching the same files again does not start over
      w.watch([...files]);
      await new Promise(r => setTimeout(r, 400));
      expect(seen).toEqual([files[0]]);
    } finally { w.close(); }
  });
});

describe('schemas', () => {
  it('reads old project files that used "bytes" overrides', () => {
    const p = demoProject();
    const json = { ...serializeProject(p), overrides: [{ start: 0x0a00, end: 0x0a10, type: 'bytes' }] };
    const parsed = serializedProjectSchema.parse(JSON.parse(JSON.stringify(json)));
    expect(parsed.overrides[0].type).toBe('data');
  });

  it('reads comment lines and blocks, and older files without them', () => {
    const p = { ...demoProject(), notes: { 0x0810: { text: 'set up' }, 0x0900: { text: 'two\nlines', block: true } } };
    const json = JSON.parse(JSON.stringify(serializeProject(p)));
    expect(serializedProjectSchema.parse(json).notes).toEqual({ 2064: { text: 'set up' }, 2304: { text: 'two\nlines', block: true } });
    delete json.notes;
    expect(serializedProjectSchema.parse(json).notes).toEqual({});
    expect(projectSchema.safeParse(p).success).toBe(true);
    expect(projectSchema.safeParse({ ...p, notes: { 0x0810: 'not a note' } }).success).toBe(false);
  });

  it('keeps the snapshot a file was opened from, saving and reading the project', () => {
    const vsf = Uint8Array.from([0x56, 0x49, 0x43, 0x45, 1, 2, 3]);
    const p = demoProject();
    p.files[0] = { ...p.files[0], vsf };
    const saved = projectSchema.parse(p);
    expect(saved.files[0].vsf).toEqual(vsf);
    const read = deserializeProject(serializedProjectSchema.parse(JSON.parse(JSON.stringify(serializeProject({ ...p, files: saved.files })))) as SerializedProject);
    expect(read.files[0].vsf).toEqual(vsf);
    expect(serializedProjectSchema.parse(JSON.parse(JSON.stringify(serializeProject(demoProject())))).files[0].vsf).toBeUndefined();
  });

  it('reads patches, and older files without them; the bytes written and written over go together', () => {
    const patch = { id: 'a1', name: 'red border', start: 0x091e, end: 0x0926, source: '  lda #$02\n  sta $d020', fill: 'nop' as const, over: false,
      bytes: Uint8Array.of(0xa9, 0x02, 0x8d, 0x20, 0xd0, 0xea, 0xea, 0xea), old: Uint8Array.of(0xad, 0x1b, 0xd4, 0x29, 0x0f, 0x8d, 0xe7, 0xdb) };
    const p = { ...demoProject(), patches: [patch] };
    expect(projectSchema.safeParse(p).success).toBe(true);
    expect(projectSchema.safeParse({ ...p, patches: [{ ...patch, old: patch.old.subarray(1) }] }).success).toBe(false);
    const json = JSON.parse(JSON.stringify(serializeProject(p)));
    const read = deserializeProject(serializedProjectSchema.parse(json) as SerializedProject);
    expect(read.patches.map(x => ({ ...x, id: 'a1' }))).toEqual([patch]);
    expect(serializedProjectSchema.safeParse({ ...json, patches: [{ ...json.patches[0], old: 'AAA=' }] }).success).toBe(false);
    // one switched off, one written with the cycle count kept, keeps that
    const off = JSON.parse(JSON.stringify(serializeProject({ ...p, patches: [{ ...patch, off: true, cycles: true }] })));
    expect(deserializeProject(serializedProjectSchema.parse(off) as SerializedProject).patches[0]).toMatchObject({ off: true, cycles: true });
    delete json.patches;
    expect(serializedProjectSchema.parse(json).patches).toEqual([]);
  });

  it('reads bank zones, and older files without them', () => {
    const p = { ...demoProject(), bankZones: [{ start: 0x0810, end: 0x0820, port: 0x34 }, { start: 0x0900, end: 0x0910, vicBank: 2 }, { start: 0x0810, end: 0x0818, port: null }] };
    const json = JSON.parse(JSON.stringify(serializeProject(p)));
    expect(serializedProjectSchema.parse(json).bankZones).toEqual(p.bankZones);
    delete json.bankZones;
    expect(serializedProjectSchema.parse(json).bankZones).toEqual([]);
    expect(projectSchema.safeParse(p).success).toBe(true);
    expect(projectSchema.safeParse({ ...p, bankZones: [{ start: 0, end: 1, vicBank: 4 }] }).success).toBe(false);
  });

  it('reads the program start, and older files without it', () => {
    const p = { ...demoProject(), entryPoint: 0x0866 };
    const json = JSON.parse(JSON.stringify(serializeProject(p)));
    expect(serializedProjectSchema.parse(json).entryPoint).toBe(0x0866);
    delete json.entryPoint;
    expect(serializedProjectSchema.parse(json).entryPoint).toBeNull();
    expect(projectSchema.safeParse(p).success).toBe(true);
    expect(projectSchema.safeParse({ ...p, entryPoint: 0x10000 }).success).toBe(false);
  });

  it('reads blocks excluded from the build, and older files without them', () => {
    const p = { ...demoProject(), excluded: [0x09b5, 0x1000] };
    const json = JSON.parse(JSON.stringify(serializeProject(p)));
    expect(serializedProjectSchema.parse(json).excluded).toEqual([0x09b5, 0x1000]);
    delete json.excluded;
    expect(serializedProjectSchema.parse(json).excluded).toEqual([]);
    expect(projectSchema.safeParse(p).success).toBe(true);
  });

  it('reads bookmarks, and older files without them', () => {
    const p = { ...demoProject(), bookmarks: { 0x0810: { title: 'init', text: 'set up\nthe screen' } } };
    const json = JSON.parse(JSON.stringify(serializeProject(p)));
    expect(serializedProjectSchema.parse(json).bookmarks).toEqual({ 2064: { title: 'init', text: 'set up\nthe screen' } });
    delete json.bookmarks;
    expect(serializedProjectSchema.parse(json).bookmarks).toEqual({});
    expect(projectSchema.safeParse(p).success).toBe(true);
    expect(projectSchema.safeParse({ ...p, bookmarks: { 0x0810: 'not a bookmark' } }).success).toBe(false);
    expect(projectSchema.safeParse({ ...p, bookmarks: { 0x0810: { title: 'x'.repeat(201), text: '' } } }).success).toBe(false);
  });

  it('reads edited build scripts, and older files without them', () => {
    const p = { ...demoProject(), scripts: { 'build.sh': '#!/bin/sh\necho mine\n' } };
    const json = JSON.parse(JSON.stringify(serializeProject(p)));
    expect(serializedProjectSchema.parse(json).scripts).toEqual({ 'build.sh': '#!/bin/sh\necho mine\n' });
    delete json.scripts;
    expect(serializedProjectSchema.parse(json).scripts).toEqual({});
    expect(projectSchema.safeParse(p).success).toBe(true);
    // only the two build scripts can be replaced
    expect(projectSchema.safeParse({ ...p, scripts: { 'raster-demo.asm': 'nop' } }).success).toBe(false);
  });

  it('reads the pack settings, and older files without them', () => {
    const pack = { ...DEFAULT_PACK, ranges: [{ start: 0x0810, end: 0x1000 }], start: 'jmp' as const, jmp: 0x0810, ramExit: 0x35 };
    const p = { ...demoProject(), pack };
    const json = JSON.parse(JSON.stringify(serializeProject(p)));
    expect(serializedProjectSchema.parse(json).pack).toEqual(pack);
    expect(deserializeProject(serializedProjectSchema.parse(json) as SerializedProject).pack).toEqual(pack);
    delete json.pack;
    expect(serializedProjectSchema.parse(json).pack).toBeNull();
    expect(projectSchema.safeParse(p).success).toBe(true);
    expect(projectSchema.safeParse(demoProject()).success).toBe(true);
  });

  it('accepts what to pack, and refuses paths, -o and empty ranges', () => {
    const files = [{ name: 'game.prg', prg: Uint8Array.of(1, 8, 0) }];
    expect(packSchema.safeParse({ files, prefs: DEFAULT_PACK }).success).toBe(true);
    expect(packSchema.safeParse({ files, prefs: { ...DEFAULT_PACK, extra: '-p 4 -Di_ram_during=$34' } }).success).toBe(true);
    for (const extra of ['-o x.prg', '-N C:\\x', 'a/b.prg', '-- x']) {
      const r = packSchema.safeParse({ files, prefs: { ...DEFAULT_PACK, extra } });
      expect(r.success, extra).toBe(false);
    }
    expect(packSchema.safeParse({ files, prefs: { ...DEFAULT_PACK, ranges: [{ start: 0x1000, end: 0x1000 }] } }).success).toBe(false);
    expect(packSchema.safeParse({ files, prefs: { ...DEFAULT_PACK, mode: 'raw' } }).success).toBe(false);
    expect(packSchema.safeParse({ files, prefs: { ...DEFAULT_PACK, shell: 'x' } }).success).toBe(false);
    expect(packSchema.safeParse({ files: [{ name: 'a.prg', prg: Uint8Array.of(1) }], prefs: DEFAULT_PACK }).success).toBe(false);
    expect(fileSaveSchema.safeParse({ name: 'game-exo.prg', bytes: Uint8Array.of(1, 8, 0) }).success).toBe(true);
    expect(fileSaveSchema.safeParse({ name: 'game-exo.prg', bytes: new Uint8Array(0) }).success).toBe(false);
  });

  it('accepts the format of the notes document, and older settings without it', () => {
    const p = demoProject();
    for (const notesFormat of ['html', 'txt', 'none']) expect(projectSchema.safeParse({ ...p, settings: { ...p.settings, notesFormat } }).success).toBe(true);
    expect(projectSchema.safeParse({ ...p, settings: { ...p.settings, notesFormat: 'pdf' } }).success).toBe(false);
    const json = JSON.parse(JSON.stringify(serializeProject(p)));
    delete json.settings.notesFormat;
    expect(serializedProjectSchema.parse(json).settings.notesFormat).toBeUndefined();
    expect(deserializeProject(serializedProjectSchema.parse(json) as SerializedProject).settings.notesFormat).toBe('html');
  });

  it('accepts a program start for Build & Run', () => {
    expect(runSchema.parse({ prgPath: 'C:/out/p.prg', start: 0x0866 }).start).toBe(0x0866);
    expect(runSchema.parse({ prgPath: 'C:/out/p.prg' }).start).toBeUndefined();
    expect(runSchema.safeParse({ prgPath: 'C:/out/p.prg', start: 0x10000 }).success).toBe(false);
    expect(runSchema.parse({ prgPath: 'C:/out/p.prg', disk: 'C:/tmp/disk.d64' }).disk).toBe('C:/tmp/disk.d64');
    expect(runSchema.safeParse({ prgPath: 'C:/out/p.prg', disk: '' }).success).toBe(false);
    expect(diskOpenSchema.parse(undefined)).toEqual({});
  });

  it('accepts a project with binary file data from the renderer', () => {
    expect(projectSchema.safeParse(demoProject()).success).toBe(true);
    expect(projectSchema.safeParse({ ...demoProject(), files: [{ id: 'x', name: 'a.prg', load: 0x0801, bytes: [1, 2, 3] }] }).success).toBe(false);
  });

  it('requires exactly one export destination', () => {
    expect(exportWriteSchema.safeParse({ target: 'temp', files: {} }).success).toBe(true);
    expect(exportWriteSchema.safeParse({ dir: 'C:\\out', files: {} }).success).toBe(true);
    expect(exportWriteSchema.safeParse({ files: {} }).success).toBe(false);
    expect(exportWriteSchema.safeParse({ dir: 'C:\\out', target: 'pick', files: {} }).success).toBe(false);
  });
});

describe('RecentFolders', () => {
  it('remembers the folder per dialog, falls back to the last one, and keeps them for the next start', () => {
    const store = tmp(), a = tmp(), b = tmp();
    const r = new RecentFolders(store);
    expect(r.folder('prg')).toBeUndefined();
    r.remember('prg', a);
    expect([r.folder('prg'), r.folder('disk')]).toEqual([a, a]);
    r.remember('disk', b);
    expect([r.folder('prg'), r.folder('disk'), r.folder('project')]).toEqual([a, b, b]);
    const again = new RecentFolders(store);
    expect([again.folder('prg'), again.folder('disk')]).toEqual([a, b]);
  });

  it('skips folders that are gone and survives a broken file', () => {
    const store = tmp(), a = tmp();
    const r = new RecentFolders(store);
    r.remember('prg', join(a, 'deleted'));
    expect(r.folder('prg')).toBeUndefined();
    writeFileSync(join(store, 'recent-folders.json'), '{ not json');
    expect(new RecentFolders(store).folder('prg')).toBeUndefined();
    writeFileSync(join(store, 'recent-folders.json'), JSON.stringify({ prg: 42 }));
    expect(new RecentFolders(store).folder('prg')).toBeUndefined();
  });
});

describe('settings from before the rename', () => {
  it('come along once from the old folder into the app\'s own, not into a profile of its own', () => {
    const appData = tmp(), old = join(appData, '@kickreasm', 'desktop'), now = join(appData, '@mimir', 'desktop');
    mkdirSync(join(old, 'Local Storage', 'leveldb'), { recursive: true });
    writeFileSync(join(old, 'settings.json'), '{"kickJar":"C:\\\\C64\\\\KickAss.jar"}');
    writeFileSync(join(old, 'recent-folders.json'), '{}');
    writeFileSync(join(old, 'Local Storage', 'leveldb', '000003.log'), 'ui');
    mkdirSync(join(old, 'Cache'));
    // a test's own profile is left alone
    expect(bringOldSettings(appData, join(appData, 'e2e-profile'), '@mimir/desktop')).toEqual([]);
    expect(bringOldSettings(appData, now, '@mimir/desktop')).toEqual(['settings.json', 'recent-folders.json', 'Local Storage']);
    expect(readFileSync(join(now, 'settings.json'), 'utf8')).toContain('KickAss.jar');
    expect(existsSync(join(now, 'Local Storage', 'leveldb', '000003.log'))).toBe(true);
    expect(existsSync(join(now, 'Cache'))).toBe(false);
    // once: what the app has saved since stays
    writeFileSync(join(now, 'settings.json'), '{}');
    expect(bringOldSettings(appData, now, '@mimir/desktop')).toEqual([]);
    expect(readFileSync(join(now, 'settings.json'), 'utf8')).toBe('{}');
  });
});

describe('project files', () => {
  it('round-trips a project through .mimir.json', async () => {
    const path = join(tmp(), 'demo.mimir.json');
    const p = { ...demoProject(), labels: { 0x0810: 'main' } };
    await writeProjectFile(path, p);
    const back = await readProjectFile(path);
    expect(back.files[0].bytes).toEqual(p.files[0].bytes);
    expect(back.labels).toEqual({ 2064: 'main' });
    expect(JSON.parse(readFileSync(path, 'utf8')).format).toBe('mimir-project');
  });

  it('opens a project saved before the rename (KickReasm Studio, .krproj.json), and saves it as Mimir Studio does', async () => {
    const dir = tmp(), path = join(dir, 'old.krproj.json');
    writeFileSync(path, JSON.stringify({ ...serializeProject({ ...demoProject(), name: 'old' }), format: LEGACY_PROJECT_FORMAT }));
    const back = await readProjectFile(path);
    expect(back.name).toBe('old');
    expect(back.format).toBe('mimir-project');
    await writeProjectFile(join(dir, 'old.mimir.json'), back);
    expect(JSON.parse(readFileSync(join(dir, 'old.mimir.json'), 'utf8')).format).toBe('mimir-project');
  });

  it('rejects files that are not projects', async () => {
    const path = join(tmp(), 'nope.json');
    writeFileSync(path, JSON.stringify({ hello: 1 }));
    await expect(readProjectFile(path)).rejects.toThrow(/not a Mimir project/);
  });

  it('opens PRGs and VICE snapshots, the snapshot as its RAM from $0200 with its entry points', async () => {
    const [snap, prg] = await readPrgFiles([join(__dirname, '../../../fixtures/vsf/raster-demo.vsf'), join(__dirname, '../../../fixtures/prg/raster-demo.prg')]);
    expect(snap).toMatchObject({ name: 'raster-demo.prg', load: 0x0200, entries: [0x08c7, 0x08b7], start: 0x0810, snapshot: 'VICE 3.10 snapshot of a C64SC, PC $08c7, $01 = $37' });
    expect(snap.bytes.length).toBe(0xfe00);
    expect(snap.id).toBeTruthy();
    expect(prg).toMatchObject({ name: 'raster-demo.prg', load: 0x0801 });
    expect(prg.entries).toBeUndefined();
    // the zero page and the stack too, when asked
    const [zp] = await readPrgFiles([join(__dirname, '../../../fixtures/vsf/raster-demo.vsf')], { zeroPage: true });
    expect(zp).toMatchObject({ load: 0x0002, start: 0x0810 });
    expect(zp.bytes.length).toBe(0xfffe);
    expect(prgOpenSchema.parse({ zeroPage: true })).toEqual({ zeroPage: true });
  });

  it('reads .d64 disk images and refuses anything else', async () => {
    const dir = tmp(), disk = join(dir, 'disk.d64'), big = join(dir, 'big.d64'), prg = join(dir, 'p.d64');
    writeFileSync(disk, makeD64({ name: 'test', files: [{ name: 'a', data: Uint8Array.from([1, 8, 0x60]) }] }));
    writeFileSync(big, new Uint8Array(300000));
    writeFileSync(prg, Uint8Array.from([1, 8, 0x60]));
    const r = await readDiskImage(disk);
    expect(r).toMatchObject({ path: disk, name: 'disk.d64' });
    expect(r.bytes.length).toBe(174848);
    await expect(readDiskImage(big)).rejects.toThrow(/big\.d64 is not a \.d64 disk image \(300000 bytes\)/);
    await expect(readDiskImage(prg)).rejects.toThrow(/not a \.d64 disk image: 3 bytes/);
  });
});

const jar = process.env.KICKASS_JAR || findKickAssJar();
const javaOk = !!jar && spawnSync('java', ['-version'], { windowsHide: true }).status === 0;

/** the Exomizer the installer bundles (apps/desktop/vendor/exomizer), on Windows */
const vendorExo = process.platform === 'win32' && existsSync(join(__dirname, '..', 'vendor', 'exomizer', 'exomizer.exe')) ? join(__dirname, '..', 'vendor', 'exomizer', 'exomizer.exe') : null;

describe('toolchain runner', () => {
  it('reports a missing KickAss.jar as a problem instead of failing', async () => {
    const dir = tmp(); const policy = new PathPolicy(); policy.allow(dir);
    const r = await buildWithKickAssembler({ dir, entries: ['x.asm'] }, toolchain({ kickJar: join(dir, 'missing.jar') }), policy);
    expect(r.ok).toBe(false);
    expect(r.problems[0].message).toMatch(/KickAss\.jar not found/);
  });

  it('refuses folders outside the policy', async () => {
    await expect(buildWithKickAssembler({ dir: tmp(), entries: ['x.asm'] }, toolchain(), new PathPolicy())).rejects.toThrow(/outside the folders/);
  });

  it.skipIf(!javaOk)('builds the demo with the real KickAss.jar byte-identical', async () => {
    const p = demoProject();
    const A = analyze(p), R = render(A, p);
    const dir = tmp(); const policy = new PathPolicy(); policy.allow(dir);
    await writeVfs(dir, R.files);
    const r = await buildWithKickAssembler({ dir, entries: ['raster-demo.asm'] }, toolchain({ kickJar: jar! }), policy);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.commands[0]).toEqual(['java', '-jar', jar, 'raster-demo.asm', '-odir', 'out', '-vicesymbols', '-showmem']);
    expect(r.prg!.subarray(2)).toEqual(p.files[0].bytes);
    expect(r.outputs[0].vsPath).not.toBeNull();
  }, 60_000);

  it('needs an Exomizer that exists', async () => {
    const req = { files: [{ name: 'game.prg', prg: Uint8Array.of(1, 8, 0) }], prefs: DEFAULT_PACK };
    await expect(packWithExomizer(req, toolchain(), new PathPolicy())).rejects.toThrow(/No Exomizer is set/);
    await expect(packWithExomizer(req, toolchain({ exomizerPath: join(tmp(), 'exomizer.exe') }), new PathPolicy())).rejects.toThrow(/Exomizer not found/);
  });

  it.skipIf(!vendorExo)('packs the demo with the bundled Exomizer in a pack folder the session may run', async () => {
    const p = demoProject(), policy = new PathPolicy();
    const prg = Uint8Array.from([p.files[0].load & 0xff, p.files[0].load >> 8, ...p.files[0].bytes]);
    const r = await packWithExomizer({ files: [{ name: 'raster-demo.prg', prg }], prefs: DEFAULT_PACK }, toolchain({ exomizerPath: vendorExo! }), policy);
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, name: 'raster-demo-exo.prg', check: { status: 'same' } });
    expect(r.path).toBe(join(r.dir, 'raster-demo-exo.prg'));
    expect(readFileSync(r.path!)).toEqual(Buffer.from(r.prg!));
    expect(policy.isAllowed(r.path!)).toBe(true);
    expect(r.prg!.length).toBeLessThan(prg.length);
  });

  it.skipIf(!javaOk)('turns Kick Assembler errors into problems with file and line', async () => {
    const dir = tmp(); const policy = new PathPolicy(); policy.allow(dir);
    writeFileSync(join(dir, 'bad.asm'), '.pc = $1000 "Code"\n  lda unknown_label\n');
    const r = await buildWithKickAssembler({ dir, entries: ['bad.asm'] }, toolchain({ kickJar: jar! }), policy);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ severity: 'error', file: 'bad.asm', line: 2, column: 7, message: "Unknown symbol 'unknown_label'" }]);
  }, 60_000);
});



describe("VICE's character ROM (screens in the Graphics tab)", () => {
  it("is looked for in VICE's C64 folder beside its bin folder, then beside the program", () => {
    expect(charRomFiles(' ')).toEqual([]);
    const v = join('/v', 'bin', 'x64sc.exe');
    expect(charRomFiles(v)).toEqual([join('/v', 'C64', 'chargen-901225-01.bin'), join('/v', 'C64', 'chargen'), join('/v', 'bin', 'C64', 'chargen-901225-01.bin'), join('/v', 'bin', 'C64', 'chargen')]);
  });

  it('reads the first file that is 4 KB', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'C64'));
    const files = charRomFiles(join(dir, 'bin', 'x64sc.exe'));
    expect(await readCharRom(files)).toEqual({ found: false, path: files[0] });
    writeFileSync(join(dir, 'C64', 'chargen-901225-01.bin'), new Uint8Array(100));
    writeFileSync(join(dir, 'C64', 'chargen'), Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff));
    const r = await readCharRom(files);
    expect(r).toMatchObject({ found: true, path: files[1] });
    expect(r.found && [...r.bytes.subarray(0, 4)]).toEqual([0, 1, 2, 3]);
  });
});
