/* What the app reports about a packed file: detectPacking()'s verdict together with unp64 -i, when unp64 is the
 * unpacker. unp64 knows hundreds of packers by name, so a file it identifies is packed even when the heuristics
 * missed it, and its name replaces a guess from the file's text. */
import type { PackingInfo } from '@kickreasm/core';
import type { IdentifyResponse } from '../../shared/ipc';

export function withIdentified(h: PackingInfo | null, id: IdentifyResponse | undefined, file: { index: number; size: number; entry: number | null }, tool: string): PackingInfo | null {
  if (!id?.supported) return h;
  if (id.known && id.packer) {
    const base: PackingInfo = h ?? { file: file.index, verdict: 'packed', size: file.size, codeBytes: 0, entropy: 0, packedShare: 0, decruncher: file.entry, signature: null, reasons: [] };
    return { ...base, verdict: 'packed', signature: id.packer, reasons: [`${tool} identifies ${id.packer}`, ...base.reasons] };
  }
  // unp64 knows most packers: when it knows none here, weak signs alone are not worth a notice
  if (!h || h.verdict === 'maybe') return null;
  return { ...h, reasons: [...h.reasons, `${tool} does not know the packer`] };
}
