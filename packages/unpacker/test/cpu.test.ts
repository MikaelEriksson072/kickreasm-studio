import { describe, expect, it } from 'vitest';
import { Cpu, type Bus } from '../src/cpu.ts';
import { LEN, OPCODES, disassemble } from '../src/opcodes.ts';
import { asm } from './asm.ts';

/** Run code at $1000 until BRK; returns the CPU, the memory and the cycles of each instruction. */
function run(code: string, setup: (cpu: Cpu, mem: Uint8Array) => void = () => {}) {
  const mem = new Uint8Array(0x10000);
  const bus: Bus = { read: a => mem[a], write: (a, v) => { mem[a] = v; }, fetch: a => mem[a] };
  const a = asm(`* = $1000\n${code}\n brk`);
  mem.set(a.prg.subarray(2), a.start);
  const cpu = new Cpu(bus);
  cpu.pc = a.start; cpu.s = 0xff;
  setup(cpu, mem);
  const cycles: number[] = [];
  for (let n = 0; n < 10000; n++) {
    const c = cpu.step();
    if (cpu.lastOp === 0x00) break;
    cycles.push(c);
  }
  return { cpu, mem, cycles };
}

describe('opcode table', () => {
  it('has 256 opcodes with lengths', () => {
    expect(OPCODES).toHaveLength(256);
    expect(LEN[0xad]).toBe(3);
    expect(LEN[0xa9]).toBe(2);
    expect(LEN[0xea]).toBe(1);
  });

  it('disassembles', () => {
    const mem = [0xb1, 0xfb, 0x10, 0xfe];
    expect(disassemble(a => mem[a - 0x1000] ?? 0, 0x1000).text).toBe('lda ($fb),y');
    expect(disassemble(a => mem[a - 0x1000] ?? 0, 0x1002).text).toBe('bpl $1002');
  });
});

describe('6510', () => {
  it('adds and subtracts in decimal mode', () => {
    expect(run('sed\n sec\n lda #$58\n adc #$46').cpu).toMatchObject({ a: 0x05, c: 1 });
    expect(run('sed\n clc\n lda #$12\n adc #$34').cpu).toMatchObject({ a: 0x46, c: 0 });
    expect(run('sed\n sec\n lda #$46\n sbc #$12').cpu).toMatchObject({ a: 0x34, c: 1 });
    expect(run('sed\n sec\n lda #$12\n sbc #$21').cpu).toMatchObject({ a: 0x91, c: 0 });
  });

  it('runs the undocumented opcodes', () => {
    expect(run('lax $10', (_, m) => { m[0x10] = 0x42; }).cpu).toMatchObject({ a: 0x42, x: 0x42 });
    expect(run('lda #$f0\n ldx #$3c\n sax $20').mem[0x20]).toBe(0x30);
    const dcp = run('lda #$04\n dcp $30', (_, m) => { m[0x30] = 0x05; });
    expect(dcp.mem[0x30]).toBe(0x04);
    expect(dcp.cpu).toMatchObject({ z: 1, c: 1 });
    const isc = run('sec\n lda #$10\n isc $31', (_, m) => { m[0x31] = 0xff; });
    expect(isc.mem[0x31]).toBe(0);
    expect(isc.cpu.a).toBe(0x10);
    expect(run('lda #$0f\n ldx #$f3\n sbx #$02').cpu).toMatchObject({ x: 0x01, c: 1 });
    expect(run('lda #$ff\n anc #$80').cpu).toMatchObject({ a: 0x80, c: 1, n: 0x80 });
    expect(run('lda #$ff\n alr #$03').cpu).toMatchObject({ a: 0x01, c: 1 });
    expect(run('sec\n lda #$ff\n arr #$ff').cpu).toMatchObject({ a: 0xff, c: 1, v: 0 });
    expect(run('lda #$81\n slo $40', (_, m) => { m[0x40] = 0x41; })).toMatchObject({ cpu: { a: 0x83, c: 0 } });
  });

  it('counts page crossings and taken branches', () => {
    const r = run('ldx #$01\n lda $10ff,x\n lda $1000,x', () => {});
    expect(r.cycles).toEqual([2, 5, 4]);
    const b = run(`
      * = $10f0
      ldx #$00
      beq far
      .fill 16, $ea
far:  nop`);
    expect(b.cycles.slice(0, 2)).toEqual([2, 4]);
  });

  it('wraps JMP ($xxff) inside the page', () => {
    const r = run('jmp ($20ff)', (_, m) => { m[0x20ff] = 0x00; m[0x2000] = 0x30; m[0x2100] = 0x40; m.set([0xa2, 0x77, 0x00], 0x3000); });
    expect(r.cpu.x).toBe(0x77);
  });

  it('calls and returns', () => {
    const r = run('jsr sub\n ldy #$07\n brk\nsub: ldx #$05\n rts');
    expect(r.cpu).toMatchObject({ x: 5, y: 7, s: 0xfc });
  });
});
