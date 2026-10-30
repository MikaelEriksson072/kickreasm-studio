/* The built-in unpacker, in a worker of its own. The C64 ROMs (and the 1541's DOS ROM) come from the user's VICE
 * through the main process; outside the desktop app, or without VICE, the unpacker runs with its stand-ins. */
import * as Comlink from 'comlink';
import type { UnpackRun } from '@mimir/core';
import type { UnpackApi } from '../workers/unpack.worker';

let remote: Comlink.Remote<UnpackApi> | null = null;

/** Unpack a PRG (load address first), with the D64 it came from in the drive. Runs queue up in the worker, one at a time. */
export async function unpackBuiltIn(prg: Uint8Array, disk: Uint8Array | null = null): Promise<UnpackRun> {
  if (!remote) remote = Comlink.wrap<UnpackApi>(new Worker(new URL('../workers/unpack.worker.ts', import.meta.url), { type: 'module', name: 'mimir-unpack' }));
  const roms = await (window.kr?.c64Roms() ?? Promise.resolve(null)).catch(() => null);
  return remote.unpack(prg, roms, disk);
}
