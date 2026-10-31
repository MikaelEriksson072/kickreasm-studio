/* Brokkr's API, without file-system access or threads (those are in ./node.ts). */
export { crunchData, PROFILES, type CrunchOptions, type Crunched, type CrunchStats, type Effort, type Profile } from './crunch.ts';
export { crunchSearch, localRunner, type Runner, type Job, type Task, type TaskResult } from './search.ts';
export { sfx, sfxAsync, findSys, ramFor, type SfxOptions, type SfxResult, type SfxFormat, type Area, type Start, type CrunchRequest } from './sfx.ts';
export {
  mem, memFile, memCrunchOptions, raw, rawFile, memBrk, memBrkFile, rawBrk, memFast, memFastFile, rawFast,
  type MemOptions, type MemResult, type MemBrkResult, type MemFastResult, type RawOptions, type RawResult,
} from './files.ts';
export { crunchBrk, type BrkCrunched, type BrkOptions } from './crunch-brk.ts';
export { readBrk, writeBrk, BrkError, type BrkDecoded } from './brk.ts';
export { brkDecrunchSource, BRK_ZP_BYTES } from './brk-decruncher.ts';
export { crunchFast, readFast, writeFast, FastError, type FastCrunched, type FastOptions, type FastDecoded } from './fast.ts';
export { fastDecrunchSource, FAST_ZP_BYTES } from './fast-decruncher.ts';
export { Disk, type DiskFile } from './d64.ts';
export { decrunchSource, ZP_BYTES } from './decruncher.ts';
export { assemble, AsmError, type Assembled } from './asm.ts';
export { Machine } from './emulate.ts';
export { BrokkrError } from './errors.ts';
export {
  P, T, DEFAULT_PROTOCOL, protocol, readStream, writeStream, encodingText, parseEncoding,
  type Protocol, type Encoding, type Decoded,
} from './format.ts';
