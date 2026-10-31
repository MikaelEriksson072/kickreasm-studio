/* 5.3b a cartridge's start (spec 13.9). In 8K and 16K mode the KERNAL's reset looks for "CBM80" at $8004 and jumps
 * through the cold start vector at $8000, and its NMI handler (RESTORE) through the warm start vector at $8002. In
 * Ultimax mode the cartridge's ROMH holds the CPU's own vectors at $fffa-$ffff: NMI, reset and IRQ. The vectors are a
 * word block, the signature text, and what they point at in the cartridge's chips is traced from. */
import type { Ctx } from './context';
import type { Addr, BlockProps, EntryKind } from '../types';
import { T } from '../model';
import { $4, word } from '../util/hex';

/** "CBM80" in PETSCII with shifted letters, as the KERNAL compares it ($fd10) */
const CBM80 = [0xc3, 0xc2, 0xcd, 0x38, 0x30];

/** A structure of the cartridge the analysis knows: its block, with the props and the reason it shows. */
export interface CartBlock { start: Addr; end: Addr; type: number; props: BlockProps; reason: string; label: string }

export interface CartStart {
  blocks: CartBlock[];
  /** what the vectors point at in the chips: the cold start (or reset) first */
  entries: { a: Addr; kind: EntryKind; name: string | null; what: string }[];
}

/** The cartridge's start vectors in the loaded chips, logged; null without a cartridge or without its vectors loaded. */
export function findCartStart(ctx: Ctx): CartStart | null {
  const { cart, mem, owner, files, L } = ctx;
  const chip = (a: Addr, n: number) => { for (let i = 0; i < n; i++) if (owner[a + i] < 0 || files[owner[a + i]].chip == null) return false; return true; };
  if (cart === '8k' || cart === '16k') {
    if (!chip(0x8000, 9)) return null;
    if (!CBM80.every((v, i) => mem[0x8004 + i] === v)) {
      L('info', `No "CBM80" at $8004: the KERNAL does not start this cartridge by itself (a BASIC extension, or one started with SYS). Set the program start if you know it.`, 0x8004, 'entry');
      return null;
    }
    const cold = word(mem, 0x8000), warm = word(mem, 0x8002);
    const entries: CartStart['entries'] = [{ a: cold, kind: 'entry', name: null, what: 'cold start (reset)' }];
    if (warm !== cold) entries.push({ a: warm, kind: 'nmi', name: 'warm_start', what: 'warm start (RESTORE)' });
    L('ok', `Cartridge: "CBM80" at $8004, cold start ${$4(cold)}, warm start ${$4(warm)}`, 0x8000, 'entry');
    return {
      blocks: [
        { start: 0x8000, end: 0x8004, type: T.WORDS, props: {}, reason: 'the cartridge\'s cold and warm start vectors: the KERNAL jumps through them at reset and on RESTORE', label: 'cart_vectors' },
        { start: 0x8004, end: 0x8009, type: T.TEXT, props: { enc: 'petscii-mixed' }, reason: 'the "CBM80" signature the KERNAL looks for at reset', label: 'cbm80' },
      ],
      entries,
    };
  }
  if (cart === 'ultimax') {
    if (!chip(0xfffa, 6)) return null;
    const nmi = word(mem, 0xfffa), reset = word(mem, 0xfffc), irq = word(mem, 0xfffe);
    const entries: CartStart['entries'] = [{ a: reset, kind: 'entry', name: null, what: 'reset' }];
    if (nmi !== reset) entries.push({ a: nmi, kind: 'nmi', name: null, what: 'NMI' });
    if (irq !== reset && irq !== nmi) entries.push({ a: irq, kind: 'irq', name: null, what: 'IRQ' });
    L('ok', `Ultimax cartridge: reset ${$4(reset)}, NMI ${$4(nmi)}, IRQ ${$4(irq)} (the CPU's vectors in its ROMH)`, 0xfffa, 'entry');
    return { blocks: [{ start: 0xfffa, end: 0x10000, type: T.WORDS, props: {}, reason: 'the CPU\'s NMI, reset and IRQ vectors in the cartridge\'s ROMH (Ultimax mode)', label: 'cpu_vectors' }], entries };
  }
  return null;
}
