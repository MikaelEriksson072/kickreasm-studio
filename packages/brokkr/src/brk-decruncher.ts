/* The 6502 decruncher of Brokkr's own format (src/brk.ts), as Kick Assembler source, read and written backward as
 * the Exomizer one is (src/decruncher.ts). Its parts: the token loop from `next`, `gamma` for lengths, `put` for
 * bytes, and the arithmetic decoder (`get_bit`), whose bound comes from a multiply: quarter-square tables when
 * QSQ = 1 (1 KB of RAM, faster), shift and add otherwise. A self-extracting file runs the start (BRK_START) from
 * where it loaded, and keeps only the resident part (brkResident) while it decrunches. */

/** The zero page bytes the decruncher uses from ZP on. */
export const BRK_ZP_BYTES = 12;

const SYMBOLS = `.label RANGE = ZP                         // the coder's range, kept from $8000 up
.label CODE = ZP + 2                        // the stream's bits less the low end of the range
.label BITBUF = ZP + 4                      // the stream byte being read, with a 1 below its bits left
.label DEST = ZP + 5                        // the write page is DEST+1, its low byte is in Y (DEST stays 0)
.label SRC = ZP + 7                         // DEST plus the last match's offset
.label P = ZP + 9                           // the probability of the bit being decoded
.label BL = ZP + 10                         // the bound: range >> 8 times the probability
.label BH = ZP + 11
.label MISC = PROBS + 256                   // PROBS: the literal tree; MISC: the other contexts
`;

/** shift and add: BH:BL = RANGE+1 * P */
const MUL_SHIFT = `        lda #0
        ldx #8
        lsr P
mul_bit:
        bcc mul_add
        clc
        adc RANGE+1
mul_add:
        ror
        ror P
        dex
        bne mul_bit
        sta BH
        lda P
        sta BL
`;

/** quarter squares: a * b = f(a + b) - f(|a - b|), f(n) = n * n / 4 from tables at SQ (lo: SQ, SQ+256; hi: SQ+512, SQ+768) */
const MUL_QSQ = `        lda P
        clc
        adc RANGE+1
        tax
        bcs mul_high
        lda SQ,x
        sta BL
        lda SQ+512,x
        bcc mul_diff
mul_high:
        lda SQ+256,x
        sta BL
        lda SQ+768,x
mul_diff:
        sta BH
        lda RANGE+1
        sec
        sbc P
        bcs mul_pos
        eor #$ff
        adc #1
mul_pos:
        tax
        lda BL
        sec
        sbc SQ,x
        sta BL
        lda BH
        sbc SQ+512,x
        sta BH
`;

/** The resident part: the token loop from `next`, the decoder, and `done` where `exit` goes; `stream` holds the
 * address of the stream byte read last. */
