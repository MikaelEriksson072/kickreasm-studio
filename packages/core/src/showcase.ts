/* =====================================================================
 * The showcase: a small intro built from source with the verifier's assembler (like makeDemo), and the project the
 * app's Demo opens. In VICE it shows a multicolor bitmap logo in VIC bank 1 above a text screen in bank 0, raster
 * bars in both borders, eight multicolor sprites moving three ways, a colour wash, a smooth scroller and three-voice
 * music. It holds one of every block type the analysis finds: BASIC, code, text (PETSCII and screen codes), bytes,
 * words, tables (colours and curves), lo/hi tables, sprites, a charset, a bitmap, a screen matrix, music and fill. It
 * has what else the analysis looks for, too: raster and NMI handlers, a word jump table, self-modifying code, the BIT
 * skip, undocumented opcodes, zero-page pointers, KERNAL calls and VIC bank switching.
 * ===================================================================== */
import { assemble } from './verify/kick-subset-assembler';
import { DEMO_FONT, type DemoProgram } from './demo';
import { parsePrg } from './c64/prg';
import { createProject } from './project';
import type { Addr, Bookmark, Note, Project, Settings } from './types';
import { h2 } from './util/hex';

const rows = (arr: readonly number[], n = 16) => {
  const out: string[] = [];
  for (let i = 0; i < arr.length; i += n) out.push('.byte ' + arr.slice(i, i + n).map(v => '$' + h2(v)).join(','));
  return out.join('\n');
};

/** The font for the text screen: the demo's letters, digits and signs (and `/`), their inverse from $80. */
function charset(): number[] {
  const font: Record<string, string> = { ...DEMO_FONT, '/': '02060c183060c000', '*': '006c38fe386c0000' };
  const sc = (c: string) => (c === '@' ? 0 : c >= 'A' && c <= 'Z' ? c.charCodeAt(0) - 64 : c.charCodeAt(0));
  const out = new Array<number>(2048).fill(0);
  for (const [c, hex] of Object.entries(font)) for (let i = 0; i < 8; i++) out[sc(c) * 8 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  for (let i = 0; i < 1024; i++) out[1024 + i] = out[i] ^ 0xff;
  return out;
}

/** The logo: "MIMIR" in the demo font as a multicolor bitmap of 160 x 64 pixels (8 character rows), a white top
 *  and an outline from the screen matrix ($61: %01 blue, %10 white), the faces from colour RAM. */
function logo(): { bitmap: number[]; screen: number[]; colors: number[] } {
  const W = 160, H = 64, text = 'MIMIR', sx = 3, sy = 5, x0 = (W - text.length * 8 * sx) / 2, y0 = 10;
  const face = new Uint8Array(W * H);
  [...text].forEach((c, i) => {
    const g = DEMO_FONT[c];
    for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 8; gx++) {
      if (!((parseInt(g.slice(gy * 2, gy * 2 + 2), 16) >> (7 - gx)) & 1)) continue;
      for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) face[(y0 + gy * sy + dy) * W + x0 + i * 8 * sx + gx * sx + dx] = 1;
    }
  });
  const px = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (face[y * W + x]) { px[y * W + x] = y - y0 < 9 ? 2 : 3; continue; }
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < W && yy >= 0 && yy < H && face[yy * W + xx]) { near = true; break; }
    }
    if (near) px[y * W + x] = 1;
  }
  const bitmap: number[] = [];
  for (let row = 0; row < 8; row++) for (let col = 0; col < 40; col++) for (let line = 0; line < 8; line++) {
    let v = 0;
    for (let i = 0; i < 4; i++) v |= px[(row * 8 + line) * W + col * 4 + i] << (6 - i * 2);
    bitmap.push(v);
  }
  const screen = new Array<number>(320).fill(0x61);
  // the faces: each letter its own colour, light in the upper rows and dark below; the last row is black (0 and 8:
  // black in both text modes while the raster IRQ switches modes there)
  const shade = [[10, 2], [8, 9], [7, 8], [13, 5], [3, 14], [14, 4], [15, 12], [10, 4], [7, 8]];
  const colors: number[] = [];
  for (let row = 0; row < 8; row++) for (let col = 0; col < 40; col++) {
    const letter = shade[Math.min(8, Math.max(0, (col - 2) >> 2))];
    colors.push(row === 7 ? (col & 1) * 8 : letter[row <= 2 ? 0 : 1]);
  }
  return { bitmap, screen, colors };
}

