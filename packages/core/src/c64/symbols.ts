/* =====================================================================
 * C64 symbol database — VIC-II, SID, CIA 1/2, KERNAL, vectors, ZP
 * ===================================================================== */
import type { Addr, HwMatch, HwSymbol, SymbolRegion } from '../types';

export interface SymbolDb {
  exact: Map<Addr, HwSymbol>;
  regions: SymbolRegion[];
}

export const SYM: SymbolDb = (() => {
  const exact = new Map<Addr, HwSymbol>();
  const add = (addr: Addr, name: string, desc: string, cat: string, size = 1, call = false) => exact.set(addr, { addr, name, desc, cat, size, call });
  for (let i = 0; i < 8; i++) {
    add(0xd000 + i * 2, `VIC_SPR${i}_X`, `Sprite ${i} X position (bits 0-7)`, 'VIC-II');
    add(0xd001 + i * 2, `VIC_SPR${i}_Y`, `Sprite ${i} Y position`, 'VIC-II');
    add(0xd027 + i, `VIC_SPR${i}_COLOR`, `Sprite ${i} color`, 'VIC-II');
  }
  ([[0x10, 'SPR_X_MSB', 'Sprite X position bit 8 for all sprites'],
    [0x11, 'SCREEN_CTRL1', 'Control 1: Y-scroll, 25 rows, screen on, bitmap, ECM, raster bit 8'],
    [0x12, 'RASTER', 'Raster line (read) / raster IRQ compare line (write)'],
    [0x13, 'LIGHTPEN_X', 'Light pen X'], [0x14, 'LIGHTPEN_Y', 'Light pen Y'],
    [0x15, 'SPR_ENABLE', 'Sprite enable bits'],
    [0x16, 'SCREEN_CTRL2', 'Control 2: X-scroll, 40 columns, multicolor mode'],
    [0x17, 'SPR_EXPAND_Y', 'Sprite double height'],
    [0x18, 'MEM_SETUP', 'Memory setup: screen and charset/bitmap pointers'],
    [0x19, 'IRQ_STATUS', 'Interrupt status / acknowledge'],
    [0x1a, 'IRQ_ENABLE', 'Interrupt enable mask'],
    [0x1b, 'SPR_PRIORITY', 'Sprite to background priority'],
    [0x1c, 'SPR_MULTICOLOR', 'Sprite multicolor enable'],
    [0x1d, 'SPR_EXPAND_X', 'Sprite double width'],
    [0x1e, 'SPR_SPR_COLL', 'Sprite-sprite collision'],
    [0x1f, 'SPR_BG_COLL', 'Sprite-background collision'],
    [0x20, 'BORDER_COLOR', 'Border color'],
    [0x21, 'BG_COLOR0', 'Background color 0'], [0x22, 'BG_COLOR1', 'Background color 1'],
    [0x23, 'BG_COLOR2', 'Background color 2'], [0x24, 'BG_COLOR3', 'Background color 3'],
    [0x25, 'SPR_MC0', 'Sprite multicolor 0'], [0x26, 'SPR_MC1', 'Sprite multicolor 1'],
  ] as const).forEach(([o, n, d]) => add(0xd000 + o, 'VIC_' + n, d, 'VIC-II'));
  for (let v = 0; v < 3; v++) {
    const b = 0xd400 + v * 7, n = v + 1;
    add(b, `SID_V${n}_FREQ_LO`, `Voice ${n} frequency low`, 'SID');
    add(b + 1, `SID_V${n}_FREQ_HI`, `Voice ${n} frequency high`, 'SID');
    add(b + 2, `SID_V${n}_PW_LO`, `Voice ${n} pulse width low`, 'SID');
    add(b + 3, `SID_V${n}_PW_HI`, `Voice ${n} pulse width high`, 'SID');
    add(b + 4, `SID_V${n}_CTRL`, `Voice ${n} control: waveform, gate, sync, ring`, 'SID');
    add(b + 5, `SID_V${n}_AD`, `Voice ${n} attack/decay`, 'SID');
    add(b + 6, `SID_V${n}_SR`, `Voice ${n} sustain/release`, 'SID');
  }
  ([[0x15, 'FC_LO', 'Filter cutoff (bits 0-2)'], [0x16, 'FC_HI', 'Filter cutoff (bits 3-10)'],
    [0x17, 'RES_FILT', 'Filter resonance and voice routing'], [0x18, 'MODE_VOL', 'Filter mode and master volume'],
    [0x19, 'POT_X', 'Paddle X'], [0x1a, 'POT_Y', 'Paddle Y'],
    [0x1b, 'OSC3', 'Voice 3 oscillator output (random source)'], [0x1c, 'ENV3', 'Voice 3 envelope output'],
  ] as const).forEach(([o, n, d]) => add(0xd400 + o, 'SID_' + n, d, 'SID'));
  const cia = (base: Addr, n: number, pra: string, prb: string, icr: string) => ([
    [0, 'PRA', pra], [1, 'PRB', prb], [2, 'DDRA', 'Port A data direction'], [3, 'DDRB', 'Port B data direction'],
    [4, 'TA_LO', 'Timer A low'], [5, 'TA_HI', 'Timer A high'], [6, 'TB_LO', 'Timer B low'], [7, 'TB_HI', 'Timer B high'],
    [8, 'TOD_10TH', 'Time of day: 1/10 s'], [9, 'TOD_SEC', 'Time of day: seconds'], [10, 'TOD_MIN', 'Time of day: minutes'],
    [11, 'TOD_HR', 'Time of day: hours'], [12, 'SDR', 'Serial data register'], [13, 'ICR', icr],
    [14, 'CRA', 'Timer A control'], [15, 'CRB', 'Timer B control'],
  ] as const).forEach(([o, r, d]) => add(base + o, `CIA${n}_${r}`, d, `CIA ${n}`));
  cia(0xdc00, 1, 'Port A: keyboard columns / joystick 2', 'Port B: keyboard rows / joystick 1', 'Interrupt control and status (IRQ)');
  cia(0xdd00, 2, 'Port A: VIC bank (bits 0-1), serial bus', 'Port B: user port', 'Interrupt control and status (NMI)');
  ([[0xff81, 'CINT', 'Initialize screen editor and VIC'], [0xff84, 'IOINIT', 'Initialize I/O devices'],
    [0xff87, 'RAMTAS', 'RAM test and init'], [0xff8a, 'RESTOR', 'Restore default I/O vectors'],
    [0xff8d, 'VECTOR', 'Read/set I/O vectors'], [0xff90, 'SETMSG', 'Control KERNAL messages'],
    [0xff93, 'SECOND', 'Send secondary address after LISTEN'], [0xff96, 'TKSA', 'Send secondary address after TALK'],
    [0xff99, 'MEMTOP', 'Read/set top of memory'], [0xff9c, 'MEMBOT', 'Read/set bottom of memory'],
    [0xff9f, 'SCNKEY', 'Scan keyboard'], [0xffa2, 'SETTMO', 'Set IEEE timeout'],
    [0xffa5, 'ACPTR', 'Input byte from serial bus'], [0xffa8, 'CIOUT', 'Output byte to serial bus'],
    [0xffab, 'UNTLK', 'Send UNTALK'], [0xffae, 'UNLSN', 'Send UNLISTEN'], [0xffb1, 'LISTEN', 'Send LISTEN'],
    [0xffb4, 'TALK', 'Send TALK'], [0xffb7, 'READST', 'Read I/O status'], [0xffba, 'SETLFS', 'Set logical file parameters'],
    [0xffbd, 'SETNAM', 'Set file name (A=length, X/Y=address)'], [0xffc0, 'OPEN', 'Open logical file'],
    [0xffc3, 'CLOSE', 'Close logical file'], [0xffc6, 'CHKIN', 'Open channel for input'],
    [0xffc9, 'CHKOUT', 'Open channel for output'], [0xffcc, 'CLRCHN', 'Restore default I/O channels'],
    [0xffcf, 'CHRIN', 'Input character'], [0xffd2, 'CHROUT', 'Output character (PETSCII in A)'],
    [0xffd5, 'LOAD', 'Load file into memory'], [0xffd8, 'SAVE', 'Save memory to file'],
    [0xffdb, 'SETTIM', 'Set jiffy clock'], [0xffde, 'RDTIM', 'Read jiffy clock'], [0xffe1, 'STOP', 'Check STOP key'],
    [0xffe4, 'GETIN', 'Get character from keyboard buffer'], [0xffe7, 'CLALL', 'Close all files'],
    [0xffea, 'UDTIM', 'Update jiffy clock'], [0xffed, 'SCREEN', 'Return screen size'],
    [0xfff0, 'PLOT', 'Read/set cursor position'], [0xfff3, 'IOBASE', 'Return I/O base address'],
    [0xe544, 'CLRSCR', 'Clear screen and home cursor'], [0xe566, 'HOME', 'Cursor home'],
    [0xea31, 'IRQ_HANDLER', 'Default KERNAL IRQ handler (keyboard, jiffy clock)'],
    [0xea81, 'IRQ_EXIT', 'Restore registers and RTI'], [0xfce2, 'RESET', 'KERNAL cold start'],
    [0xfe43, 'NMI_ENTRY', 'KERNAL NMI entry'], [0xfebc, 'NMI_EXIT', 'Restore registers and RTI (NMI)'],
    [0xff48, 'IRQ_ENTRY', 'KERNAL IRQ/BRK entry'], [0xab1e, 'STROUT', 'BASIC: print null-terminated string at A/Y'],
    [0xbdcd, 'LINPRT', 'BASIC: print 16-bit integer in X/A'], [0xa474, 'READY', 'BASIC warm start (READY.)'],
  ] as const).forEach(([a, n, d]) => add(a, n, d, a >= 0xe000 ? 'KERNAL' : 'BASIC', 1, true));
  ([[0xfffa, 'NMI_VECTOR', 'Hardware NMI vector'], [0xfffc, 'RESET_VECTOR', 'Hardware reset vector'],
    [0xfffe, 'IRQ_VECTOR', 'Hardware IRQ/BRK vector']] as const).forEach(([a, n, d]) => add(a, n, d, 'Vectors', 2));
  ([[0x0314, 'CINV', 'IRQ vector (KERNAL)', 2], [0x0316, 'CBINV', 'BRK vector', 2], [0x0318, 'NMINV', 'NMI vector', 2],
    [0x031a, 'IOPEN', 'OPEN vector', 2], [0x0326, 'IBSOUT', 'CHROUT vector', 2], [0x0328, 'ISTOP', 'STOP vector', 2],
    [0x0300, 'IERROR', 'BASIC error vector', 2], [0x0302, 'IMAIN', 'BASIC warm start vector', 2],
    [0x0277, 'KEYD', 'Keyboard buffer', 10], [0x0286, 'COLOR', 'Current text color', 1],
    [0x0288, 'HIBASE', 'Screen page used by KERNAL', 1], [0x028a, 'RPTFLG', 'Key repeat mode', 1],
    [0x028d, 'SHFLAG', 'Shift/C=/CTRL key flags', 1], [0x0291, 'MODE', 'Shift+C= case switch enable', 1],
  ] as const).forEach(([a, n, d, s]) => add(a, n, d, 'System', s));
  ([[0x00, 'CPU_DDR', '6510 I/O data direction', 1], [0x01, 'CPU_PORT', '6510 port: memory configuration', 1],
    [0x2b, 'TXTTAB', 'Start of BASIC program', 2], [0x2d, 'VARTAB', 'Start of BASIC variables', 2],
    [0x90, 'STATUS', 'KERNAL I/O status', 1], [0xa0, 'TIME', 'Jiffy clock (3 bytes)', 3],
    [0xc5, 'LSTX', 'Matrix code of current key', 1], [0xc6, 'NDX', 'Keyboard buffer length', 1],
    [0xcb, 'SFDX', 'Key pressed (matrix)', 1], [0xcc, 'BLNSW', 'Cursor blink enable', 1],
    [0xd3, 'PNTR', 'Cursor column', 1], [0xd6, 'TBLX', 'Cursor row', 1],
  ] as const).forEach(([a, n, d, s]) => add(a, n, d, 'Zero page', s));
  add(0x07f8, 'SPRITE_PTRS', 'Sprite data pointers 0-7 (default screen)', 'Screen', 8);
  const regions: SymbolRegion[] = [
    { name: 'SCREEN_RAM', start: 0x0400, size: 1000, desc: 'Default screen matrix', cat: 'Screen', grid: true },
    { name: 'COLOR_RAM', start: 0xd800, size: 1000, desc: 'Color RAM', cat: 'Color RAM', grid: true },
  ];
  return { exact, regions };
})();