const resident = (exit: string, qsq: boolean, streamAt: string) => `next:                                      // a literal or a match? (in the context of the token before)
        ldx prev
        jsr get_bit
        bcs match
        lda #>PROBS                         // a literal: 8 bits down the literal tree, X its node
        sta bit_load+2
        sta bit_store+2
        ldx #1
literal_bit:
        jsr get_bit
        txa
        rol
        tax
        bcc literal_bit
        ldx #>MISC
        stx bit_load+2
        stx bit_store+2
.if (EFFECT == 1) {
        sta $d020
}
        jsr put
        lsr prev
        bpl next

done:
${exit}
match:
        lda prev                            // right after a literal: the last offset again?
        bne match_new
        ldx #2
        jsr get_bit
        bcc match_new
        ldx #36                             // a rep: its length; SRC is still DEST plus the offset
        jsr gamma
        bcc copy
match_new:
        ldx #4
        jsr gamma
        lda length+1                        // the slot tree's contexts by the length: 1, 2 or more
        bne slot_class
        lda length
        cmp #3
        bcc slot_set
slot_class:
        lda #3
slot_set:
        asl
        asl
        asl
        asl
        asl
        adc #36
        sta slot_base+1
        lda #1
slot_bit:
        sta node
        clc
slot_base:
        adc #0
        tax
        jsr get_bit
        rol node
        lda node
        cmp #32
        bcc slot_bit
        and #31
        beq done                            // slot 0 ends the data
        tax                                 // the offset in SRC: a 1, then the slot's other bits from the top,
        lda #1                              // the first 4 in contexts of the slot, the others of their place
        sta SRC
        lsr
        sta SRC+1
        txa
        asl
        asl
        adc #164
        sta offset_ctx+1
        lda #4
        sta top
        dex
        beq offset_done
offset_bit:
        stx offset_left+1
        dec top
        bmi offset_low
offset_ctx:
        lda #0
        inc offset_ctx+1
        bne offset_in
offset_low:
        txa
        adc #231
offset_in:
        tax
        jsr get_bit
        rol SRC
        rol SRC+1
offset_left:
        ldx #0
        dex
        bne offset_bit
offset_done:
        lda SRC+1                           // SRC = DEST plus the offset
        clc
        adc DEST+1
        sta SRC+1
copy:
        ldx length                          // the low byte's count, then 256 for each in the high byte
        beq copy_byte
        inc length+1
copy_byte:
        lda (SRC),y
        sta (DEST),y
        tya
        beq copy_page
copy_next:
        dey
        dex
        bne copy_byte
        dec length+1
        bne copy_byte
        inx
        stx prev
        jmp next
copy_page:
        dec DEST+1
        dec SRC+1
        jmp copy_next

// a length into length (X its contexts): from 1, a 1 and a bit after it for each bit more, a 0; the carry clear
gamma:
        lda #1
        sta length
        lsr
        sta length+1
gamma_more:
        jsr get_bit
        bcc gamma_done
        inx
        jsr get_bit
        rol length
        rol length+1
        inx
        bne gamma_more
gamma_done:
        rts

// A to the next byte down
put:
        sta (DEST),y
        dey
        cpy #$ff
        bne put_done
        dec DEST+1
        dec SRC+1
put_done:
        rts

// a bit with the probability at X in the page bit_load and bit_store point at (MISC, or PROBS for the literal
// tree); the carry is the bit, X and Y kept
get_bit:
        bit RANGE+1                         // first the range from $8000 up, taking in the stream's next bits
        bmi bit_load
bit_renorm:
        asl BITBUF
        bne bit_in
        lda stream                          // the stream's next byte, backward
        bne stream_page
        dec stream+1
stream_page:
        dec stream
        .byte $ad                           // lda absolute, from stream
stream:
        .word ${streamAt}
        rol
        sta BITBUF
bit_in:
        rol CODE
        rol CODE+1
        asl RANGE
        rol RANGE+1
        bpl bit_renorm
bit_load:
        lda MISC,x
        sta P
        stx bit_x+1
        lsr                                 // p after a 1: p - p / 16 (after a 0: 15 more)
        lsr
        lsr
        lsr
        eor #$ff
        sec
        adc P
        pha
${qsq ? MUL_QSQ : MUL_SHIFT}        lda CODE                            // the code below the bound: a 0, the range becomes the bound
        sec
        sbc BL
        tax
        lda CODE+1
        sbc BH
        bcc bit_0
        sta CODE+1                          // else a 1: code and range lose the bound
        stx CODE
        lda RANGE
        sbc BL
        sta RANGE
        lda RANGE+1
        sbc BH
        sta RANGE+1
        bcs bit_p
bit_0:
        lda BL
        sta RANGE
        lda BH
        sta RANGE+1
bit_p:
        pla
        bcs bit_x
        adc #15
bit_x:
        ldx #0
bit_store:
        sta MISC,x
        rts

prev:   .byte 0                             // 1 after a match
node:   .byte 0
top:    .byte 0
length: .word 0
`;

/** the end of a self-extracting file's decrunching: $01, the interrupts, and the program's start */
const SFX_EXIT = `        lda #RAM_EXIT
        sta $01
.if (IRQ_EXIT == 1) {
        cli
}
.if (BASIC == 1) {
        lda #<BASIC_END                     // the variables start where the program ends
        sta $2d
        lda #>BASIC_END
        sta $2e
        jsr $a659                           // reset for RUN
        jsr $a533                           // link the lines
        jmp $a7ae                           // run
} else {
        jmp START
}
`;

/** The resident part of a self-extracting file (constants: ZP, PROBS (page-aligned, 512 bytes), SQ (with QSQ), EFFECT,
 * STREAM_END, RAM_EXIT, IRQ_EXIT, START, BASIC, BASIC_END). */
export const brkResident = (qsq: boolean): string => `${SYMBOLS}${resident(SFX_EXIT, qsq, 'STREAM_END - 2')}`;

/** the probabilities a half, the coder's range whole and its bit buffer empty, the quarter squares (QSQ) */
const INIT = `        lda #$80                            // every probability a half, and an empty bit buffer
        sta BITBUF
        ldx #0
probs_half:
        sta PROBS,x
        sta PROBS+256,x
        inx
        bne probs_half
        dex                                 // the coder's range: all of it
        stx RANGE
        stx RANGE+1
.if (QSQ == 1) {
        lda #0                              // f(n) = n * n / 4 for n up to 511: f(n + 1) = f(n) + (n + 1) / 2
        sta BL
        sta BH
        sta P
        tax
        ldy #2
squares:
        lda BL
squares_lo:
        sta SQ,x
        lda BH
squares_hi:
        sta SQ+512,x
        txa
        lsr
        bcc squares_even
        inc P
squares_even:
        lda BL
        clc
        adc P
        sta BL
        bcc squares_next
        inc BH
squares_next:
        inx
        bne squares
        inc squares_lo+2
        inc squares_hi+2
        dey
        bne squares
}
`;