/** Four frames of a shaded multicolor ball (12 x 21): %01 the rim ($d025), %10 its own colour, %11 the highlight
 *  ($d026), which goes round from frame to frame. */
function balls(): number[] {
  const out: number[] = [];
  for (let f = 0; f < 4; f++) {
    const a = Math.PI * 1.25 + f * Math.PI / 2;
    const hx = 6 + 2.4 * Math.cos(a), hy = 10.5 + 4.2 * Math.sin(a);
    for (let y = 0; y < 21; y++) for (let b = 0; b < 3; b++) {
      let v = 0;
      for (let i = 0; i < 4; i++) {
        const x = b * 4 + i + 0.5, cy = y + 0.5;
        const r = Math.hypot((x - 6) / 6, (cy - 10.5) / 10.5);
        const c = r > 1 ? 0 : Math.hypot((x - hx) / 6, (cy - hy) / 10.5) < 0.3 ? 3 : r > 0.8 ? 1 : 2;
        v |= c << (6 - i * 2);
      }
      out.push(v);
    }
    out.push(0);
  }
  return out;
}

/** Raster bars: eight bars of sixteen lines, each a gradient to its brightest colour and back, sixteen black lines between. */
function bars(): number[] {
  const shades = [[6, 14, 3, 1], [2, 10, 7, 1], [5, 13, 15, 1], [4, 10, 15, 1], [9, 8, 7, 1], [11, 12, 15, 1], [6, 4, 14, 1], [2, 8, 10, 1]];
  const out: number[] = [];
  for (const s of shades) {
    const up = [s[0], s[0], s[1], s[1], s[2], s[2], s[3], s[3]];
    out.push(...up, ...[...up].reverse(), ...new Array(16).fill(0));
  }
  return out;
}

/** PAL SID frequencies for MIDI notes 24 (C1) to 95 (B6): the tune's notes are indexes into it (MIDI - 24). */
const NOTES = Array.from({ length: 72 }, (_, i) => Math.round(440 * Math.pow(2, (i + 24 - 69) / 12) * 16777216 / 985248));
const n = (midi: number) => midi - 24;
/** The tune: Am F C G, a bar each. The lead's 0 holds the note, 1 lets it go. */
const LEAD = [
  76, 0, 0, 74, 72, 0, 69, 0, 72, 0, 74, 0, 76, 0, 0, 1,
  77, 0, 76, 0, 72, 0, 0, 1, 69, 0, 72, 0, 0, 0, 1, 0,
  79, 0, 0, 76, 0, 0, 72, 0, 76, 0, 79, 0, 81, 0, 0, 1,
  79, 0, 74, 0, 71, 0, 0, 1, 74, 0, 0, 0, 67, 0, 1, 0,
].map(v => (v > 1 ? n(v) : v));
const ROOTS = [45, 41, 48, 43].map(n);
const BASS = [0, 0xff, 0xff, 12, 0xff, 0xff, 0, 0xff, 12, 0xff, 0, 0xff, 7, 0xff, 12, 0xff];
const CHORDS = [[69, 72, 76], [65, 69, 72], [72, 76, 79], [67, 71, 74]].flat().map(n);

/** 40 screen-code characters: the text, padded with spaces (centred when `center`). */
const line40 = (s: string, center = true) => {
  if (s.length > 40) throw new Error(`showcase line longer than 40: "${s}"`);
  const pad = center ? Math.floor((40 - s.length) / 2) : 0;
  return (' '.repeat(pad) + s).padEnd(40);
};

