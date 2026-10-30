/* What the undocumented opcodes do (cpu/undocumented.ts, spec 7.2): every one is described, with its flags. */
import { describe, expect, it } from 'vitest';
import { OPC, undocumentedOpcode, undocumentedText } from '../src';

describe('the undocumented opcodes', () => {
  it('are each described, with the flags they change; the documented ones are not', () => {
    for (const o of OPC) {
      const u = undocumentedOpcode(o.op);
      if (!o.ill) { expect(u, o.mn).toBeNull(); continue; }
      expect(u, `$${o.op.toString(16)}`).not.toBeNull();
      expect(u!.mn).toBe(o.mn);
      expect(u!.does.length).toBeGreaterThan(10);
      expect(u!.flags.every(f => 'NVZC'.includes(f))).toBe(true);
      expect(u!.unstable != null).toBe(o.unstable);
    }
  });

  it('write a tooltip: the name, what it does, the formula and the flags', () => {
    expect(undocumentedText(0xc7)).toBe([
      'dcp ($c7, zp) - undocumented opcode, also called dcm',
      'Decrements the memory (DEC), then compares A with it (CMP).',
      'M = M - 1, compare A with M',
      'Flags: N Z C',
    ].join('\n'));
    expect(undocumentedText(0x8f)).toContain('Flags: none change');
    expect(undocumentedText(0x67)).toContain('Decimal mode works as in ADC.');
    expect(undocumentedText(0xa9)).toBeNull();
    // by its mnemonic alone: without the opcode and addressing mode
    expect(undocumentedText(0xc7, true)!.split('\n')[0]).toBe('dcp - undocumented opcode, also called dcm');
  });

  it('tell the opcodes apart that share a mnemonic: lax # is the unstable one, sbc $eb is sbc #, the NOPs read or skip', () => {
    expect(undocumentedOpcode(0xa7)).toMatchObject({ mn: 'LAX', flags: ['N', 'Z'], unstable: null });
    expect(undocumentedOpcode(0xab)).toMatchObject({ mn: 'LAX', also: ['LXA', 'OAL'], unstable: expect.stringContaining('constant c') });
    expect(undocumentedText(0xeb)).toContain('the same as SBC # ($e9)');
    expect(undocumentedText(0x80)).toContain('skips the byte after it');
    expect(undocumentedText(0x0c)).toContain('$dc0d acknowledges a CIA interrupt');
    expect(undocumentedOpcode(0x0c)!.also).toEqual(['TOP', 'SKW']);
    expect(undocumentedText(0x1a)).toContain('as NOP ($ea) does');
    expect(undocumentedText(0x02)).toContain('only a reset brings it back');
    expect(undocumentedText(0x9e)).toContain('Unstable: the AND with the high byte drops out');
    expect(undocumentedText(0x8b)).toMatch(/^xaa \(\$8b, imm\) - undocumented opcode, also called ane\n/);
  });
});
