/* The 6502 decruncher of Brokkr's fast format (src/fast.ts), as Kick Assembler source, read and written backward as
 * the others are. Y is the low byte of where the next byte goes (above it, in DEST's page; DEST stays 0); a copy,
 * of a literal run or a match, takes its length in X and copies down with Y: dey, lda, sta, dex and bne a byte where
 * it stays in the page, and a check for the page a byte where it may not. STREAM points at the lowest stream byte
 * read so far. A self-extracting file runs the start (FAST_START) from where it loaded, and keeps only the resident
 * part (FAST_RESIDENT) while it decrunches. */
import { SFX_EXIT, SFX_START_HEAD } from './brk-decruncher.ts';

/** The zero page bytes the decruncher uses from ZP on. */
export const FAST_ZP_BYTES = 10;

const SYMBOLS = `.label DEST = ZP                          // the page written in (DEST+1); Y is the low byte
.label SRC = ZP + 2                         // where Y copies from: DEST plus the offset, or the stream less Y
.label STREAM = ZP + 4                      // the lowest stream byte read so far
.label LEN = ZP + 6
.label LAST = ZP + 8                        // the last offset less 1
`;

/** The resident part: the token loop from `next`, and `done` where `exit` goes. */
const resident = (exit: string) => `next:                                       // a token
        jsr getbyte
        bmi mid
        cmp #$20
        bcc literal
        cmp #$40
        bcc tiny
        cmp #$60
        bcc long
        and #$1f                            // 011LLLLL: L bytes at the last offset again (0: the end)
        bne last_offset
done:
${exit}last_offset:
        ldx #3
        jsr length
        bcc match
literal:                                    // 000LLLLL: L + 1 bytes from the stream
        adc #1
        sta LEN
        tya                                 // SRC = STREAM - Y, so that SRC + Y is the stream's next byte
        eor #$ff
        sec
        adc STREAM
        sta SRC
        lda STREAM+1
        sbc #0
        sta SRC+1
        lda STREAM                          // and the stream LEN bytes lower after them (the carry is set)
        sbc LEN
        sta STREAM
        bcs literal_copy
        dec STREAM+1
literal_copy:
        jmp copy
tiny:                                       // 001LOOOO: L + 2 bytes at offset O + 1
        tax
        and #$0f
        sta LAST
        txa
        ldx #0
        stx LAST+1
        jsr nibble
        bcc match
mid:                                        // 1LLLOOOO O: L + 2 bytes at offset O + 1, O 12 bits
        tax
        and #$0f
        sta LAST+1
        txa
        ldx #1
        jsr nibble
low:                                        // the offset's low byte
        jsr getbyte
        sta LAST
        bcc match
long:                                       // 010LLLLL O O: L + 3 bytes at offset O + 1, O 16 bits, high byte first
        ldx #2
        jsr length
        jsr getbyte
        sta LAST+1
        bcc low
match:                                      // SRC = DEST plus the offset
        lda LAST
        sec
        adc #0
        sta SRC
        lda DEST+1
        adc LAST+1
        sta SRC+1

// LEN bytes down from SRC + Y to DEST + Y, then the next token: when Y is less, Y of them to the page's start, the
// rest (LEN is at most 255) in the page below
copy:
        ldx LEN
        cpy LEN
        bcc copy_split
copy_byte:
        dey
        lda (SRC),y
        sta (DEST),y
        dex
        bne copy_byte
        jmp next
copy_split:
        tya
        beq copy_below
copy_top:
        dey
        lda (SRC),y
        sta (DEST),y
        dex
        tya
        bne copy_top
copy_below:
        dec DEST+1
        dec SRC+1
        jmp copy_byte

// the stream's next byte, backward; keeps Y and the carry
getbyte:
        lda STREAM
        bne getbyte_page
        dec STREAM+1
getbyte_page:
        dec STREAM
        ldx #0
        lda (STREAM,x)
        rts

// the length field of kind X (its bits and the length of a field of 0 in tables) in A's upper nibble (nibble) or in
// A (length), into LEN; a full field: plus the next byte. Returns with the carry clear.
nibble:
        lsr
        lsr
        lsr
        lsr
length:
        and length_full,x
        cmp length_full,x
        beq length_more
        adc length_base,x
        sta LEN
        rts
length_more:
        clc
        adc length_base,x
        sta LEN
        jsr getbyte
        clc
        adc LEN
        sta LEN
        rts
length_full:
        .byte 1, 7, 31, 31                  // tiny, mid, long, last offset
length_base:
        .byte 2, 2, 3, 0
`;

/** The resident part of a self-extracting file (constants: ZP, RAM_EXIT, IRQ_EXIT, START, BASIC, BASIC_END). It does
 * not flash the border. */
export const FAST_RESIDENT = `${SYMBOLS}${resident(SFX_EXIT)}`;

/** The start of a self-extracting file: $01, the resident part and the stream moved, the pointers set, `next`. */
export const FAST_START = `${SYMBOLS}${SFX_START_HEAD}        lda #0                              // the last offset 1
        sta LAST
        sta LAST+1
        sta DEST
        lda #<STREAM_END                    // the stream and the data from their ends down
        sta STREAM
        lda #>STREAM_END
        sta STREAM+1
        lda #>DATA_END
        sta DEST+1
        ldy #<DATA_END
        jmp next
`;

/** The decruncher for mem files of the fast format, for Kick Assembler, with its constants. */
export function fastDecrunchSource(o: { zp?: number; at?: number } = {}): string {
  const hex = (v: number) => `$${v.toString(16).padStart(v > 0xff ? 4 : 2, '0')}`;
  return `// Brokkr's decruncher for its fast format, read and written backward. Kick Assembler source. Crunch with
// \`brokkr mem --format fast\`; set \`stream\` (2 bytes of zero page) to the address after the crunched data's last
// byte, then jsr decrunch. It does not change $01 or the interrupt flag, and it takes up to 6 bytes of stack.
// The constants: change them to suit your program.
.const ZP = ${hex(o.zp ?? 0xf6)}                          // ${FAST_ZP_BYTES} bytes of zero page
${o.at != null ? `* = ${hex(o.at)}\n` : ''}${SYMBOLS}.label stream = STREAM
decrunch:
        jsr getbyte                         // the file ends with the data's end address
        sta DEST+1
        jsr getbyte
        tay
        lda #0                              // the last offset 1
        sta DEST
        sta LAST
        sta LAST+1
${resident('        rts\n')}`;
}
