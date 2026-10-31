/* @mimir/core — pure TypeScript, no DOM, no I/O. Runs in the analysis
 * worker, the renderer, Node tests and the CLI. Node-only helpers that
 * spawn the toolchain live in '@mimir/core/node'. */
export * from './types';
export { T, TYPE_INFO, TYPE_BY_KEY, MARK_AS, MARK_TYPE, DEFAULT_SETTINGS, TOOLCHAIN_KEYS, kindInfo, typeInfo } from './model';
export type { TypeGroup, TypeInfo, MarkAs } from './model';
export { h2, h4, $2, $4, word } from './util/hex';

export { OPC, ENC, MODE_LEN, KICK_ILLEGAL } from './cpu/opcodes';
export { undocumentedOpcode, undocumentedText, type UndocumentedInfo } from './cpu/undocumented';
export type { OpcodeInfo, AddrMode, Flow, Access } from './cpu/opcodes';
export { decode } from './cpu/decode';
export type { Decoded } from './cpu/decode';
export { branchTarget, cyclePath, cycleText, instructionCycles, type CycleBranch, type CyclePath, type Cycles, type CycleStep } from './cpu/cycles';

export { SYM, hwSymbol, isIO } from './c64/symbols';
export * from './c64/memconfig';
export { TEXT_ENCODINGS, textEncoding, type TextEncodingInfo } from './c64/text';
export { parseBasic, BASIC_TOKENS } from './c64/basic';
export { parsePrg, makePrg, overwritesSystemArea, SYSTEM_AREA } from './c64/prg';
export {
  clipRanges, findInMemory, loadedRanges, MAX_MATCHES, monitorChar, monitorHexOf, monitorLine, monitorPrefix, monitorRows, monitorText, monitorTextOf, MONITOR_ROW, parseMonitorCommand, petsciiToScreen,
  type FindAs, type MemoryMatch, type MonitorChar, type MonitorCommand, type MonitorMode, type MonitorRange, type MonitorRow,
} from './c64/monitor';
export { isVsf, openC64File, parseVsf, patchSnapshot, snapshotConfig, snapshotVicBank, SNAPSHOT_LOAD, SNAPSHOT_ZP_LOAD, type OpenedFile, type OpenOptions, type Snapshot, type VsfModule } from './c64/vsf';
export { d64FileName, makeD64, parseD64, petsciiName, readD64File, sectorsOnTrack, type D64File, type D64FileType, type D64Image } from './c64/d64';
export { readSpindleDisk, spinChunkName, spinScript, type SpindleChunk, type SpindleDisk, type SpindleJob } from './c64/spindle-disk';
export { BITFIRE_VERSION, bitfireFileName, d64writeScript, readBitfireDisk, unpackBitnax, unpackDali, type BitfireDisk, type BitfireFile, type BitfireFormat, type BitfireUnpacked } from './c64/bitfire-disk';
export { makePsid, parsePsid } from './c64/psid';
export { artStudioPicture, ART_STUDIO_LOAD, BITMAP_SIZE, gfxSource, koalaPicture, KOALA_LOAD, SCREEN_SIZE, type GfxFileColors, type GfxFileKind } from './c64/gfxfiles';
export type { PsidInfo } from './c64/psid';

export { analyze, findBlock } from './analyze';
export { spindleCondition, spindleLabel, spindleName, spindleRoutines, spindleScript } from './analyze/spindle';
export { render, validLabel, type RenderOptions } from './render/kick';
export { lineText, kickMnemonic, TOP_LEVEL_DIRECTIVES } from './render/lines';
export type { LineTextSettings } from './render/lines';
export { hardwareInclude } from './render/include';

export { assemble } from './verify/kick-subset-assembler';
export { verify, comparePrg } from './verify/verify';
export { parseKickOutput } from './verify/kick-output';

export { DEMO_FONT, makeDemo } from './demo';
export type { DemoProgram } from './demo';
export { makeShowcase, showcaseProject, type ShowcaseProgram } from './showcase';
export { FORMATTABLE, formatOverride, lineMove, markIdOf, mergeOverride, mergeRange, moveBlockKeys, moveBytes, type BlockMerge, type ByteMove, type RangeMerge } from './edit';
export { createProject, demoProject, serializeProject, deserializeProject, projectNameFor, withId, newId, b64enc, b64dec } from './project';
export { buildScripts, BUILD_SCRIPTS, readme, projectScripts, projectTextFiles, exportFiles } from './export';
export { applyPatch, assemblePatch, patchAt, patchEnd, patchesOn, patchFileName, patchPrg, patchSource, planPatch, revertPatch, straightCycles, switchPatch, unpatchedFiles, withPatch, withoutPatch, type PatchCode, type PatchError, type PatchLine, type PatchPlan, type PatchRequest, type PatchTime } from './patch';
export { NOTES_FILE, NOTES_TEXT_FILE, notesDocument, notesExport, notesFile, notesFor, notesText, lineHtml } from './notes-doc';
export { detectPacking, packerSignature, type PackingInfo } from './packing';
export { conclusive, depackers, depackerText, packerNames, unpackLog, unpackPrg, unpackSummary, type LayerReport, type Roms, type UnpackRun } from './sindri';
export { brokkrArgs, brokkrCommandText, crunchHere, packWithBrokkr, type BrokkrCrunch, type BrokkrPack } from './brokkr';
export {
  checkDecrunched, DEFAULT_PACK, editRanges, extraProblem, mergeRanges, packArgs, packEffective, packFileName, packImage, packInputs, packOptions, packOutName, packParts, packProblem,
  parseExomizer, rangeCover, shellWord, type ExomizerArea, type ExomizerReport, type PackCheck, type PackFile, type PackPart,
} from './pack';
export { splitArgs } from './util/args';
