/* Mimir Studio was called KickReasm Studio before: its settings come along once, from that name's folder
 * (%APPDATA%\@kickreasm\desktop) into this one. The toolchain settings, the recent folders and the window's own
 * preferences (Local Storage), not the caches. */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OLD_FOLDER = ['@kickreasm', 'desktop'];
const KEPT = ['settings.json', 'recent-folders.json', 'Local Storage'];

/**
 * Copies the old settings into `userData` when it is the app's own folder (not a profile of its own, as the tests
 * give it) and has no settings yet. Returns what it copied.
 */
export function bringOldSettings(appData: string, userData: string, appName: string): string[] {
  if (resolve(userData) !== resolve(appData, appName)) return [];
  const from = join(appData, ...OLD_FOLDER);
  if (!existsSync(from) || existsSync(join(userData, 'settings.json'))) return [];
  mkdirSync(userData, { recursive: true });
  const copied: string[] = [];
  for (const f of KEPT) {
    if (!existsSync(join(from, f))) continue;
    cpSync(join(from, f), join(userData, f), { recursive: true, force: false });
    copied.push(f);
  }
  return copied;
}
