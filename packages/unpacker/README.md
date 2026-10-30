# unpacker (@mimir/unpacker)

**A generic unpacker for Commodore 64 programs.** It runs a packed PRG in an emulated C64, follows it through its
layers (coders, movers, decrunchers, intros in front of them) and saves the unpacked program at the moment it starts.
With the disk the program came from, an emulated 1541 is on the serial bus, so it can go on loading: through the
KERNAL, or with a fast loader of its own.
It needs no knowledge of the packer: it works for old and unknown crunchers as well as for known ones, and it reports
what each layer did so that new packers can be recognised and named.

It is written in TypeScript and runs on Node 22.18 or newer, which runs the sources as they are. It was made for
[Mimir Studio](https://github.com/MikaelEriksson072/mimir-studio), whose built-in unpacker it is: this package is a copy
of the standalone project, and `src/`, `data/` and `test/` are kept the same as there. Mimir runs it through
`unpackPrg()` and reports it with `unpackLog()` (`packages/core/src/unpacker.ts`), in the app's unpacker worker and in
`mimir unpack`.

## How it works

The C64 is emulated with what unpacking needs: a 6510 with all 256 opcodes (the undocumented ones as VICE runs them)
and exact instruction timing, the memory banked by `$01`, the VIC-II's raster line, raster interrupts and badlines,
both CIAs with timers, interrupts and the keyboard and joysticks, and the SID registers a program can read. With the
C64 ROMs it starts the machine, types `LOAD`, loads the file and types `RUN`, as a real C64 does; so BASIC start lines,
autostarts through the vectors or the stack, and packers that call the KERNAL work as they do on the real machine.

For every byte of RAM it records which layer wrote it last and when, when it was last read as data and when it was
last run. **A new layer begins when the CPU jumps into code that the running layer wrote and has not run yet**: the
depacker a stub copied to `$0100`, the program a decruncher wrote, the code a decoder decrypted. Jumping into BASIC's
`RUN` counts too. Memory is copied at the start of every layer, together with the bytes that belong to the program
that layer starts:

- what the layer before it wrote and did not run itself;
- untouched parts of the loaded file;
- not the packed data the depackers consumed (a copy they moved and read), its unread rest, the stub's leftovers,
  the depackers' own code and variables, or what the C64 wrote itself (the screen editor, the clock, the keyboard).

Layers begun inside a subroutine call or an interrupt that returns to where it was called from were temporary and join
the caller again: a decruncher called with `JSR`, speedcode a program generates, an interrupt handler it writes.

The run stops when the newest layer settles (it stops streaming new data through memory), loads a file (without a
disk), returns to BASIC, crashes or runs out of time. The newest layer is then the unpacked program. When an intro waits before anything
was unpacked, keys are pressed in turn (space and fire first, then return, N, F1, Y, F7, 1).

Compared with unp64, which stops at the first jump back to `$0800` or higher, this finds the end of depackers that never
go below `$0800`, goes through every layer of a program packed several times (unp64 does with `-c`), and needs no
packer-specific scanners. It also saves only the program's own bytes, where unp64 saves to the end of memory or to a
packer's end pointer.

## The disk drive

With a disk (a D64 image, given instead of the file or with `--disk`) a 1541 is on the serial bus:

- its own 6502 with 2 KB of RAM and the DOS ROM, taken from VICE's `DRIVES` folder like the C64's ROMs;
- VIA 1 on the serial bus: ATN, CLK and DATA as open-collector lines either side pulls low, the drive's automatic
  answer to ATN (DATA pulled low while ATN and the acknowledge bit differ), and the ATN interrupt;
- VIA 2 on the head: the stepper moving it half a track at a time, the motor, the density (the bit rate of the speed
  zone), SYNC, and byte ready, which also sets the CPU's overflow flag as the DOS and fast loaders wait for it;
- the D64 as the 1541 formats it, GCR-encoded with its SYNC marks, headers and gaps, turning at 300 rpm. The error
  bytes of a D64 that has them become missing headers or data blocks, missing SYNC, bad checksums and wrong IDs.

The drive runs behind the C64 at its own 1 MHz. Whenever the C64 reads or writes the serial port it first catches up
to that cycle, running every instruction whose bus access comes before the C64's; its reads of the head, the timers
and the overflow flag see them as they are in the cycle of the access. So transfer protocols that count cycles work:
Bitfire, Krill's loader, Sparkle, Spindle, the Booze loader and plain KERNAL loads all get through. The file is put in
memory as `LOAD"*",8,1` would leave it (`$ba` is 8, and the drive has read the disk's ID); the program then loads
the rest itself. A program that waits while the drive's motor runs is loading, not settled, for up to 10 seconds.

On the first disk of each of the 190 top-rated demos at CSDB, 151 get further than the boot file with the drive: the
loader loads the next part and starts it. Without the drive, 151 waited in the boot, 35 went back to READY when
their drive code got no answer and 4 crashed; with it 186 run until a part settles, 3 end at READY and 1 runs out of
time. A disk takes about 0.3 s.

## Use

```
node src/cli.ts game.prg
```

```
game.prg: $0801-$2122 (6.3 KB), 2003 SYS2059
ROMs: C:\C64\vice\GTK3VICE-3.10-win64\C64
layer 0  $080b  start           mover
         ran $0101-$012c $080b-$081a $20c9-$2101 (61 instructions), read $1ff9-$2122 (239 bytes), wrote ...
         unknown depacker, fingerprint 7984a862
         called code it wrote: $0101 (jsr)
layer 1  $0143  jmp from $2101  decruncher
         ...
layer 4  $1000  jmp from $0040  program
stopped after 5.2 s of C64 time (137 ms): settled, waits at $1149
saved layer 4: $0800-$e1ff (54.5 KB), start with SYS 4096 = $1000
  -> game.1000.prg
```

| option | |
|---|---|
| `-o FILE` | save here (default: `<name>.<start address>.prg` next to the file) |
| `--file NAME` | the file on the D64 to unpack (default: its first PRG; `*` and `?` as the DOS takes them) |
| `--disk FILE` | put this D64 in the drive for a PRG given on its own |
| `-e ADDR` | start with `SYS ADDR` instead of `RUN` |
| `-l ADDR` | load the file at `ADDR` instead of its own load address |
| `--layer N` | save layer N instead of the newest (the report lists them) |
| `--all` | save every layer |
| `-i` | report only |
| `--clean` | clear the bytes in the saved range that are not part of the program |
| `--deep` | also press keys when a later layer waits (an intro after the decrunching) |
| `--no-keys` | never press keys |
| `--cycles N` | give up after N million cycles (default 400, about 7 minutes of C64 time) |
| `--roms DIR`, `--no-roms` | the C64 ROM files to use, or the built-in stand-ins |
| `--json` | the whole result as JSON |
| `--trace` | every layer change and key press as it happens |
| `--learn NAME` | add the depackers' fingerprints to the signature list as `NAME` |

`node src/cli.ts demo.d64` unpacks a disk's first PRG with the disk in the drive. Addresses can be written `$080d`,
`0x080d` or `2061`. In this folder, `pnpm unpack game.prg` does the same, and
`pnpm --filter @mimir/unpacker unpack game.prg` anywhere in the repository.

### ROMs

The ROM files are not included. The unpacker looks for a VICE installation (in `C:\C64`, Program Files and the usual
Linux and macOS places) and takes `kernal-*.bin`, `basic-*.bin` and `chargen-*.bin` from its `C64` folder, or from the
folder in `$C64_ROMS` or `--roms`, and the 1541's `dos1541-*.bin` from the same folder or VICE's `DRIVES` folder next
to it (without it a disk is not used). Without the C64 ROMs it runs with stand-ins: small replacements for the KERNAL routines packers
call (the interrupt entry, CHROUT, GETIN, clear screen, the jump table) and a BASIC that runs start lines made of `SYS`
and `POKE`. That is enough for nearly all packers, but not for BASIC programs or packers that use ROM code or data.

## Analysis: finding new packers

For every layer the report says what it did:

- **kind**: a *mover* copies (a stub moving packed data, a linker), a *decoder* rewrites data in place (a coder, an
  encryption), a *decruncher* writes more than it reads, a *jump* only passes control on, and the last layer is the
  *program*;
- the code it ran, the data it read and what it wrote;
- the code it wrote and called (subroutines, interrupt handlers);
- the text in and around its code (credits, packer names) and what it printed;
- a **fingerprint**: the opcodes of the instructions it ran, in address order. Operands are left out, so the same
  depacker matches wherever it runs and whatever it unpacks. `data/signatures.json` holds the known ones with their
  names, and a layer that matches one by 80% or more is named. An unknown depacker is listed with the short id of its
  fingerprint, so files packed with the same unknown packer show the same id; `--learn NAME` adds it to the list.

The list was built from about 6000 intros, demos and games: each file was unpacked, and the depacker layer at the
address unp64 names was given unp64's packer name. That gave 321 fingerprints of 135 packers (Exomizer, ECA
Compactor, PuCrunch, the CruelCrunch and Dali versions, ByteBoozer, 1001 CardCruncher, NSU Packer, ...). On 473 other
files the unpacker names 429 packers exactly as unp64 does, 2 by the same family and none wrongly; it names nothing
where unp64 knows no name either.

## Compared with unp64

On 550 intros and demos from a C64 archive, with VICE's ROMs:

| | files |
|---|---|
| the same start address and the same bytes as unp64 | 488 |
| a different start address: a layer deeper, after a second packer, a mover or a decoder (unp64 with `-c` agrees on 11 of them) | 17 |
| nothing to unpack for either (programs that are not packed) | 42 |
| unpacked by unp64 only (an intro that waits for keys it does not read, a reset) | 2 |
| unpacked by this only | 1 |

The saved range differs in 30 of the 488: usually by a few bytes the depacker wrote just below `$0800`, which unp64
always cuts off; once it is shorter, where unp64 saves leftover packed data up to the packer's end pointer. With the
stand-ins instead of the ROMs, 487 files give the same result. A file takes about 80 ms.

`--json` gives all of it (with the full fingerprints) for scripts.

## API

```ts
import { unpack } from './src/index.ts';
import { findRoms } from './src/node.ts';

const result = unpack(prg, { roms: findRoms() });
unpack(prg, { roms: findRoms(), disk: d64 });  // with the disk it came from in a 1541
if (result.saved) save(result.saved.prg);   // load address first; result.saved.entry is the start
result.layers;                              // the report per layer
result.save(2);                             // another layer's PRG
```

`src/index.ts` has no file-system access; `src/node.ts` finds and reads the ROM files, and `src/d64.ts` lists a D64's
directory and reads its files.

## Tests

```
pnpm test
```

The tests build packed programs with a small 6502 assembler (an RLE cruncher whose decruncher runs at `$0100`, stays in
high memory, is called with `JSR` or ends in BASIC's `RUN`, an XOR coder in front of it, an intro that waits for space,
an autostart over the BASIC vectors) and run them with the stand-ins and, when VICE's ROMs are found, with the real
ROMs. When Exomizer is installed, an Exomizer 3 self-extracting file is unpacked too. The drive tests check the GCR
tracks sector by sector, have the DOS read sectors all over a disk, and, with VICE's ROMs, follow a boot file that
loads the next file through the KERNAL and one that sends drive code of its own with `M-W`, starts it with `M-E` and
receives a sector over the serial bus bit by bit.

## Limits

- Without a disk, a program that loads more files (a linker with a loader, a multi-part demo) stops at the load; the
  layer it reached is saved. With one it goes on through the parts until a part settles.
- A program on several disks waits when it asks for the next one (its drive code reads track 18 again and again to see
  the disk change): only one disk is in the drive.
- Copy protections that check what a D64 cannot hold (custom formats, half tracks, timing on the disk; a G64 image
  would), and programs that depend on exact VIC timing (sprite DMA, the cycle within a raster line), may not get
  through. What the drive writes stays in memory; the D64 is not changed.
- An intro that waits for something other than the keys it tries stays where it is; `-e` can start the program behind
  it.

## License

GPL-3.0-only, as Mimir Studio.
