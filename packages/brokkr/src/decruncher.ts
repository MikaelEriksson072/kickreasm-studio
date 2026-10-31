/* Brokkr's 6502 decruncher for Exomizer 3 streams, as Kick Assembler source. Brokkr assembles it into each
 * self-extracting file at the addresses that file needs (src/sfx.ts), and gives it as one routine to anyone who
 * wants it in their own code (`brokkr decruncher`, `decrunchSource`).
 *
 * It reads protocol 39 (with FOUR, 55): bits from the top of each byte, more than 7 bits as the rest and then a
 * byte, the first literal without a flag bit, and offsets taken again. Every length works, so the stream needs no
 * -T traits. It has two parts: TABLES reads the encoding at the start of the stream into the decrunch table, and
 * RESIDENT decrunches. A self-extracting file runs TABLES from where it loaded and keeps only RESIDENT while it
 * decrunches. */

/** The zero page bytes the decruncher uses from ZP on. */
export const ZP_BYTES = 9;

/** The constants both parts use. */
const SYMBOLS = `.const ENTRIES = FOUR == 1 ? 68 : 52
.label BITBUF = ZP
.label DEST = ZP + 1                        // the write page is DEST+1, its low byte is in Y (DEST stays 0)
.label SRC = ZP + 3                         // a match: the offset's low byte, and DEST+1 plus its high byte
.label LEN = ZP + 5
.label HIBITS = ZP + 7                      // bits above the low byte of a value
.label STATE = ZP + 8                       // 2 after a match, 1 after a match and a literal (the offset may come again)
.label TBL_BI = TABLE                       // per entry: the sentinel of its bits below 8 (0: none), bit 0 a byte
.label TBL_LO = TABLE + ENTRIES             // per entry: its base less 1 (the reads end with the carry set)
.label TBL_HI = TABLE + 2 * ENTRIES
`;

/** Reads the encoding into the table; then Y and DEST+1 are set to the data's end and it goes on at `literal`. */
const TABLES = `        ldx #0
        stx DEST
        stx STATE
        jsr getbyte                         // the stream's first byte is the bit buffer
        sta BITBUF
        // an entry's bit count comes as 3 bits and then bit 3; the bases start at 1 in each 16 and go up by
        // 2^count (kept less 1, in LEN)
table_next:
        txa
        and #$0f
        bne table_keep
        sta LEN
        sta LEN+1
table_keep:
        lda LEN
        sta TBL_LO,x
        lda LEN+1
        sta TBL_HI,x
        lda #$10
        jsr getbits
        lsr
        bcc table_count
        ora #8
table_count:
        tay
        lda codes,y
        sta TBL_BI,x
        lda #0
        sta HIBITS
        lda #1
table_power:
        dey
        bmi table_add
        asl
        rol HIBITS
        bcc table_power
table_add:
        clc
        adc LEN
        sta LEN
        lda HIBITS
        adc LEN+1
        sta LEN+1
        inx
        cpx #ENTRIES
        bne table_next
`;

/** The code of each bit count: the sentinel of count & 7, bit 0 from 8 up. */
const CODES = `codes:
        .byte $00, $80, $40, $20, $10, $08, $04, $02, $01, $81, $41, $21, $11, $09, $05, $03
`;

/** The decrunching itself, from the first literal; `done` is where it ends. */
const resident = (exit: string) => `literal:                                    // a byte from the stream (the first one has no flag bit)
        tya
        bne literal_page
        dec DEST+1
        dec SRC+1
literal_page:
        dey
        jsr getbyte
        sta (DEST),y
.if (EFFECT == 1) {
        sta $d020
}
        lsr STATE
next:
        asl BITBUF                          // the flag: 1 is a literal (read here, as it is read for every token)
        bne next_bit
        jsr refill
next_bit:
        bcs literal
        ldx #0                              // the gamma code: zero bits up to a one
gamma:
        jsr getbit
        bcs gamma_end
        inx
        bne gamma
gamma_end:
        cpx #16
        bcc length
.if (LITSEQ == 1) {
        bne sequence                        // 16 ends the data, 17 is a literal sequence
}
done:
${exit}sequence:
.if (LITSEQ == 1) {
        jsr getbyte                         // the length, high byte first
        sta LEN+1
        jsr getbyte
        sta LEN
        lsr STATE
        sec                                 // the bytes come from the stream
        bcs copy
}
length:
        jsr bits                            // the length: entry x's base plus its bits
        adc TBL_LO,x
        sta LEN
        lda HIBITS
        adc TBL_HI,x
        sta LEN+1
.if (REUSE == 1) {
        lsr STATE                           // 1: right after a literal that follows a match, a bit to reuse
        bcc offset
        jsr getbit
        bcs match                           // SRC is still DEST plus the offset
}
offset:
        lda #$11                            // the offset table: its index bits, with its first entry above them
.if (MIRRORS == 1) {
        ldx LEN+1                           // (without lengths 256 m + 0-2 the low byte tells)
        bne offset_index
}
        ldx LEN
        cpx #(FOUR == 1 ? 4 : 3)
        bcs offset_index
        lda offset_tables-1,x
offset_index:
        jsr getbits
        tax
        jsr bits
        adc TBL_LO,x
        sta SRC
        lda HIBITS
        adc TBL_HI,x
        adc DEST+1
        sta SRC+1
match:
        lda #2
        sta STATE
        clc                                 // the bytes come from the match
copy:
        ldx LEN
.if (MIRRORS == 1) {
        bne copy_byte                       // a low byte of 0 is 256 more: one page less after
        dec LEN+1
}
copy_byte:
        tya
        bne copy_page
        dec DEST+1
        dec SRC+1
copy_page:
        dey
.if (LITSEQ == 1) {
        bcs copy_stream
}
        lda (SRC),y
copy_put:
        sta (DEST),y
        dex
        bne copy_byte
        lda LEN+1
        beq copy_done
        dec LEN+1
        jmp copy_byte
copy_stream:
.if (LITSEQ == 1) {
        jsr getbyte
        bcs copy_put
}
copy_done:
        jmp next

// the bits of entry x: A the low byte, HIBITS the high byte; the carry set
bits:
        lda #0
        sta HIBITS
        lda TBL_BI,x
        lsr
        bcs bits_big
        beq bits_none
        asl
        bne getbits
bits_none:
        sec
        rts
bits_big:
        beq getbyte
        asl
        jsr getbits
        sta HIBITS                          // and the low byte:

// the stream's next byte, backward; keeps X, Y and the carry
getbyte:
        lda stream
        bne getbyte_page
        dec stream+1
getbyte_page:
        dec stream
        .byte $ad                           // lda absolute, from stream
stream:
        .word STREAM_END
        rts

// bits into A until the sentinel A starts with comes out at the top (256 >> n reads n bits); the carry set
getbits:
        asl BITBUF
        bne getbits_bit
        pha
        jsr refill
        pla
getbits_bit:
        rol
        bcc getbits
        rts

// a bit into the carry
getbit:
        asl BITBUF
        bne getbit_done
// the next byte of the bit buffer; the carry is its first bit
refill:
        jsr getbyte
        rol
        sta BITBUF
getbit_done:
        rts

// per offset table of the short lengths: the sentinel of its index bits, with its first entry shifted down by them
// (so the index read lands on the entry); the longest lengths' table is $11 (4 bits from entry 16)
offset_tables:
.if (FOUR == 1) {
        .byte $40 | (64 >> 2), $10 | (48 >> 4), $10 | (32 >> 4)
} else {
        .byte $40 | (48 >> 2), $10 | (32 >> 4)
}
`;