const SCROLL = 'WELCOME TO THE NEW MIMIR STUDIO SHOWCASE!   EVERYTHING HERE IS ONE PRG: A MULTICOLOR BITMAP LOGO IN VIC BANK 1, '
  + 'A TEXT SCREEN IN BANK 0, EIGHT SPRITES, RASTER BARS IN BOTH BORDERS AND THREE-VOICE MUSIC.   OPEN IT IN THE MIMIR STUDIO, '
  + 'RENAME THE LABELS, MARK THE BLOCKS AND EXPORT A KICK ASSEMBLER PROJECT THAT BUILDS THE SAME BYTES...          ';

/** the showcase and the address of each label in its source */
export interface ShowcaseProgram extends DemoProgram { labels: Record<string, Addr> }

export function makeShowcase(): ShowcaseProgram {
  const sine = Array.from({ length: 256 }, (_, i) => Math.round(128 + 127 * Math.sin(2 * Math.PI * i / 256)));
  const bounce = Array.from({ length: 64 }, (_, i) => Math.round(70 * Math.abs(Math.sin(Math.PI * i / 64))));
  const wash = [1, 1, 7, 7, 15, 15, 10, 10, 8, 8, 2, 2, 9, 9, 2, 2, 8, 8, 10, 10, 15, 15, 7, 7, 1, 1, 13, 13, 3, 3, 14, 14];
  const scrollColors = Array.from({ length: 40 }, (_, i) => [11, 12, 15, 1][Math.min(3, Math.min(i, 39 - i) >> 1)]);
  const L = logo();
  const src = `
.pc = $0801 "Basic"
.byte $0b,$08,$ea,$07,$9e,$32,$30,$36,$34,$00,$00,$00
.pc = $0810 "Code"
start:
  jsr $e544
  lda #$00
  sta $d020
  sta $d021
  sta $d022
  sta $d023
  jsr setup_screen
  sei // after setup_screen: the KERNAL text output ends with CLI
  lda #$7f
  sta $dc0d
  sta $dd0d
  lda $dc0d
  lda $dd0d
  lda #$00
  jsr $1800
  jsr setup_sprites
  lda #<irq_top
  sta $0314
  lda #>irq_top
  sta $0315
  lda #<nmi
  sta $0318
  lda #>nmi
  sta $0319
  lda #$1b
  sta $d011
  lda #$14
  sta $d012
  lda #$01
  sta $d01a
  sta $d019
  cli
main:
  jsr $ffe4
  cmp #$20
  bne main
  jsr next_fx
  jmp main
next_fx:
  ldx fx_index
  inx
  cpx #$03
  bcc nf_set
  ldx #$00
nf_set:
  stx fx_index
  rts
setup_screen:
  ldx #$00
ss_fill:
  lda #$0f
  sta $d800,x
  sta $d900,x
  sta $da00,x
  sta $db00,x
  inx
  bne ss_fill
ss_logo:
  lda logo_colors,x
  sta $d800,x
  inx
  bne ss_logo
  ldx #$3f
ss_logo2:
  lda logo_colors+256,x
  sta $d900,x
  dex
  bpl ss_logo2
  ldx #$09
  ldy #$07
  clc
  jsr $fff0
  lda #<title
  ldy #>title
  jsr $ab1e
  ldx #$00
ss_sub:
  lda subtitle,x
  beq ss_info
  jsr $ffd2
  inx
  bne ss_sub
ss_info:
  ldx #$27
ss_copy:
  lda info_1,x
  sta $05e0,x
  lda info_2,x
  sta $0608,x
  lda info_3,x
  sta $0630,x
  lda info_4,x
  sta $0658,x
  lda keys_text,x
  sta $0720,x
  lda scroll_colors,x
  sta $db98,x
  dex
  bpl ss_copy
  ldx #$03
ss_rows:
  lda crow_lo,x
  sta $fb
  lda crow_hi,x
  sta $fc
  lda info_colors,x
  ldy #$27
ss_row:
  sta ($fb),y
  dey
  bpl ss_row
  dex
  bpl ss_rows
  rts
setup_sprites:
  lda #$ff
  sta $d015
  sta $d01c
  sta $d01b
  lda #$00
  sta $d017
  sta $d01d
  sta $d010
  lda #$0b
  sta $d025
  lda #$01
  sta $d026
  ldx #$07
sp_col:
  lda sprite_colors,x
  sta $d027,x
  dex
  bpl sp_col
  lda #$80
  sta $07f8
  lda #$81
  sta $07f9
  lda #$82
  sta $07fa
  lda #$83
  sta $07fb
  rts
irq_top:
  inc $d019
  lda #$1c
  sta bar_lines
  ldx bar_pos
  ldy $d012
it_loop:
  lda bar_colors,x
  inx
it_wait:
  cpy $d012
  beq it_wait
  sta $d020
  ldy $d012
  dec bar_lines
  bne it_loop
  lda #$00
  sta $d020
top_bank:
  lda #$c6
  sta $dd00
  lda #$3b
  sta $d011
  lda #$18
  sta $d016
  lda #$80
  sta $d018
  lda #<irq_split
  sta $0314
  lda #>irq_split
  sta $0315
  lda #$71
  sta $d012
  jmp $ea81
irq_split:
  inc $d019
  lda #$1b
  sta $d011
split_bank:
  lda #$c7
  sta $dd00
  lda #$1a
  sta $d018
  lda #$08
  sta $d016
  jsr move_sprites
  jsr color_wash
  jsr scroll_text
  lda music_on
  beq is_quiet
  jsr $1803
is_quiet:
  lda #$00
  dcp countdown
  bne is_next
  jsr next_fx
is_next:
  inc frame
  lda #<irq_scroll
  sta $0314
  lda #>irq_scroll
  sta $0315
  lda #$e9
  sta $d012
  jmp $ea81
irq_scroll:
  inc $d019
  lda xscroll
  sta $d016
  lda #$28
  sta bar_lines
  ldx bar_pos
  lda #$fa
ib_line:
  cmp $d012
  bne ib_line
  ldy $d012
ib_loop:
  lda bar_colors,x
  dex
ib_wait:
  cpy $d012
  beq ib_wait
  sta $d020
  ldy $d012
  dec bar_lines
  bne ib_loop
  lda #$00
  sta $d020
  inc bar_pos
  lda #<irq_top
  sta $0314
  lda #>irq_top
  sta $0315
  lda #$14
  sta $d012
  jmp $ea31
nmi:
  pha
  lda music_on
  eor #$01
  sta music_on
  beq nmi_off
  jsr volume_up
  pla
  rti
nmi_off:
  jsr volume_off
  pla
  rti
volume_off:
  lda #$00
  .byte $2c
volume_up:
  lda #$0f
  sta $d418
  rts
move_sprites:
  lda fx_index
  asl
  tax
  lda fx_table,x
  sta fx_vector
  lda fx_table+1,x
  sta fx_vector+1
  lda frame
  lsr
  lsr
  sta temp
  ldx #$07
ms_frame:
  txa
  clc
  adc temp
  and #$03
  ora #$80
  sta $07f8,x
  dex
  bpl ms_frame
ms_jump:
  jmp (fx_vector)
fx_wave:
  ldx #$07
fw_loop:
  txa
  asl
  tay
  txa
  asl
  asl
  asl
  asl
  asl
  clc
  adc phase
  stx temp
  tax
  lda sine,x
  lsr
  lsr
  clc
  adc #$87
  sta $d001,y
  ldx temp
  lda sprite_x,x
  sta $d000,y
  dex
  bpl fw_loop
  inc phase
  inc phase
  rts
fx_circle:
  ldx #$07
fc_loop:
  txa
  asl
  tay
  txa
  asl
  asl
  asl
  asl
  asl
  clc
  adc phase
  stx temp
  tax
  lda sine,x
  lsr
  lsr
  clc
  adc #$88
  sta $d001,y
  txa
  clc
  adc #$40
  tax
  lda sine,x
  lsr
  clc
  adc #$54
  sta $d000,y
  ldx temp
  dex
  bpl fc_loop
  inc phase
  rts
fx_bounce:
  ldx #$07
fb_loop:
  txa
  asl
  tay
  txa
  asl
  asl
  asl
  clc
  adc phase
  and #$3f
  stx temp
  tax
  lda #$ce
  sec
  sbc bounce,x
  sta $d001,y
  ldx temp
  lda sprite_x,x
  sta $d000,y
  dex
  bpl fb_loop
  inc phase
  rts
color_wash:
  ldy wash_pos
  ldx #$27
cw_loop:
  lda wash_colors,y
  sta $db20,x
  iny
  tya
  and #$1f
  tay
  dex
  bpl cw_loop
  lax wash_pos
  inx
  txa
  and #$1f
  sta wash_pos
  rts
scroll_text:
  lda xscroll
  sec
  sbc #$02
  bcs st_keep
  and #$07
  sta xscroll
  ldx #$00
st_shift:
  lda $0799,x
  sta $0798,x
  inx
  cpx #$27
  bne st_shift
  ldy text_pos
st_char:
  lda scrolltext,y
  beq st_wrap
  sta $0798,x
  iny
  sty text_pos
  bne st_done
  inc st_char+2
st_done:
  rts
st_wrap:
  ldy #$00
  lda #>scrolltext
  sta st_char+2
  jmp st_char
st_keep:
  sta xscroll
  rts
fx_table: .word fx_wave, fx_circle, fx_bounce
frame: .byte $00
phase: .byte $00
temp: .byte $00
xscroll: .byte $07
wash_pos: .byte $00
bar_pos: .byte $00
bar_lines: .byte $00
fx_index: .byte $00
countdown: .byte $00
music_on: .byte $01
text_pos: .byte $00
fx_vector: .word fx_wave
sprite_x: .byte $30,$4c,$68,$84,$a0,$bc,$d8,$f4
sprite_colors: .byte $02,$08,$07,$05,$03,$0e,$04,$0a
info_colors: .byte $07,$0e,$0e,$0d
crow_lo: .byte <$d9e0,<$da08,<$da30,<$da58
crow_hi: .byte >$d9e0,>$da08,>$da30,>$da58
scroll_colors:
${rows(scrollColors, 20)}
wash_colors:
${rows(wash)}
sine:
${rows(sine)}
bounce:
${rows(bounce)}
bar_colors:
${rows(bars())}
logo_colors:
${rows(L.colors, 20)}
.encoding "petscii_upper"
title: .byte $9e
.text "THE MIMIR STUDIO "
.byte $05
.text "SHOWCASE"
.byte $0d,$00
subtitle: .byte $9b
.text "  PRG IN - KICK ASSEMBLER SOURCE OUT"
.byte $0d,$00
.encoding "screencode_upper"
info_1: .text "${line40('ONE OF EACH BLOCK THE ANALYSIS FINDS:')}"
info_2: .text "${line40('BASIC  CODE  TEXT  BYTES  WORDS  TABLES')}"
info_3: .text "${line40('LO/HI  SPRITES  CHARSET  BITMAP  SCREEN')}"
info_4: .text "${line40('MUSIC  AND  FILL')}"
keys_text: .text "${line40('SPACE: NEXT MOVE  *  RESTORE: MUSIC')}"
scrolltext: .text "${SCROLL}"
.byte $00
.pc = $1800 "Music"
  jmp m_init
  jmp m_play
m_init:
  ldx #$18
  lda #$00
mi_clear:
  sta $d400,x
  dex
  bpl mi_clear
  lda #$08
  sta $d403
  lda #$04
  sta $d40a
  lda #$08
  sta $d405
  lda #$a0
  sta $d40d
  lda #$0a
  sta $d413
  lda #$a9
  sta $d414
  lda #$0f
  sta $d418
  lda #$00
  sta m_step
  sta m_tick
  sta m_arp
  lda #$41
  sta $d40b
  rts
m_play:
  lda m_step
  lsr
  lsr
  lsr
  lsr
  and #$03
  sta m_bar
  asl
  adc m_bar
  adc m_arp
  tax
  ldy m_chords,x
  lda m_freq_lo,y
  sta $d407
  lda m_freq_hi,y
  sta $d408
  ldx m_arp
  inx
  cpx #$03
  bcc mp_arp
  ldx #$00
mp_arp:
  stx m_arp
  dec m_tick
  bpl mp_done
  lda #$05
  sta m_tick
  lda m_step
  and #$0f
  tax
  lda m_bass,x
  bmi mp_lead
  ldx m_bar
  clc
  adc m_roots,x
  tay
  lda m_freq_lo,y
  sta $d400
  lda m_freq_hi,y
  sta $d401
  lda #$40
  sta $d404
  lda #$41
  sta $d404
mp_lead:
  ldx m_step
  lda m_lead,x
  beq mp_next
  cmp #$01
  bne mp_note
  lda #$10
  sta $d412
  bne mp_next
mp_note:
  tay
  lda m_freq_lo,y
  sta $d40e
  lda m_freq_hi,y
  sta $d40f
  lda #$10
  sta $d412
  lda #$11
  sta $d412
mp_next:
  inx
  txa
  and #$3f
  sta m_step
mp_done:
  rts
m_tick: .byte $00
m_step: .byte $00
m_arp: .byte $00
m_bar: .byte $00
m_roots: .byte ${ROOTS.map(v => '$' + h2(v)).join(',')}
m_bass:
${rows(BASS)}
m_chords: .byte ${CHORDS.map(v => '$' + h2(v)).join(',')}
m_lead:
${rows(LEAD)}
m_freq_lo:
${rows(NOTES.map(v => v & 0xff), 12)}
m_freq_hi:
${rows(NOTES.map(v => v >> 8), 12)}
.pc = $2000 "Sprites"
${rows(balls(), 21)}
.pc = $2800 "Charset"
${rows(charset())}
.pc = $4000 "Logo bitmap"
${rows(L.bitmap)}
.pc = $6000 "Logo colours"
${rows(L.screen, 20)}
`;
  const r = assemble({ 'showcase.asm': src }, 'showcase.asm');
  if (r.errors.length || !r.prg) throw new Error('showcase build failed: ' + r.errors.map(e => `${e.line}: ${e.msg}`).join('; '));
  const labels = Object.fromEntries([...r.symbols].filter((e): e is [string, number] => typeof e[1] === 'number'));
  return { name: 'mimir-showcase.prg', prg: r.prg, source: src, labels };
}

