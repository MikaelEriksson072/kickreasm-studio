/* The C64 palette, without anything from the DOM, so the graphics code and its Node tests can share it. */

/** The C64 palette (Pepto). */
export const C64 = ['#000000', '#ffffff', '#68372b', '#70a4b2', '#6f3d86', '#588d43', '#352879', '#b8c76f', '#6f4f25', '#433900', '#9a6759', '#444444', '#6c6c6c', '#9ad284', '#6c5eb5', '#959595'];

/** the colour names the C64 manual uses, by index */
export const C64_NAMES = ['black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow', 'orange', 'brown', 'light red', 'dark grey', 'grey', 'light green', 'light blue', 'light grey'];

export const hexRgb = (h: string): [number, number, number] => { const m = h.trim().replace('#', ''); const v = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
