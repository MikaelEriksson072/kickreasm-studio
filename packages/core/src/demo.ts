/* =====================================================================
 * Demo program — built from source with the verifier's assembler so the
 * first launch shows a realistic, fully analysable PRG.
 * ===================================================================== */
import { assemble } from './verify/kick-subset-assembler';
import { h2 } from './util/hex';

export interface DemoProgram { name: string; prg: Uint8Array; source: string }

/** The demo's blocky 8x8 font (hex rows per character), also used by the showcase. */
export const DEMO_FONT: Record<string, string> = {
  '@': '7cc6dededcc07c00', A: '7cc6c6fec6c6c600', B: 'fcc6c6fcc6c6fc00', C: '7cc6c0c0c0c67c00', D: 'f8ccc6c6c6ccf800',
  E: 'fec0c0fcc0c0fe00', F: 'fec0c0fcc0c0c000', G: '7cc6c0cec6c67e00', H: 'c6c6c6fec6c6c600', I: '7830303030307800',
  J: '1e060606c6c67c00', K: 'c6ccd8f0d8ccc600', L: 'c0c0c0c0c0c0fe00', M: 'c6eefed6c6c6c600', N: 'c6e6f6decec6c600',
  O: '7cc6c6c6c6c67c00', P: 'fcc6c6fcc0c0c000', Q: '7cc6c6c6d6cc7600', R: 'fcc6c6fcd8ccc600', S: '7cc6c07c06c67c00',
  T: 'fe30303030303000', U: 'c6c6c6c6c6c67c00', V: 'c6c6c6c66c381000', W: 'c6c6c6d6feeec600', X: 'c66c3838386cc600',
  Y: 'cccccc7830303000', Z: 'fe0c183060c0fe00', ' ': '0000000000000000', '!': '3030303030003000', "'": '3030600000000000',
  '+': '003030fc30300000', ',': '0000000030306000', '-': '000000fe00000000', '.': '0000000000303000', ':': '0030300030300000',
  '=': '0000fe00fe000000', '?': '7cc60c1830003000', 0: '7ccedef6e6c67c00', 1: '307030303030fc00', 2: '7cc6061c70c0fe00',
  3: '7cc6063c06c67c00', 4: '1c3c6cccfe0c0c00', 5: 'fec0fc0606c67c00', 6: '7cc0fcc6c6c67c00', 7: 'fe060c1830303000',
  8: '7cc6c67cc6c67c00', 9: '7cc6c67e06067c00',
};