/** names the project gives the main routines (the analysis would call them sub_xxxx, irq_xxxx, ptr_xxxx) */
const NAMED = ['next_fx', 'setup_screen', 'setup_sprites', 'irq_top', 'irq_split', 'irq_scroll', 'nmi', 'volume_off', 'volume_up',
  'move_sprites', 'fx_wave', 'fx_circle', 'fx_bounce', 'color_wash', 'scroll_text', 'fx_table', 'scrolltext'];

/** The tour: a bookmark per stop, in address order (F2 goes from one to the next). */
const TOUR: [string | Addr, string, string][] = [
  [0x0801, 'Welcome to the showcase', 'A small C64 intro with one block of every type the analysis finds. F2 goes to the next stop of this tour, '
    + 'Shift+F2 back, and Ctrl+B lists them all.\n\nF5 (Build & Run) assembles the source with KickAss.jar and starts it in VICE: SPACE '
    + 'changes how the balls move, RESTORE turns the music off and on. F7 checks that the source assembles to the same bytes.'],
  ['start', 'Start-up and KERNAL text', 'KERNAL and BASIC routines clear the screen and print the title ($ab1e) and the subtitle ($ffd2), '
    + 'so the analysis marks those bytes as PETSCII text. The info lines are screen codes copied to the screen. Then the music and the '
    + 'raster interrupts start.'],
  ['irq_top', 'Raster bars and VIC bank 1', 'Bars in the top border, then $dd00 = $c6 selects VIC bank 1 and $d011/$d018 a multicolor '
    + 'bitmap at $4000 with its colours at $6000. Following the memory configuration and VIC bank (Settings → Analysis) lets the '
    + 'analysis tell this $d018 from the one for the text below.'],
  ['irq_split', 'The split: text in bank 0', 'At line 113 the screen goes back to text in VIC bank 0, with the charset at $2800. '
    + 'Turn on Cycles in the listing toolbar to see what each instruction costs, and select a loop to count it.'],
  ['nmi', 'RESTORE and the BIT skip', 'The NMI vector at $0318 points here. volume_off and volume_up share one STA: the $2c byte is a '
    + 'BIT instruction that skips LDA #$0f.'],
  ['move_sprites', 'A jump table of words', 'move_sprites jumps through fx_vector to one of the three moves in fx_table. The analysis '
    + 'follows the .word table and traces all three routines.'],
  ['color_wash', 'Undocumented opcodes', 'LAX loads A and X at once here, and DCP counts down in the split IRQ. Settings → Analysis → '
    + 'Trace undocumented opcodes.'],
  ['scroll_text', 'Self-modifying code', 'The scroller steps through its text by changing the high byte of its own LDA (st_char). The '
    + 'listing marks the instruction that is written to.'],
  ['crow_lo', 'A lo/hi table', 'Colour RAM addresses of the info rows, split into a low and a high byte table and read into the '
    + 'zero-page pointer at $fb. Its .label line at the top of the listing has comments too.'],
  [0x1800, 'Music', 'JMP init / JMP play and three SID voices: bass, an arpeggio and a melody. The export writes it as '
    + 'music/music_1800.sid and loads it with LoadSid().'],
  [0x2000, 'Sprites', 'Four frames of a shaded multicolor ball. The Graphics tab shows them under Sprites, and the inspector '
    + 'previews the block.'],
  [0x2800, 'Charset', 'The font of the text screen. Graphics tab → Characters.'],
  [0x4000, 'Bitmap', 'The logo: eight character rows of a multicolor bitmap. Graphics tab → Bitmaps, with Multicolor on.'],
  [0x6000, 'Screen matrix', "The logo's two shared colours per cell: blue outline, white highlight. The faces come from colour RAM "
    + '(logo_colors).'],
  ['scrolltext', 'Screen codes and the Memory tab', "The scroller's text. The Memory tab shows memory as the VICE monitor does: type ii "
    + 'and an address to see screen codes as the C64 shows them. And the Pack view (the box) crunches the build with Exomizer.'],
];

