#!/usr/bin/env node
/* A stand-in for unp64 in the tests: undoes fakePack() (test/helpers/fake-packer.ts) without emulating it: after
 * "FAKEPACK" come the start address, the load address, the length, then the program xor a 16-bit Galois LFSR key
 * stream. Like unp64 it writes `<input>.<xxxx>` (xxxx = the start address) next to the input and prints
 * "return to mem: $xxxx"; `--out <name>` writes <name> instead. `--nothing` writes no file. */
const fs = require('node:fs');

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : null;
const input = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1)).pop();
console.log('fake unp64 0.2');
if (args.includes('--nothing')) { console.log('nothing to do'); process.exit(0); }
const b = fs.readFileSync(input);
const at = b.indexOf(Buffer.from('FAKEPACK'));
if (at < 0) { console.log(`${input}: not packed by fakePack`); process.exit(1); }
const word = o => b[at + o] | (b[at + o + 1] << 8);
const entry = word(8), load = word(10), n = word(12);
const data = b.subarray(at + 14, at + 14 + n);
let s = 0xace1;
const body = Buffer.from(data.map(v => { const lsb = s & 1; s >>= 1; if (lsb) s ^= 0xb400; return v ^ (s & 0xff); }));
const hex = v => v.toString(16).padStart(4, '0');
const name = out ?? `${input}.${hex(entry)}`;
fs.writeFileSync(name, Buffer.concat([Buffer.from([load & 0xff, load >> 8]), body]));
console.log(`FakePack, unpacker=$0340\npass2, return to mem: $${hex(entry)}\nsaved $${hex(load)}-$${hex(load + n - 1)} as ${name}`);