/** Hardware/ROM symbol for an address, or null. */
export function hwSymbol(addr: Addr): HwMatch | null {
  const s = SYM.exact.get(addr);
  if (s) return { sym: s, off: 0, text: s.name };
  for (let k = 1; k < 10; k++) {
    const b = SYM.exact.get(addr - k);
    if (b && b.size > k) return { sym: b, off: k, text: `${b.name}+${k}` };
  }
  const mirror = (base: Addr, _size: number, period: number): HwMatch | null => {
    const b = base + ((addr - base) % period); const t = SYM.exact.get(b);
    if (t && b !== addr) return { sym: t, off: addr - b, text: `${t.name}+$${(addr - b).toString(16)}`, mirror: true };
    return null;
  };
  if (addr >= 0xd000 && addr < 0xd400) return mirror(0xd000, 0x400, 0x40);
  if (addr >= 0xd400 && addr < 0xd800) return mirror(0xd400, 0x400, 0x20);
  if (addr >= 0xdc00 && addr < 0xdd00) return mirror(0xdc00, 0x100, 0x10);
  if (addr >= 0xdd00 && addr < 0xde00) return mirror(0xdd00, 0x100, 0x10);
  for (const r of SYM.regions) {
    if (addr >= r.start && addr < r.start + r.size) {
      const o = addr - r.start, row = Math.floor(o / 40), col = o % 40;
      const text = r.name + (row ? `+${row}*40` : '') + (col ? `+${col}` : '');
      return { sym: { name: r.name, desc: `${r.desc} — row ${row}, column ${col}`, cat: r.cat, addr: r.start }, off: o, text };
    }
  }
  return null;
}

export const isIO = (a: Addr): boolean => a >= 0xd000 && a < 0xe000;
