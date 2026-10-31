# Brokkr

**Brokkr is a cruncher for Commodore 64 programs.** It writes the stream format of Exomizer 3, so every decruncher
written for Exomizer reads its files, and it crunches them smaller than Exomizer 3.1.1 does, in a fraction of the time.
It makes self-extracting programs that it plans and checks itself, crunched data for your own decruncher, and it packs
files straight on a D64. For the smallest files it also has a format of its own, coded adaptively as LZMA is
(`--format brokkr`): 6.6 % smaller than Exomizer 3.1.1's streams, decrunched about 8 times slower. For the fastest
decrunching it has one of whole bytes (`--format fast`): 13 % larger, decrunched about twice as fast.

It is named after Brokkr, the dwarf who forged Mjölnir with his brother Sindri. [Sindri](https://github.com/MikaelEriksson072/Sindri)
unpacks; Brokkr packs. Both were made for [Mimir Studio](https://github.com/MikaelEriksson072/mimir-studio), whose
built-in cruncher this is. Brokkr is written in TypeScript and runs on Node 22.18 or newer, which runs the sources as
they are.

## Better than Exomizer 3.1.1 at

- **Size.** Exomizer keeps one way to reach each position of the data. The cost of a match depends on what came
  before it, though: after a match and one literal the decruncher reads a bit that may take the match's offset again.
  Brokkr's parse keeps several ways to each position, one per state and offset that can still be taken again, so it
  finds where taking an offset again pays. It also takes the cheapest offset for each length, not only the nearest:
  the bucket tables Exomizer's optimiser makes are often not ever wider, and then a farther offset costs fewer bits.
  The tables are made for the parse and the parse for the tables until the stream stops shrinking.
- **Speed.** On one thread it crunches four to eight times as fast as Exomizer. `--effort max` searches further, on
  every core: from several starting tables, and with each bucket of the best table a bit wider and narrower in turn.
  The `fast` effort takes a quarter of the time of `normal` for streams 1.7 % larger.
- **Self-extracting programs that are planned and checked.** Brokkr works out where the decruncher, its table, its
  zero page bytes and the crunched data can go: the stack page and `$0334-$03ff` first, so nothing shows on the screen,
  then anywhere the program leaves room, under the ROMs included. It places the stream so that the decruncher never
  writes over a byte it has not read yet, and it sets `$01` while decrunching so that everything it reads and writes is
  RAM (`$34` when data lies under I/O). Then it runs the file in an emulated C64 from its SYS line until the program
  starts, and compares the memory with the program, byte for byte, before it hands the file over.
- **The in-place margin.** For crunched data (`mem`) it computes the exact margin a decruncher needs to decrunch in
  place, sets the load address from it, and warns when a load address you give would make the decruncher write over
  what it has not read.
- **Disk images.** `brokkr d64` lists a D64 and packs the files you name on it into a new image: self-extracting where a
  file starts with a SYS line, crunched data where not.
- **Tools that read its output.** `--json` prints the result as one JSON object: sizes, the memory layout, `$01`, the
  cycles the decruncher took, warnings. Errors have codes (`BRK-E110`) and say what to do.
- **Its decruncher as source.** `brokkr decruncher` writes Brokkr's 6502 decruncher as Kick Assembler source, to
  decrunch `mem` files (Brokkr's or Exomizer's) in your own program.

## Its own format

`--format brokkr` packs for size above all. It codes the same kind of LZ tokens as Exomizer, but every bit with a
binary arithmetic coder whose probabilities adapt after each bit, as LZMA's do: literals down an 8-bit tree, lengths in
an interleaved gamma code, offsets as their bit length (in the context of the match's length) and then their bits (the
first four in the context of the bit length, the rest of their place), and "the last offset again" after a literal.
The parse prices tokens by what the coder charges, block by block, and parses again until the stream stops shrinking.

On the 163 programs below the streams are 6.6 % smaller than Exomizer 3.1.1's (2 701 397 bytes against 2 891 460;
smaller on 152 of them), crunched in 84 s on one thread. It costs time and memory when decrunching: every bit takes a
multiply, so it decrunches about 8 times slower than Exomizer's format (median 7.8; 6.4 to 9.4 on half of them; up to 24
on data that hardly packs, which is all literals), and the decruncher needs 512 bytes of probabilities, 1 KB of quarter
squares where there is room (a third faster; without them it shifts and adds) and a resident part of about 425 bytes.
As self-extracting files on 159 of the programs, Brokkr's own format makes them 3.5 % smaller in all, smaller on 98: on
small programs Exomizer's format is smaller, its decruncher being shorter, and where a program leaves no room for the
probabilities the file is in Exomizer's format, with a note (26 of them).

