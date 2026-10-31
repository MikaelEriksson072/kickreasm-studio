/* Brokkr's errors: a code to look up, what is wrong, and what to do about it. */

export class BrokkrError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export const h4 = (v: number): string => `$${(v & 0xffff).toString(16).padStart(4, '0')}`;
export const h2 = (v: number): string => `$${(v & 0xff).toString(16).padStart(2, '0')}`;
/** [start, end) as $xxxx–$yyyy, the end inclusive as C64 people write it */
export const span = (start: number, end: number): string => `${h4(start)}–${h4(end - 1)}`;
