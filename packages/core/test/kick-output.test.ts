import { describe, expect, it } from 'vitest';
import { parseKickOutput } from '../src';

// Captured from Kick Assembler v5.25.
const MULTI = `//------------------------------------------------------
//         Kick Assembler v5.25 by Mads Nielsen
//------------------------------------------------------
Output dir: C:\\work\\demo\\out
parsing
Got 2 errors and 0 warnings while executing:
  (C:\\work\\demo\\include\\inc.asm 2:14) Error: Unknown symbol 'undefinedthing'
  (C:\\work\\demo\\e.asm 3:7) Error: Unknown symbol 'unknown1'

.label FOO = $10
.label BAR = undefinedthing
             ^

Error: Unknown symbol 'undefinedthing'
at line 2, column 14 in include\\inc.asm
`;

const SINGLE = `parsing
flex pass 1
        lda.zp (zl),y
        ^

Error: Cannot force zeropage mode on an argument of type indirectZeropageY
at line 11, column 9 in t1.asm
`;

describe('parseKickOutput', () => {
  it('reads the error summary and deduplicates the detailed report', () => {
    expect(parseKickOutput(MULTI, 'C:\\work\\demo')).toEqual([
      { severity: 'error', file: 'include/inc.asm', line: 2, column: 14, message: "Unknown symbol 'undefinedthing'" },
      { severity: 'error', file: 'e.asm', line: 3, column: 7, message: "Unknown symbol 'unknown1'" },
    ]);
  });

  it('reads a single detailed error', () => {
    expect(parseKickOutput(SINGLE)).toEqual([
      { severity: 'error', file: 't1.asm', line: 11, column: 9, message: 'Cannot force zeropage mode on an argument of type indirectZeropageY' },
    ]);
  });

  it('keeps errors without a location (e.g. Java could not start)', () => {
    expect(parseKickOutput('Error: Unable to access jarfile C:\\nope\\KickAss.jar')).toEqual([
      { severity: 'error', file: '', line: 0, column: 0, message: 'Unable to access jarfile C:\\nope\\KickAss.jar' },
    ]);
  });

  it('returns nothing for a clean build', () => {
    expect(parseKickOutput('parsing\nflex pass 1\nOutput pass\nWriting prg file: out/demo.prg\n')).toEqual([]);
  });
});