/** DEST and Y at the byte before DATA_END (in A, high, and on the stack, low), SRC at the one after: the last offset 1 */
const DEST_SET = `        sta DEST+1
        sta SRC+1
        pla
        tay
        bne dest_page
        dec DEST+1
        dec SRC+1
dest_page:
        dey
        lda #0
        sta DEST
        lda #1
        sta SRC
`;

/** The decruncher for mem files of Brokkr's own format, for Kick Assembler, with its constants. */
export function brkDecrunchSource(o: { zp?: number; table?: number; small?: boolean; effect?: boolean; at?: number } = {}): string {
  const hex = (v: number) => `$${v.toString(16).padStart(v > 0xff ? 4 : 2, '0')}`;
  const table = o.table ?? 0xc000;
  if (table & 0xff) throw new Error('The table address must be at the start of a page.');
  return `// Brokkr's decruncher for its own format, read and written backward. Kick Assembler source. Crunch with
// \`brokkr mem --format brokkr\`; set \`stream\` to the address after the crunched data's last byte, then jsr decrunch.
// It does not change $01 or the interrupt flag, and it takes up to 9 bytes of stack.
// The constants: change them to suit your program.
.const ZP = ${hex(o.zp ?? 0xf4)}                          // ${BRK_ZP_BYTES} bytes of zero page
.const PROBS = ${hex(table)}                     // 512 bytes the decruncher fills, at the start of a page
.const QSQ = ${o.small ? 0 : 1}                              // 1: 1 KB more at SQ, for a decruncher about a third faster
.const SQ = ${hex(table + 512)}                        // at the start of a page
.const EFFECT = ${o.effect ? 1 : 0}                            // 1 flashes the border
${o.at != null ? `* = ${hex(o.at)}\n` : ''}${SYMBOLS}
decrunch:
        lda stream                          // the file ends with the coder's first 16 bits and the data's end
        sec
        sbc #4
        sta stream
        sta SRC
        lda stream+1
        sbc #0
        sta stream+1
        sta SRC+1
        ldy #1
        lda (SRC),y
        sta CODE+1
        dey
        lda (SRC),y
        sta CODE
        ldy #2
        lda (SRC),y
        pha
        iny
        lda (SRC),y
        pha
${INIT}        lda #0
        sta prev
        pla
${DEST_SET}${resident('        rts\n', !o.small, '0')}`;
}

/**
 * The start of a self-extracting file: $01, the resident part copied to B_TO, the stream moved, the probabilities
 * set to a half, the coder started, the quarter squares made (QSQ), then the resident part's `next`.
 */
export const BRK_START = `${SYMBOLS}* = A_ADDR
.if (PROLOGUE == 1) {
        sei
        lda #RAM_DURING
        sta $01
}
        ldx #0                              // the resident part to its place: whole pages, then the rest
.if (B_LEN >= 256) {
        ldy #>B_LEN
copy_page:
copy_from:
        lda B_FROM,x
copy_to:
        sta B_TO,x
        inx
        bne copy_page
        inc copy_from+2
        inc copy_to+2
        dey
        bne copy_page
}
.if ((B_LEN & 255) > 0) {
copy_rest:
        lda B_FROM + (B_LEN & $ff00),x
        sta B_TO + (B_LEN & $ff00),x
        inx
        cpx #<B_LEN
        bne copy_rest
}
.if (MOVE_LEN > 0) {
.if (MOVE_TO < MOVE_FROM) {
        ldy #0                              // the stream down: from the first byte on
        ldx #>MOVE_LEN
        beq move_tail
move_page:
move_from:
        lda MOVE_FROM,y
move_to:
        sta MOVE_TO,y
        iny
        bne move_page
        inc move_from+2
        inc move_to+2
        dex
        bne move_page
move_tail:
        ldx #<MOVE_LEN
        beq move_done
move_byte:
        lda MOVE_FROM + (MOVE_LEN & $ff00),y
        sta MOVE_TO + (MOVE_LEN & $ff00),y
        iny
        dex
        bne move_byte
} else {
        ldy #<MOVE_LEN                      // up: from the last byte down
        beq move_pages
move_tail:
        dey
        lda MOVE_FROM + (MOVE_LEN & $ff00),y
        sta MOVE_TO + (MOVE_LEN & $ff00),y
        tya
        bne move_tail
move_pages:
        ldx #>MOVE_LEN
        beq move_done
move_page:
        dey
move_from:
        lda MOVE_FROM + (MOVE_LEN & $ff00) - $100,y
move_to:
        sta MOVE_TO + (MOVE_LEN & $ff00) - $100,y
        tya
        bne move_page
        dec move_from+2
        dec move_to+2
        dex
        bne move_page
}
move_done:
}
${INIT}        lda STREAM_END - 1                  // the coder's first 16 bits
        sta CODE+1
        lda STREAM_END - 2
        sta CODE
        lda #0                              // the data from its end down, the last offset 1
        sta DEST
        lda #1
        sta SRC
        lda #>(DATA_END - 1)
        sta DEST+1
        sta SRC+1
        ldy #<(DATA_END - 1)
        jmp next
`;