/** The resident part of a self-extracting file's decruncher, assembled at its place. */
/** The end of a self-extracting file's decrunching: $01, the interrupts, and the program's start. */
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

export const SFX_RESIDENT = `${SYMBOLS}${resident(SFX_EXIT)}`;

/**
 * The start of a self-extracting file (runs from where it loaded): $01, the resident part copied to B_TO, the
 * stream moved, the table read, then the resident part's `literal`. Constants besides the decruncher's: A_ADDR,
 * PROLOGUE (1: begin with sei and $01, else a prologue at $080d did), RAM_DURING, B_FROM, B_TO, B_LEN, MOVE_FROM,
 * MOVE_TO, MOVE_LEN, DATA_END, and the resident part's labels literal, getbyte and getbits.
 */
export const SFX_START = `${SYMBOLS}* = A_ADDR
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
// the crunched stream, from where the file put it to where it is decrunched from
.if (MOVE_TO < MOVE_FROM) {
        ldy #0                              // down: from the first byte on
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
${TABLES}        ldy #<DATA_END
        lda #>DATA_END
        sta DEST+1
        jmp literal
${CODES}`;

/** The prologue at $080d when the start sits at the end of the file: $01, then a jump to it. */
export const SFX_PROLOGUE = `* = $080d
        sei
        lda #RAM_DURING
        sta $01
        jmp A_ADDR
`;

/**
 * The decruncher as one routine for a program's own code (SFX = 0): put the address after the stream's last byte
 * in `stream` (low, high) and jsr decrunch. The stream is Exomizer's mem format, backward: it ends with the data's
 * end address, high byte last. Constants: ZP (9 bytes), TABLE (156 bytes, 204 with FOUR), FOUR, REUSE, EFFECT,
 * LITSEQ, STREAM_END (where `stream` starts; 0 to set it each time).
 */
export const USER_DECRUNCHER = `// Brokkr's decruncher for Exomizer 3 streams (-P39; with FOUR = 1, -P55), read and written backward.
// Kick Assembler source. Crunch with \`brokkr mem\` (or exomizer mem); set \`stream\` to the address after the
// crunched data's last byte, then jsr decrunch. It does not change $01 or the interrupt flag.
${SYMBOLS}
decrunch:
        jsr getbyte                         // the data's end, from the end of the stream
        sta DEST+1
        jsr getbyte
        pha
${TABLES}        pla
        tay
${resident('        rts\n')}${CODES}`;

/** The user decruncher with its constants, ready for Kick Assembler. */
export function decrunchSource(o: { zp?: number; table?: number; four?: boolean; reuse?: boolean; effect?: boolean; literalSequences?: boolean; anyLength?: boolean; at?: number } = {}): string {
  const hex = (v: number) => `$${v.toString(16).padStart(v > 0xff ? 4 : 2, '0')}`;
  return `// The constants: change them to suit your program.
.const SFX = 0
.const ZP = ${hex(o.zp ?? 0xf7)}                          // ${ZP_BYTES} bytes of zero page
.const TABLE = ${hex(o.table ?? 0x0334)}                     // ${o.four ? 204 : 156} bytes the decruncher fills
.const FOUR = ${o.four ? 1 : 0}                              // 1 for streams crunched with -P+16
.const REUSE = ${o.reuse === false ? 0 : 1}                             // 0 for streams crunched with -P-32
.const EFFECT = ${o.effect ? 1 : 0}                            // 1 flashes the border
.const LITSEQ = ${o.literalSequences === false ? 0 : 1}                            // 0 for streams crunched with -c
.const MIRRORS = ${o.anyLength ? 1 : 0}                           // 1 for streams crunched without -T4
.const STREAM_END = 0                       // or the address after the stream, if it is always the same
${o.at != null ? `* = ${hex(o.at)}\n` : ''}${USER_DECRUNCHER}`;
}