/**
 * The project the app's Demo opens: the showcase with the tour in the Bookmarks view, names for its main routines,
 * the zero-page pointer and a few comments. All of it is the user's to change; none of it changes a byte.
 */
export function showcaseProject(settings?: Partial<Settings>): Project {
  const d = makeShowcase();
  const p = createProject({ name: 'mimir-showcase', files: [parsePrg(d.name, d.prg)], settings });
  const at = (l: string | Addr): Addr => {
    if (typeof l === 'number') return l;
    const a = d.labels[l];
    if (a == null) throw new Error(`showcase: no label ${l}`);
    return a;
  };
  for (const l of NAMED) p.labels[at(l)] = l;
  p.labels[0xfb] = 'row_ptr';
  p.bookmarks = Object.fromEntries(TOUR.map(([l, title, text]): [Addr, Bookmark] => [at(l), { title, text }]));
  p.comments = {
    0xfb: 'a colour RAM row of the info lines',
    [at('top_bank') + 2]: 'VIC bank 1: $4000-$7fff',
    [at('split_bank') + 2]: 'VIC bank 0 again',
    [at('ms_jump')]: 'to fx_wave, fx_circle or fx_bounce',
  };
  const notes: Record<Addr, Note> = {
    [at('irq_top')]: { text: 'line 20: bars in the top border, then the logo in VIC bank 1' },
    [at('irq_split')]: { text: 'line 113: text in bank 0, sprites, colours, scroller and music' },
    [at('irq_scroll')]: { text: "line 233: the scroller's fine scroll, then bars in the bottom border" },
    0xfb: { text: 'set by setup_screen from crow_lo/crow_hi' },
  };
  p.notes = notes;
  p.blockComments = { 0x4000: 'MIMIR in the demo font: 160 x 64 multicolor pixels', 0x1800: 'a three-voice tune: Am F C G' };
  return p;
}