`brokkr decruncher --format brokkr` writes its decruncher for `mem` files (backward only) as Kick Assembler source:
`--zp` (12 bytes), `--table` (a page: 1.5 KB, or 512 bytes with `--small`), `--at`, `--effect`.

## Its fast format

`--format fast` packs for decrunching fast. Every token is whole bytes, so the decruncher reads no bits: a literal run
of up to 32 bytes, a match of 2 or 3 bytes up to 16 back in one byte, one of 2 to 8 bytes up to 4096 back in two, any
match in three, and "the last offset again" in one; a full length field takes a byte more, up to 255. The parse prices
them in bytes. The decruncher keeps the write position in Y and copies each byte with `dey`, `lda`, `sta`, `dex` and
`bne`; it is 215 bytes (229 with RUN) and needs no tables, so it fits in the stack page.

On the 163 programs below the streams are 13.2 % larger than Exomizer 3.1.1's (3 273 438 bytes against 2 891 460),
crunched in 19 s on one thread. As self-extracting files on 159 of them they are 12.5 % larger than in Exomizer's format
and decrunch in 0.56 of its time in all: half of it on the median program, 0.4 at best, 0.8 for one that is nearly all
long runs (a copy costs the same in both). 5 programs that fill memory leave no room for the larger stream, and are in
Exomizer's format. It does not flash the border. Before this format Brokkr tried one of bits in the manner of ZX0:
3 % larger than Exomizer's, but only 1.27 times as fast, as reading bits costs about what Exomizer's tables do.

`brokkr decruncher --format fast` writes its decruncher for `mem` files: `--zp` (10 bytes), `--at`.

## Results

On 163 unpacked C64 programs (demos, games and intros from CSDB, unpacked with Sindri; 7.1 MB), as raw streams:

| | Exomizer 3.1.1 | Brokkr normal | Brokkr fast |
|---|---|---|---|
| crunched | 2 891 460 bytes | 2 873 546 bytes (−0.62 %) | 2 923 385 bytes (+1.10 %) |
| smaller than Exomizer | | on 160, the same on 2, larger on 1 | on 1 |
| time (one thread) | 954 s | 121 s | 31 s |

Exomizer decrunches every Brokkr stream to the same bytes (`exomizer raw -d`), and its `desfx` decrunches Brokkr's
self-extracting files. As self-extracting programs, on 62 of them, Brokkr's files are 0.39 % smaller in all, smaller on
36 and up to 81 bytes larger on 26: its decruncher is a little longer than Exomizer's, and it decrunches about 9 %
slower. Both are the next things to improve.

## Use

```
node src/cli.ts sfx game.prg
```

```
game.prg: $0801–$37ff, 12287 bytes
  Crunched data    $07ff–$0dd5
  Decrunched data  $0801–$37ff
  Decrunch table   $0334–$03cf
  Decruncher       $0100–$01d8  zero page $f7-$ff
  File             $0801–$0f5d
  $01 $37 while decrunching, $37 after; interrupts on after; jmp $0810
  checked in an emulated C64: 537238 cycles (0.55 s)
game-brokkr.prg: 1887 bytes (15.4 % of 12287)
```

The commands:

