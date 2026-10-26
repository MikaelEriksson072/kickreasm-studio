import { describe, expect, it } from 'vitest';
import { GOTO_HELP, parseGoto } from '../src/lib/goto';

const labels: Record<string, number> = { sine_09b5: 0x09b5, colors_0939: 0x0939, beef: 0x1234 };
const parse = (s: string) => parseGoto(s, n => labels[n]);

describe('Go to dialog input', () => {
  it('reads addresses and labels', () => {
    expect(parse('$0810')).toEqual({ addr: 0x0810 });
    expect(parse('0x810')).toEqual({ addr: 0x0810 });
    expect(parse(' c000 ')).toEqual({ addr: 0xc000 });
    expect(parse('sine_09b5')).toEqual({ addr: 0x09b5 });
    // a label wins over the same text read as hex, as before
    expect(parse('beef')).toEqual({ addr: 0x1234 });
  });

  it('reads ranges with the end included, in either order and with labels', () => {
    expect(parse('$2000-$27ff')).toEqual({ start: 0x2000, end: 0x2800 });
    expect(parse('2000 .. 27ff')).toEqual({ start: 0x2000, end: 0x2800 });
    expect(parse('$2000–$27ff')).toEqual({ start: 0x2000, end: 0x2800 });
    expect(parse('$27ff-$2000')).toEqual({ start: 0x2000, end: 0x2800 });
    expect(parse('colors_0939-$0ab4')).toEqual({ start: 0x0939, end: 0x0ab5 });
    expect(parse('$0000-$ffff')).toEqual({ start: 0, end: 0x10000 });
  });

  it('explains what it accepts', () => {
    for (const s of ['', 'nope', '$12345', '$2000-', '-$2000', '$2000-nope']) expect(parse(s), s).toEqual({ error: GOTO_HELP });
  });
});