export function makeDemo(): DemoProgram {
  const rows = (arr: number[], n = 16) => { const out: string[] = []; for (let i = 0; i < arr.length; i += n) out.push('.byte ' + arr.slice(i, i + n).map(v => '$' + h2(v)).join(',')); return out.join('\n'); };
  const sine = Array.from({ length: 256 }, (_, i) => Math.round(172 + 80 * Math.sin(2 * Math.PI * i / 256)));
  const notes = Array.from({ length: 24 }, (_, i) => Math.round(130.81 * Math.pow(2, i / 12) * 16777216 / 985248));
  const song = [1, 5, 8, 13, 8, 5, 1, 5, 3, 7, 10, 15, 10, 7, 3, 7, 6, 10, 13, 18, 13, 10, 6, 10, 8, 12, 15, 20, 15, 12, 8, 12, 0];
  const ball = [
    '.........######.........', '......############......', '....################....', '...##################...',
    '..########..##########..', '..#######....#########..', '.########....##########.', '.#########..###########.',
    '.######################.', '########################', '########################', '########################',
    '.######################.', '.######################.', '.######################.', '..####################..',
    '..####################..', '...##################...', '....################....', '......############......',
    '.........######.........'];
  const sprite: number[] = [];
  for (const r of ball) for (let b = 0; b < 3; b++) sprite.push(parseInt(r.slice(b * 8, b * 8 + 8).replace(/#/g, '1').replace(/\./g, '0'), 2));
  sprite.push(0);
  // a small blocky font designed for the demo (screen-code order), then generated pattern tiles
  const G = DEMO_FONT;
  const sc = (c: string) => c === '@' ? 0 : c >= 'A' && c <= 'Z' ? c.charCodeAt(0) - 64 : c.charCodeAt(0);
  const charset: number[] = new Array(2048).fill(0);
  for (const [c, hex] of Object.entries(G)) for (let i = 0; i < 8; i++) charset[sc(String(c)) * 8 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  for (let ch = 0; ch < 64; ch++) for (let y = 0; y < 8; y++) {
    let v = 0;
    for (let x = 0; x < 8; x++) {
      const kind = ch >> 4, lvl = ch & 15;
      const on = kind === 0 ? bayer[y & 3][x & 3] < lvl : kind === 1 ? ((x + y + lvl) & 7) < 3 : kind === 2 ? (7 - y) < (lvl >> 1) : ((x - 3.5) ** 2 + (y - 3.5) ** 2) < (lvl / 15) * 18;
      if (on) v |= 0x80 >> x;
    }
    charset[(0x40 + ch) * 8 + y] = v;
  }
  for (let i = 0; i < 1024; i++) charset[1024 + i] = charset[i] ^ 0xff;
  const src = `
.pc = $0801 "Basic"
.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$34,$00,$00,$00
.pc = $0810 "Code"
start:
  jsr $e544
  jsr init_screen
  sei // after init_screen: the KERNAL text output ($ffd2) ends with CLI
  lda #$00
  jsr $1000
  lda #$7f
  sta $dc0d
  sta $dd0d
  lda $dc0d
  lda $dd0d
  lda #$01
  sta $d01a
  lda #$1b
  sta $d011
  lda #$62 // raster bars in the empty rows below the title
  sta $d012
  lda #<irq_top
  sta $0314
  lda #>irq_top
  sta $0315
  lda #$80
  sta $07f8
  lda #$01
  sta $d015
  lda #$07
  sta $d027
  lda #$90
  sta $d001
  lda #$1c
  sta $d018
  jsr border_red
  jsr border_blue
  cli
  jmp *
init_screen:
  lda #$00
  sta $d020
  sta $d021
  ldx #$00
is_col:
  lda #$0e
  sta $d800,x
  sta $d900,x
  sta $da00,x
  sta $dae8,x
  inx
  bne is_col
  lda #<title
  ldy #>title
  jsr $ab1e
  ldx #$00
is_msg:
  lda message,x
  beq is_scroll
  jsr $ffd2
  inx
  bne is_msg
is_scroll:
  ldx #$00
is_s2:
  lda scrolltext,x
  beq is_bar
  sta $05e0,x
  inx
  bne is_s2
is_bar:
  ldx #$27
is_b2:
  txa
  ora #$40
  sta $0658,x
  dex
  bpl is_b2
  rts
border_red:
  lda #$02
  .byte $2c
border_blue:
  lda #$06
  sta $d020
  rts
irq_top:
  inc $d019
  ldy #$00
bars:
  lda colors,y
  ldx $d012
bars_w:
  cpx $d012
  beq bars_w
  sta $d020
  sta $d021
  iny
  cpy #$10
  bne bars
  lda #$00
  sta $d020
  sta $d021
  ldx sine_pos
  lda sine,x
  sta $d000
  inc sine_pos
  lax frame
  sax temp
  dcp countdown
smc_color:
  lda #$00
  sta $d027
  inc smc_color+1
  lda frame
  lsr
  lsr
  lsr
  and #$03
  tax
  lda fx_lo,x
  sta $fb
  lda fx_hi,x
  sta $fc
  jsr call_fx
  inc frame
  jsr $1003
  jmp $ea31
call_fx:
  jmp ($00fb)
fx_none:
  rts
fx_spin:
  inc $0427
  rts
fx_flash:
  lda $d41b
  and #$0f
  sta $dbe7
  rts
fx_key:
  lda $c5
  sta $0426
  rts
sine_pos: .byte $00
frame: .byte $00
temp: .byte $00
countdown: .byte $ff
fx_lo: .byte <fx_none,<fx_spin,<fx_flash,<fx_key
fx_hi: .byte >fx_none,>fx_spin,>fx_flash,>fx_key
colors: .byte $06,$0e,$03,$01,$03,$0e,$06,$00,$09,$08,$07,$01,$07,$08,$09,$00
.encoding "petscii_upper"
title: .text "MIMIR STUDIO DEMO    "
.byte $0d,$00
message: .text "RE-ASSEMBLE ME INTO KICK ASSEMBLER!"
.byte $0d,$00
.encoding "screencode_upper"
// 40 characters per screen row: the text breaks after "DEMO!"
scrolltext: .text "HELLO FROM THE MIMIR STUDIO DEMO!       ENJOY!!"
.byte $00
sine:
${rows(sine)}
.pc = $1000 "Music"
  jmp m_init
  jmp m_play
m_init:
  ldx #$18
  lda #$00
mi_clr:
  sta $d400,x
  dex
  bpl mi_clr
  lda #$0f
  sta $d418
  lda #$00
  sta m_pos
  sta m_timer
  lda #$09
  sta $d405
  lda #$a0
  sta $d406
  rts
m_play:
  dec m_timer
  bpl m_done
  lda #$06
  sta m_timer
  ldx m_pos
  lda song,x
  bne m_note
  ldx #$00
  stx m_pos
  lda song
m_note:
  tay
  lda freq_lo,y
  sta $d400
  lda freq_hi,y
  sta $d401
  lda #$20
  sta $d404
  lda #$21
  sta $d404
  inc m_pos
m_done:
  rts
m_timer: .byte $00
m_pos: .byte $00
song:
${rows(song)}
freq_lo:
${rows(notes.map(v => v & 0xff))}
freq_hi:
${rows(notes.map(v => v >> 8))}
.pc = $2000 "Sprite"
${rows(sprite, 3)}
.pc = $3000 "Charset"
${rows(charset, 16)}
`;
  const r = assemble({ 'demo.asm': src }, 'demo.asm');
  if (r.errors.length || !r.prg) throw new Error('demo build failed: ' + r.errors.map(e => `${e.line}: ${e.msg}`).join('; '));
  return { name: 'raster-demo.prg', prg: r.prg, source: src };
}
