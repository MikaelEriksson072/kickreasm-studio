/* Toolchain settings (spec 13.1), stored as JSON in the user data folder. Only the main process
 * decides which executables run: the renderer can change them through settings:set, but the paths
 * are validated here and builds always read them from this store. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULT_SETTINGS, TOOLCHAIN_KEYS, type ToolchainSettings } from '@mimir/core';
import { findExomizer, findKickAssJar, findUnp64, findVice } from '@mimir/core/node';
import { toolchainSettingsSchema } from './schemas';

/** the unp64 the installer puts in resources\unp64 (vendor/unp64), or null: a development build has none */
export function bundledUnp64(resources: string | undefined = process.resourcesPath): string | null {
  if (!resources) return null;
  const exe = join(resources, 'unp64', process.platform === 'win32' ? 'unp64.exe' : 'unp64');
  return existsSync(exe) ? exe : null;
}

/** the Exomizer the installer puts in resources\exomizer (vendor/exomizer), or null */
export function bundledExomizer(resources: string | undefined = process.resourcesPath): string | null {
  if (!resources) return null;
  const exe = join(resources, 'exomizer', process.platform === 'win32' ? 'exomizer.exe' : 'exomizer');
  return existsSync(exe) ? exe : null;
}

const isUnp64 = (path: string) => /^unp64(\.exe)?$/i.test(basename(path));

export function defaultToolchainSettings(bundled: string | null = bundledUnp64(), bundledExo: string | null = bundledExomizer()): ToolchainSettings {
  const base = Object.fromEntries(TOOLCHAIN_KEYS.map(k => [k, DEFAULT_SETTINGS[k]])) as ToolchainSettings;
  if (!existsSync(base.kickJar)) base.kickJar = findKickAssJar() ?? base.kickJar;
  if (!existsSync(base.vicePath)) base.vicePath = findVice() ?? base.vicePath;
  if (!base.unpackerPath) base.unpackerPath = bundled ?? findUnp64() ?? '';
  if (!base.exomizerPath) base.exomizerPath = bundledExo ?? findExomizer() ?? '';
  return base;
}

export class SettingsStore {
  private readonly file: string;
  private value: ToolchainSettings;
  /** the bundled unp64 the unpacker setting was last pointed at (kept in settings.json as `bundledUnpacker`) */
  private bundledSeen: string | undefined;

  constructor(dir: string, defaults: () => ToolchainSettings = defaultToolchainSettings, bundled: string | null = bundledUnp64(), bundledExo: string | null = bundledExomizer()) {
    this.file = join(dir, 'settings.json');
    let stored: Partial<ToolchainSettings> = {}, raw: Record<string, unknown> = {};
    try {
      if (existsSync(this.file)) { raw = JSON.parse(readFileSync(this.file, 'utf8')); stored = toolchainSettingsSchema.partial().parse(raw); }
    } catch {
      stored = {}; raw = {}; // unreadable settings fall back to the defaults
    }
    this.value = { ...defaults(), ...stored };
    this.bundledSeen = typeof raw.bundledUnpacker === 'string' ? raw.bundledUnpacker : undefined;
    // A newly installed (or moved) bundled unp64 takes over, once, from an unpacker that is not set, no longer exists
    // or is another copy of unp64. After that the user's choice in Settings is kept, an empty one included.
    if (bundled && this.bundledSeen !== bundled) {
      const cur = this.value.unpackerPath;
      if (!cur || !existsSync(cur) || isUnp64(cur)) {
        // the arguments of another unpacker (exomizer's desfx, say) do not fit unp64
        if (!cur || !isUnp64(cur)) this.value.unpackerArgs = DEFAULT_SETTINGS.unpackerArgs;
        this.value.unpackerPath = bundled;
      }
      this.bundledSeen = bundled;
      if (existsSync(this.file)) this.write();
    }
    // Exomizer: settings from before it was a setting get the default (the bundled one); one that is gone (an
    // uninstalled or moved copy) gives way to the bundled one. A path the user cleared stays empty.
    if (bundledExo && this.value.exomizerPath && !existsSync(this.value.exomizerPath)) this.value.exomizerPath = bundledExo;
  }

  get(): ToolchainSettings {
    return { ...this.value };
  }

  set(patch: Partial<ToolchainSettings>): ToolchainSettings {
    const next = toolchainSettingsSchema.parse({ ...this.value, ...patch });
    this.value = next;
    this.write();
    return this.get();
  }

  private write(): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ ...this.value, ...(this.bundledSeen ? { bundledUnpacker: this.bundledSeen } : {}) }, null, 2));
  }
}
