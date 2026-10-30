/* Unpacker worker: the built-in unpacker (@mimir/unpacker) off the UI thread and apart from the analysis worker. A
 * run takes about 0.1 s, but one that never settles goes on to the unpacker's time limit, some seconds. */
import * as Comlink from 'comlink';
import { unpackPrg, type Roms, type UnpackRun } from '@mimir/core';

const api = {
  unpack(prg: Uint8Array, roms: Roms | null, disk: Uint8Array | null): UnpackRun {
    return unpackPrg(prg, roms, disk);
  },
};

export type UnpackApi = typeof api;
Comlink.expose(api);
