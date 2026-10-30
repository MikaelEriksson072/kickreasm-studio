/* A D64 disk image as the 1541's read head sees it: every track's sectors GCR-encoded with their SYNC marks,
 * header blocks and gaps, as the drive lays them out when it formats a disk. A D64 with error bytes gets its errors
 * written into the sectors (a missing header or data block, no SYNC, a wrong checksum or disk ID), which is what
 * copy protections that check for them read. */

/** sectors on a track (1-42) */
export const sectorsOn = (track: number): number => (track <= 17 ? 21 : track <= 24 ? 19 : track <= 30 ? 18 : 17);
/** the speed zone of a track: 3 on the outer tracks (the most bits), 0 on the inner ones */
export const zoneOf = (track: number): number => (track <= 17 ? 3 : track <= 24 ? 2 : track <= 30 ? 1 : 0);
/** the bytes on a track of each speed zone at 300 rpm */
export const TRACK_BYTES = [6250, 6666, 7142, 7692];
/** drive cycles per byte at each density setting (VIA 2 port B bits 5-6) */
export const BYTE_CYCLES = [32, 30, 28, 26];

const GCR = [0x0a, 0x0b, 0x12, 0x13, 0x0e, 0x0f, 0x16, 0x17, 0x09, 0x19, 0x1a, 0x1b, 0x0d, 0x1d, 0x1e, 0x15];

/** 4 bytes as 5 GCR bytes, each nibble as 5 bits */
function encode(out: number[], bytes: number[]): void {
  for (let i = 0; i < bytes.length; i += 4) {
    let v = 0;
    for (let k = 0; k < 4; k++) { const b = bytes[i + k] ?? 0; v = v * 1024 + ((GCR[b >> 4] << 5) | GCR[b & 15]); }
    for (let j = 4; j >= 0; j--) out.push(Math.floor(v / 2 ** (8 * j)) & 0xff);
  }
}

export interface Disk {
  /** the GCR bytes of each track, by track number (1-42); missing tracks are unformatted */
  tracks: (Uint8Array | null)[];
  /** the disk name and ID from the BAM, for the report */
  name: string;
  id: string;
  writeProtected: boolean;
}

const SIZES: Record<number, [number, boolean]> = {
  174848: [35, false], 175531: [35, true], 196608: [40, false], 197376: [40, true], 205312: [42, false], 206114: [42, true],
};

/** A D64 image (35, 40 or 42 tracks, with or without error bytes) as GCR tracks. */
export function d64ToDisk(d64: Uint8Array): Disk {
  const size = SIZES[d64.length];
  if (!size) throw new Error(`not a D64 image: ${d64.length} bytes`);
  const [count, errors] = size;
  const offsets: number[] = [];
  let sectors = 0;
  for (let t = 1; t <= count; t++) { offsets[t] = sectors; sectors += sectorsOn(t); }
  const bam = offsets[18] * 256;
  const id1 = d64[bam + 0xa2], id2 = d64[bam + 0xa3];
  const tracks: (Uint8Array | null)[] = [null];
  for (let t = 1; t <= 42; t++) {
    if (t > count) { tracks.push(null); continue; }
    const n = sectorsOn(t), length = TRACK_BYTES[zoneOf(t)];
    const out: number[] = [];
    const gap = Math.floor((length - n * 354) / n);
    for (let s = 0; s < n; s++) {
      const index = offsets[t] + s, data = d64.subarray(index * 256, index * 256 + 256);
      const error = errors ? d64[sectors * 256 + index] : 1;
      const sync = error === 3 ? 0x55 : 0xff;
      for (let k = 0; k < 5; k++) out.push(sync);
      const hid1 = error === 11 ? id1 ^ 0xff : id1, hid2 = error === 11 ? id2 ^ 0xff : id2;
      const hsum = (s ^ t ^ hid2 ^ hid1) ^ (error === 9 ? 0xff : 0);
      encode(out, [error === 2 ? 0x00 : 0x08, hsum, s, t, hid2, hid1, 0x0f, 0x0f]);
      for (let k = 0; k < 9; k++) out.push(0x55);
      for (let k = 0; k < 5; k++) out.push(sync);
      let sum = 0;
      for (const b of data) sum ^= b;
      encode(out, [error === 4 ? 0x00 : 0x07, ...data, sum ^ (error === 5 ? 0xff : 0), 0x00, 0x00]);
      const tail = s === n - 1 ? length - out.length : gap;
      for (let k = 0; k < tail; k++) out.push(0x55);
    }
    tracks.push(Uint8Array.from(out));
  }
  const text = (from: number, len: number) => Array.from(d64.subarray(from, from + len), b => (b === 0xa0 ? '' : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '?')).join('').trimEnd();
  return { tracks, name: text(bam + 0x90, 16), id: text(bam + 0xa2, 2), writeProtected: false };
}
