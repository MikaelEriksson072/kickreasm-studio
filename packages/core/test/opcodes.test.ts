import { describe, expect, it } from 'vitest';
import { assemble, decode, ENC, KICK_ILLEGAL, MODE_LEN, OPC } from '../src';

describe('opcode table', () => {
  it('has all 256 opcodes with lengths that match their modes', () => {
    expect(OPC).toHaveLength(256);
    OPC.forEach((o, i) => {
      expect(o.op).toBe(i);
      expect(o.len).toBe(MODE_LEN[o.mode]);
    });
  });

  it('knows the 151 documented NMOS 6502 opcodes', () => {
    expect(OPC.filter(o => !o.ill)).toHaveLength(151);
    expect(OPC.filter(o => o.jam)).toHaveLength(12);
  });

  it('classifies control flow', () => {
    expect(OPC[0x20].flow).toBe('jsr');
    expect(OPC[0x4c].flow).toBe('jmp');
    expect(OPC[0x6c].flow).toBe('jmpi');
    expect(OPC[0x60].flow).toBe('ret');
    expect(OPC[0x40].flow).toBe('ret');
    expect(OPC[0x00].flow).toBe('brk');
    expect(OPC[0x02].flow).toBe('jam');
    for (const op of [0x10, 0x30, 0x50, 0x70, 0x90, 0xb0, 0xd0, 0xf0]) expect(OPC[op].flow).toBe('br');
  });

  it('classifies memory access', () => {
    expect(OPC[0x8d].access).toBe('write'); // sta abs
    expect(OPC[0xee].access).toBe('rmw'); // inc abs
    expect(OPC[0x0a].access).toBe(null); // asl a
    expect(OPC[0xad].access).toBe('read'); // lda abs
    expect(OPC[0xa9].access).toBe(null); // lda #
    expect(OPC[0x87].access).toBe('write'); // sax zp
  });

  it('marks exactly the stable, unambiguous undocumented opcodes as Kick mnemonics', () => {
    for (const o of OPC) {
      if (!o.ill) { expect(o.kick).toBe(true); continue; }
      const expected = !o.unstable && KICK_ILLEGAL.has(o.mn) && !(o.mn === 'ANC' && o.op !== 0x0b);
      expect(o.kick, `$${o.op.toString(16)} ${o.mn}`).toBe(expected);
    }
    expect(OPC[0x2b].kick).toBe(false); // second ANC encoding
    expect(OPC[0xeb].kick).toBe(false); // SBC duplicate
    expect(OPC[0x8b].kick).toBe(false); // XAA, unstable
  });

  it('encodes every Kick-expressible opcode back to itself', () => {
    for (const o of OPC) if (o.kick) expect(ENC[o.mn]?.[o.mode], `${o.mn} ${o.mode}`).toBe(o.op);
  });

  it('assembles every Kick-expressible opcode with the subset assembler', () => {
    const operand: Record<string, string> = { imp: '', acc: '', imm: ' #$12', zp: ' $12', zpx: ' $12,x', zpy: ' $12,y', izx: ' ($12,x)', izy: ' ($12),y', rel: ' *+2', abs: ' $1234', abx: ' $1234,x', aby: ' $1234,y', ind: ' ($1234)' };
    for (const o of OPC) {
      if (!o.kick) continue;
      const r = assemble({ 't.asm': `.pc = $1000\n ${o.mn.toLowerCase()}${operand[o.mode]}` }, 't.asm');
      expect(r.errors, `${o.mn} ${o.mode}`).toEqual([]);
      expect(r.mem[0x1000], `${o.mn} ${o.mode}`).toBe(o.op);
    }
  });

  it('honours forced addressing like Kick Assembler 5.25', () => {
    // zl is a zero-page label defined after its use, like generated code that addresses a program in zp
    const one = (line: string) => assemble({ 't.asm': `.pc = $1000\n${line}\n.pc = $00f0\nzl: .byte 0` }, 't.asm');
    expect([...one(' lda.abs $0002').mem.subarray(0x1000, 0x1003)]).toEqual([0xad, 0x02, 0x00]);
    expect([...one(' lda.abs $0002,x').mem.subarray(0x1000, 0x1003)]).toEqual([0xbd, 0x02, 0x00]);
    expect(one(' lda.zp (zl),y').errors[0]?.msg).toMatch(/Cannot force zeropage mode/);
    expect(one(' lda (zl),y').errors).toEqual([]);
  });
});

describe('decode', () => {
  it('resolves relative branches with wrap-around', () => {
    const mem = new Uint8Array(0x10000);
    mem.set([0xd0, 0xfe], 0x1000);
    expect(decode(mem, 0x1000).target).toBe(0x1000);
    mem.set([0xd0, 0xfb], 0x0000);
    expect(decode(mem, 0x0000).target).toBe(0xfffd);
    mem.set([0xf0, 0x05], 0xfffc);
    expect(decode(mem, 0xfffc).target).toBe(0x0003);
  });

  it('reads operands little-endian and wraps at $ffff', () => {
    const mem = new Uint8Array(0x10000);
    mem.set([0xad, 0x20, 0xd0], 0x0810);
    expect(decode(mem, 0x0810)).toMatchObject({ v: 0xd020, target: 0xd020 });
    mem[0xffff] = 0xad; mem[0x0000] = 0x34; mem[0x0001] = 0x12;
    expect(decode(mem, 0xffff).v).toBe(0x1234);
    mem.set([0xa9, 0x42], 0x2000);
    expect(decode(mem, 0x2000)).toMatchObject({ v: 0x42, target: null });
  });
});