| | |
|---|---|
| `sfx <file>...` | a self-extracting program: `--start sys` (the program's SYS, the default), `basic` (RUN) or an address; `--ram-exit $35`, `--irq off`, `--no-effect`, `--four-tables` |
| `mem <file>...` | crunched data with its address, decrunched in place (as `exomizer mem`); `-f` forward, `-l <address>` or `-l none` |
| `raw <file>...` | a bare stream (as `exomizer raw`); `-b` backward, `-r` reversed |
| `d64 <disk> [name]...` | list a disk, or pack the files named on it into `<disk>-brokkr.d64`; `--mode sfx` or `mem` |
| `decruncher` | the 6502 decruncher as Kick Assembler source; `--zp`, `--table`, `--at`, `--four`, `--no-reuse`, `--effect` (with `--format brokkr`: `--small`; with `--format fast`: `--zp`, `--at`) |

A file is a `.prg`, `<file>@<address>` for raw bytes, or `<file>,<address>[,<offset>[,<length>]]` for a part of one, as
Exomizer takes it. Several files are merged into one memory image. Everywhere: `--format exomizer|brokkr|fast`,
`--effort fast|normal|max`, `--threads`, `-o <file>`, `--json`, `-q`; for `mem` and `raw` in Exomizer's format also
Exomizer's `-P`, `-T`, `-M`, `-m`, `-e` and `-E`.

`brokkr.cmd` runs it on Windows. From TypeScript: `import { sfx, mem, raw, Disk } from 'brokkr'` (`brokkr/node` adds the
thread pool).

## How it works

- `src/format.ts`: the Exomizer 3 bit stream for every `-P` protocol and `-T` trait: the costs of the tokens, writing a
  parse as a stream, and a decoder, which checks every stream Brokkr writes and computes the in-place margin.
- `src/match.ts`: for every position the nearest place that repeats each length, from a binary tree of the earlier
  suffixes per two-byte prefix (as LZMA's bt2), plus farther places as long as the longest so far.
- `src/parse.ts`: the optimal parse, position by position, with arrivals per state (after a match, after a match and a
  literal, after two literals) and per offset that can be taken again.
- `src/optimize.ts`: the bucket tables for a parse, by dynamic programming from the deepest bucket up.
- `src/crunch.ts`, `src/search.ts`, `src/node.ts`: the rounds of parse and tables; the thorough search, on a pool of
  worker threads.
- `src/sfx.ts`, `src/decruncher.ts`, `src/asm.ts`, `src/emulate.ts`: the self-extracting file. The decruncher is Kick
  Assembler source that Brokkr assembles with its own small assembler at the addresses each file needs; it has a part
  that runs once from where the file loaded (it copies the rest, moves the stream and reads the tables) and a resident
  part of about 200 bytes. The emulated C64 is a 6510 with the CPU port banking BASIC, KERNAL and I/O, where reading a
  ROM that is switched in or writing to I/O counts as a fault.
- `src/brk.ts`, `src/parse-brk.ts`, `src/crunch-brk.ts`, `src/brk-decruncher.ts`: Brokkr's own format: its coder,
  model and prices, its parse, the rounds of parse and prices, and its 6502 decruncher (the self-extracting one and the
  one for `mem` files).
- `src/fast.ts`, `src/parse-fast.ts`, `src/fast-decruncher.ts`: the fast format, its parse (costs in whole bytes), and
  its 6502 decruncher.
- `src/files.ts`, `src/d64.ts`, `src/cli.ts`: the `raw` and `mem` files, D64 images, and the command line.

## Tests

```
pnpm test
```

Besides Brokkr's own checks they compare with the real tools when they are installed: Exomizer 3.1.1 decrunches
Brokkr's streams for several protocols and its `desfx` a Brokkr self-extracting file; Kick Assembler assembles the
decruncher source to the same bytes as Brokkr's assembler; VICE's `c1541` reads the disks Brokkr writes. The decruncher
for your own code decrunches `mem` files in the emulated C64, in every format; the fast one's in fewer cycles than
Exomizer's format takes.

## Licence

GPL-3.0-only, like Mimir Studio and Sindri. Brokkr contains no code of Exomizer's: it writes the stream format that
Magnus Lind designed for Exomizer 3, which its documentation and its decrunchers describe, and its cruncher, its 6502
decruncher and its self-extracting files are its own. The 6510 core is Sindri's.
