# Mimir Studio: development notes

How the project is built and tested, what every feature does in the code, the end-to-end tests flow by flow, and the
deliberate changes from the prototype engine. For what the app is and how to use it, see the [README](../README.md).
The full technical specification (Swedish) is in [spec.md](spec.md); it is also shown in the app (SPEC.md tab).

## Requirements

- Node.js 22.12+ (Electron 44's minimum) and pnpm 9 (`corepack enable pnpm`)
- Optional: Java + [Kick Assembler](http://theweb.dk/KickAssembler/) `KickAss.jar` (verification against the real assembler, builds)
- Optional: VICE `x64sc` (Build & Run)

KickAss.jar and x64sc are auto-detected under `C:\C64\...` (and `KICKASS_JAR` / `VICE`); change them in **Settings → Toolchain**.

## Commands

```bash
pnpm install
```

```bash
pnpm dev
```

```bash
pnpm test
```

| Command | What it does |
|---|---|
| `pnpm dev` | Starts the Electron app (electron-vite, HMR) with the demo program loaded |
| `pnpm test` | All Vitest suites: core (round-trip, fast-check fuzz, differential vs. the prototype, real KickAss.jar when installed), CLI, desktop main process |
| `pnpm typecheck` | `tsc` for every package (main/preload, renderer and the e2e tests separately) |
| `pnpm build` | CLI bundle (`packages/cli/dist`) and the Electron app (`apps/desktop/out`) |
| `pnpm mimir <cmd>` | CLI from source: `analyse`, `verify [--kickass]`, `export -o <dir>`, `demo` |
| `pnpm --filter @mimir/desktop e2e` | Builds the app and runs the Playwright-for-Electron tests in `apps/desktop/e2e` |
| `pnpm --filter @mimir/desktop package` | Builds the app and packages it for Windows with electron-builder (installer + portable exe in `apps/desktop/release/<version>/`) |

`FUZZ_RUNS=5000 pnpm --filter @mimir/core test` runs a longer fuzz session.

### End-to-end tests (Playwright for Electron)

```bash
pnpm --filter @mimir/desktop e2e
```

The script runs `electron-vite build` and then `playwright test`, which starts `out/main/index.js` with
`_electron.launch` and a fresh `--user-data-dir` per test (no saved settings, no autosaved project, so the demo
program is loaded). No browser download is needed; the tests use the Electron binary from `node_modules`.
To rerun them without rebuilding: `pnpm --filter @mimir/desktop exec playwright test` (`--debug` opens the
Playwright inspector).

| Test | Flow |
|---|---|
| shows the analysed demo listing | the listing appears, the cursor is on `start`, the round-trip is not verified yet |
| rename, mark as bytes, verify, undo and redo | `G` to `var_092d`, `N` renames it and every reference in the listing and the cross-reference panel follows; `Shift+↓` selects `$091e–$0925` and `D` marks it as bytes; `F7` shows "round-trip verified" in the status bar (with KickAss.jar when it is configured); `Ctrl+Z` twice restores the original, `Ctrl+Y` twice brings both edits back |
| select large ranges and merge the blocks inside them into one | two small user blocks are marked inside `$0939–$0ab4`, then `G` with `colors_0939-$0ab4` selects the range and `D` turns it into one Data block (verified with `F7`); after `Ctrl+Z`, `Shift`+click on block headers selects whole blocks, dragging from one header to another selects both and `T` merges them into one Text block, and dragging past the bottom edge scrolls the listing |
| a text block can be set to .byte with D or the inspector | `G` to `txt_0960`, `D` turns the detected Text block into a user Data block with `.byte` rows; after `Ctrl+Z` the inspector's Type → Bytes (.byte) does the same |
| insert a comment line and a comment block, edit and remove them | `/` on `start` writes a `//` line above `start:`, `*` on `sine_09b5` writes a `/* … */` block (`Ctrl+Enter` saves) and `F7` still verifies; double-click edits the line, emptying it removes it, `Ctrl+Z` brings it back; the context menu acts on the line it was opened on |
| Escape closes the right-click menu, and only that: the listing does not go back | after `G` to `$3000` a right-click opens the menu and `Escape` closes it, the cursor staying on its line; the same with the *Memory configuration ($01)* submenu open; a second `Escape`, without a menu, goes back from before the `G` |
| set the memory configuration ($01) code runs with | on the demo's first `sta VIC_BORDER_COLOR` the status bar shows `$01 $37`; right-click → Memory configuration ($01) → `$34` turns it into `sta $d020` and `F7` still verifies; the inspector sets `$35` for the block (the name returns); `Ctrl+Z` twice goes back to the detected `$37` |
| the listing shows memory addresses or line numbers | the left column shows `0810` for `start:`; *Line* numbers every row 1, 2, 3 … like the `.asm` file (blank lines too), the choice survives a reload, *Address* brings the addresses back |
| set the program start by hand | the Explorer shows `$0810 start BASIC SYS`; typing `sub_0866` makes that `start` (the stub becomes `BasicUpstart2(entry_0810)`) and `F7` still verifies; `$9000` is refused; *Clear* goes back to RUN and the detected start (the Explorer line says how Build & Run starts it: RUN or `sys 2150`); right-click → *Set as program start* and *Clear program start ($0866)* work, `Ctrl+Z` undoes |
| show data as code to find code that is marked as data | *Data as code* shows the color table `.byte $06, $0e…` as `asl $0e…` (header tagged *as code*) and `F7` still verifies; `C` marks it as real code, `Ctrl+Z` undoes, *Show as classified* switches back |
| Data as code keeps the line in view where it is on screen, both ways | with the cursor at `$3000`, below the tables and graphics that become many lines of code, its row is at the same height on screen after *Data as code* and after *Show as classified*; scrolled away from the cursor, the top row with bytes stays at its height both ways |
| merge a block with the block before or after it | right-click on `txt_0960` → *Merge with previous block (Text) → Text* gives one Text block `$0949-$0984`, the inspector's *Merge with next* makes it `$0949-$09b4`, `F7` verifies, `Ctrl+Z` twice gives the three blocks back |
| drag a byte at a block's edge into the block next to it | the line `$0960` shows the drag tip; dragged by its address onto the text at `$0949` the block is marked and *↑ Move $0960 into the Text block above* shows, `Esc` cancels; dropped, the text becomes `$0949-$0960`; the table's last line dragged by its bytes gives `$0948` to the text (the table stays a Color table, `$0939-$0947`); dropped elsewhere nothing moves, and dragging the source text still selects; right-click → *Move $0961 into the previous block (Text)*; `Ctrl+Z` three times and `F7` |
| merge a range into one block after confirming it | in `colors_0939`, `M` takes the start and type (Table) from the block, so only the end `$0ab4` is typed; the summary lists the blocks that become one Bytes block; *Back* and *Cancel* change nothing, *Merge N blocks* gives one Data block `$0939-$0ab4`, `F7` verifies and `Ctrl+Z` undoes; a range ending at `$096f` reports the cut `$0970–$0984`, and `$3900` (past the file) is refused |
| patch: new code over the selected lines, marked, saved as a PRG, exported, removed | on `raster-demo.prg`, `fx_091e` and two more lines selected, `P` opens *Patch $091e–$0925* with their code, each line's address and bytes beside it (`091e`, `091e ad 1b d4`, `0921 29 0f`, `0923 8d e7 db`); the cursor is on `lda`, `Tab` goes to `and`, `sta`, round to `lda`, `Shift+Tab` back to `sta`; `Enter` at the end gives a line indented like the others, and `nop` there is `0926 ea`, marked past the range; typing `lda #$02` at `lda` writes over all of `lda SID_OSC3`, which moves to the *Original* column, and editing `and #$0f` to `and #$01` moves it there too (*8 of 8 bytes*); *Keep the cycle count* shows each line's cycles (`2`, `2`, `4`, `2`) and *Cycles 10 of 10, the same as the original* at the bottom, `lda #$02` / `sta $d020` with 3 NOPs is *2 too many*, four `lda #0` leave *2 left to use*, and `bne *+2` (`2/3`) is refused on line 1 (the original has no branch); 9 bytes are refused until *Overwrite past the range* is ticked (*9 of 8 bytes; 1 byte past the range, over $0926*); `lda #$02` / `sta $d020` named *red border* is *5 of 8 bytes; the other 3 become NOP ($ea)*; the listing has the `==== patch "red border"` line, five rows marked *patched* and the *patch red border* tag, Explorer → Patches lists it, `F7` verifies; `P` on it edits it (`inc $d020`); its switch in the Explorer turns it off (no row marked, `lda SID_OSC3` back, *0 of 1 on*) and on again; *Save as PRG* writes `1e 09 ee 20 d0 ea ea ea ea ea`, the export `patches/red_border.asm` (`.pc = $091e "red border"`, `inc $d020`, `.fill 5, $ea`) and `original/raster-demo.prg` as loaded; *Remove* brings the bytes back and `Ctrl+Z` the patch |
| patch with the cycle count kept, where the original has a branch: the code must have the same branch | on the demo's first `inx` / `bne` loop, *Keep the cycle count* shows *varies as the original: bne (2/3)* and *the same as the original*; `iny` over `inx` keeps it so, `nop` over the `bne` gives *the code needs bne (2/3), as the original has* and *Apply patch* is disabled |
| real addresses instead of the hardware include file | Settings → Kick Assembler output → *Real addresses* turns `sta VIC_BORDER_COLOR` into `sta $d020` with the comment *Border color* (hovering `$d020` names `VIC_BORDER_COLOR`), the `#import` line goes away and `F7` verifies; choosing the include file brings the names back |
| save a block as a binary file loaded with .import binary | the inspector's *Save as a binary file* on `sine_09b5` shows the *binary* badge and `.import binary "data/sine_09b5.bin"`, `F7` verifies; the export writes `data/sine_09b5.bin` with the table's 256 bytes; unticking writes it in the source again |
| F7 right after an edit verifies that edit | `D`, `W` and `T` on three ranges, each followed at once by `F7`: every time the status bar shows "✓ round-trip verified" for the edited state (verification waits for the analysis of the edit) |
| comment a zero-page variable on its .label line, with the keys, the menu and the inspector | a click on `.label ptr_fb = $fb` shows *Zero-page variable* in the inspector; `;` opens *Comment at $fb* (marked editor) and writes `// screen pointer` at the end of the line, `/` puts `// set by the raster irq` above it; the inspector shows both, its *Comment* makes it two lines and its *End-of-line comment* changes the other; right-click → *Insert comment block above the .label line…* opens the two lines as a block; `F7` verifies; `Ctrl+Z` brings back `// screen pointer` |
| rename a zero-page variable from its .label line | `.label ptr_fb = $fb` carries the *zero page* tag; a double-click opens *Zero-page variable at $fb* (marked editor), `start` is refused as taken, `fx_ptr` renames `sta fx_ptr+1` too and `F7` verifies; `N` and right-click → *Rename zero-page variable…* work on the line, empty restores `ptr_fb` |
| click the +offset after a label to go to label + offset | on `inc smc_08ef+1` the label goes to `$08ef`, the `+1` (its own link, titled *Go to $08f0 (smc_08ef+1)*) to `$08f0` |
| bookmarks: notes on addresses, listed by address, a click shows the note and a double-click goes there | `B` on `start` opens the *Add bookmark* editor in the sidebar, titled `start` and focused, with the `jsr CLRSCR` line visible beside it; a click on `jsr sub_0866` and *Cursor line* make the address `$0813`, `Esc` closes it without saving; again on `start` (`$0001` is refused as not loaded), `Ctrl+Enter` saves it and the row gets the margin mark, the activity bar shows 1; right-click → *Add bookmark…* on `sine_09b5`; `Ctrl+B` lists `$0810 Set up`, `$09b5 sine_09b5`, a click shows the whole note and another hides it, a double-click goes to `$09b5`; `F2` / `Shift+F2` go round them; the margin mark opens the note in the list; `B` on the line edits it, *Delete* removes it and `Ctrl+Z` brings it back |
| fold and unfold blocks | the header button folds `sine_09b5` ('33 lines folded') and unfolds it; `F` folds the block at the cursor, the arrow keys stop on the folded header, `G` to `$09c5` unfolds it; the palette folds every non-code block and unfolds all |
| exclude a block from the build | right-click on `sine_09b5` → *Exclude block from the build*: the header says *not built*, the listing shows `#if INCLUDE_sine_09b5`, `.label sine_09b5 = $09b5`, `#endif` and `// #define INCLUDE_sine_09b5`; `F7` verifies with '(256 bytes left out of the build)'; the inspector's *Include in the build* puts it back |
| text in mixed case | the inspector turns `txt_0985` from *Text (screen codes)* into *Text (screen codes, mixed case)*: `.encoding "screencode_mixed"` and `.text "hello from the mimir studio demo!   enjoy!!"`, the preview follows, `F7` verifies |
| open a PRG, save and export through stubbed file dialogs | `dialog.showOpenDialog`/`showSaveDialog` are replaced in the main process (`electronApp.evaluate`), then `Ctrl+O` loads `fixtures/prg/raster-demo.prg`, `Ctrl+S` saves the project and `Ctrl+E` verifies and exports it to a temp folder (no `NOTES.html`: nothing to put in it) |
| the export writes NOTES.html, or NOTES.txt when set, with the bookmarks and comments | a bookmark on `start` (with `<raster>` in its note) and a comment line above it; the export's `NOTES.html` has the title, the escaped note, `raster-demo.asm, line N` for the `jsr CLRSCR` line, the export time and the comment line; the bookmark is not in the `.asm`, the comment is, and README.md names `NOTES.html`; after Settings → *Bookmarks and comments in the export* → NOTES.txt the export writes `NOTES.txt` instead (the note as written, `>` on line N) and README.md names it |
| the Terminal button opens a terminal in the project folder | `child_process.spawn` is wrapped in the main process so no window opens: before any dialog the terminal starts in the home folder (`cmd.exe` with `start "Mimir Studio" /D … powershell.exe -NoLogo -NoExit -Command …`), after `Ctrl+E` in the exported folder |
| edit build.bat in the source view: the export writes it, Restore generated takes it back | the source view says *read-only* for the `.asm` and *Editable* for `build.bat`; typing `rem my own step` at its end makes it *Edited by you*; the export writes that `build.bat` (and keeps it in the `.mimir.json`) while `build.sh` stays generated; *Restore generated* brings the generated script back |
| pack with Exomizer: the whole build or chosen blocks, checked with desfx, saved with a dialog | Settings shows an Exomizer (the installed app's `resources\exomizer\exomizer.exe`); the Pack view shows `exomizer sfx sys -o raster-demo-exo.prg raster-demo.prg`, *Pack* builds, packs and reports *Decrunched by desfx: $0801–… has the same … bytes, and it starts at $0810*, the build output has the command, and *Save as…* (stubbed dialog) writes a PRG loading at `$0801`. *Chosen blocks*: right-click → *Pack block with Exomizer* on `$0810`, a warning that the BASIC line is left out, *Selection* `$0810–$37ff` from *Go to*, a block unticked and ticked again, *Jump to* `$0810` and no effect give `sfx $0810 -n … raster-demo.prg,$0810,15,12272`, packed and checked again; `Ctrl+Z` undoes the effect and the saved project keeps `pack` |
| a VICE quicksave (Alt+F11 in VICE) opens by itself, F9 opens it again, Ctrl+Z goes back; the newest are kept, named, saved and made favourites | Settings → *VICE quicksave snapshot* set to a file in the test's folder (every test's profile already points it at a file of its own, so the user's VICE folder is never read); the Explorer's *VICE quicksave* section explains Alt+F11, says *None yet* and its *Open the latest quicksave* button is disabled, then shows *Latest: today hh:mm:ss* after the save; `F9` says *No VICE quicksave yet …* with that path; copying `fixtures/vsf/raster-demo.vsf` there opens `quicksave.prg` by itself (*Opened the VICE quicksave from … traced from $08c7, $08b7. Ctrl+Z goes back to the project before*); `Ctrl+Z` brings `raster-demo.prg` back and `Ctrl+Y` the quicksave; with *Open each new one* unticked a new quicksave is only announced and `F9` opens it; both are then in the list of kept quicksaves, the newest first (`quicksave 2026-…`), the newest renamed *intro* and saved through the save dialog as `intro.vsf` with the snapshot's bytes, and the older one opened with a click; the star (*Add the quicksave intro to the favourites*, `aria-pressed`) moves *intro* to the *Favourite VICE quicksaves* list above the newest, where it opens, and taking the star off brings it back among the newest |
| the Demo button opens the showcase: every block type and a guided tour in the Bookmarks view | *Demo* loads `mimir-showcase.prg` with the toast about the tour; the Bookmarks view lists 15 stops starting with *Welcome to the showcase* and `F2` goes to the next one; the Blocks view has BASIC, Code, Text, Data, Word table, Table, Lo/Hi table, Sprites, Charset, Bitmap, Screen matrix, Music (SID) and Fill; `F7` verifies |
| Ctrl+C copies the selected lines of the listing as source, and the line at the cursor without one | `fx_091e` and Shift+Down ×3 (*sel $091e–$0926*): Ctrl+C says *Copied 6 lines to the clipboard*, and the clipboard holds the block header, `fx_091e:`, `lda SID_OSC3` with its comment, `and #$0f`, `sta COLOR_RAM+24*40+39` and `rts`, indented as in the source; right-click in the selection offers *Copy 6 selected lines*; with no selection, Ctrl+C on `$0923` copies `sta COLOR_RAM+24*40+39` |
| the Memory tab shows the program as the VICE monitor does: m, i and ii | the `$0801` row reads `>C:0801  0b 08 0a 00  9e 32 30 36  34 00 00 00  00 00 00 20   .....2064...... ` and `MIMIR ST` shows at `$0941`; a click on `$0810` puts the cursor there (`$0810 = $20 · 32 · %00100000`), → moves to `$0811`, Shift+↓ selects `$0811–$0821`, Esc clears; `m 0985 09a4` selects `txt_0985`, *Copy selection* puts its two rows on the clipboard as VICE writes them; `ii 0985` shows `HELLO FROM THE MIMIR STUDIO DEMO` (lower case with *Lower case*), `i 0801` 40 bytes a row, `m nowhere` an error; `m 3000 3007` → *Mark as Bytes*, `m 0810` starts a row at `$0810`, and a double-click goes to `$0810` in the listing |
| the Graphics tab draws a font per row | *Font per row*: the codes at `$0400` are not loaded (`not loaded: 0–39`); the block menu next to *Screen codes* lists the Text blocks first and Code last, and picking `$0985 txt_0985 · 48 bytes` sets the field; *Previous block* steps to `$0960`, `$0949`, `$0400` (then it is disabled), *Next block* and the mouse wheel step down again (a typed `$0990` shows *Blocks…*; after `$0985` comes the data at `$092d`); with `txt_0985` and the first font at `$3000` the picture has 22 rows (`skipped $9000, $9800, $d000, $d800`), then 4 (`$3000`, `$3800`, `$4000`, `$4800` in the margin); hovering says `row 0, column 0: char $08 of the font at $3000`; a click selects a row's font (`$3800–$3fff`, then `$3000–$37ff · Charset charset_3000`), *All 4 rows* all of them; row 0 saved as a 320 × 8 PNG; from `$0800` the rows are `$0800`, `$2000`, `$2800`, `$3000` (`skipped $1000, $1800`: the VIC sees the character ROM there), without *Skip where no font can be* `$0800`, `$1000`, `$1800`, `$2000`; a first font at `$1000` starts at `$2000` |
| the Graphics tab finds screens and saves them like the other graphics | *Screens* draws a screen per 1 KB; the charset can be the C64 ROM (from VICE), the built-in letters, `$3000 charset_3000` or any 2 KB; going to `txt_0985` moves the grid so a screen starts there (offset 389), hovering says `row 0, column 2 of the screen at $0985`, `$0400` says `$d018 = $1x in VIC bank 0`; *Save…* gives .bin (the 1000 bytes), .prg (`$0985`), .png (320 × 200) and .asm (25 rows of 40), *With the sprite pointers (1 KB)* takes 1024 bytes |
| the Graphics tab saves its selection: bytes, with a load address, a Koala picture, a PNG image and .byte source | the whole charset at `$3000`: *Save…* lists Raw bytes (.bin), Charset with its load address (.64c), Image as shown here (.png) and Kick Assembler source (.asm), `Esc` closes it; the .bin is the 2048 bytes, the .64c starts with `$3000`, the .asm has `charset_3000:` and one binary `.byte` a line (stubbed save dialog, suggested name `charset_3000.bin`); the sprite at `$2000` as a 24 × 21 PNG; the bitmap at `$2000` in multicolour as a 10003-byte Koala picture (`$6000`, screen `$fc`, colour RAM `$01`, black) |
| the Graphics tab keeps the address you scrolled to at the top when the view changes | Characters scrolled 1600 px down shows `$7d00` at the top; Sprites shows the row with it, Bitmaps `$6000`, Screens `$7c00`, Characters again `$7d00`, 16 a row still `$7d00`; scrolling to 160 px sets `$0500`, which Sprites and back keep |
| the Graphics tab shows memory as characters, sprites or bitmaps, and marks what it finds | *Characters*: 40 a row by default; *Go* `$3000` selects `$3000–$3007` (in `charset_3000`), *Whole charset (2 KB)* makes it `$3000–$37ff` (7 row rectangles), *Mark as Charset* marks it; the picture is 640 px wide at zoom 2, *Other…* with 48 and Enter makes it 768 px, ↓ 752 px, 500 is not taken (the field turns red), 16 hides the field; *Sprites*: hovering the sprite at `$2000` names sprite pointer `$80` in VIC bank 0, a click selects `$2000–$203f`, Shift+click the next sprite `$2000–$207f`, *Mark as Sprite data*; *Bitmaps*: *Go* `$2000` selects the 8000-byte frame, *Show in listing* goes to the user-set Sprite block and `F7` verifies |
| Build & Run restarts a VICE snapshot as it was taken | with a stand-in for VICE (`where.exe`): the Build & Run button's tip says it restarts the snapshot; F5 after opening `fixtures/vsf/raster-demo.vsf` gives *VICE restarted the snapshot as it was taken (PC $08c7, $01 = $37), with the built program in its RAM*, and the `.vsf` in the build log is the snapshot that was opened (the program is byte-identical) |
| the Explorer's sections say what they hold and fold up, and stay folded | Files says *1 file*, Loaders *none found*, Program start *$0810*; the Loaders title folds the section (`aria-expanded` false, its text gone, the summary kept), it is still folded after Blocks and back, and opens again |
| loaders: the Explorer names the loader and lists its parts, which the listing and the source mark | the raster demo has none; `fixtures/prg/loader-demo.prg` shows *Spindle (lft)* (2-bit + ATN …) with its installer, two drive commands, `$0c00–$0cff` on the C64 and its drive code at `$3000`; a part goes to the listing, where `// ==== Spindle (lft): resident page (jsr here to load the next part) ====` and the header's *Spindle* mark it; the analysis log names it and `F7` verifies |
| the Spindle script: a tab when Pefchain drivers are in memory, a row per script line that goes to its driver | the demo has no *Spindle script* tab; `fixtures/prg/spindle-demo.prg` (the drivers pefchain 3.1 built for five test parts) has one with 6 rows: `part1.pef space`, `part2.pef f0 = 05`, `\| f0 = 20`, `part3.pef -`, `part4.pef @`, `- stay`, then *its \| line* and *the end of the demo*; a row goes to `$1201 · part3_driver`, marked `// ==== Spindle part 3: its driver (script line "part3.pef -") ====`, and `part4_fadeout` to `$1314`; *Copy script* copies the script with `part1.pef     space      # driver $108c: …`; `F7` verifies; the demo again has no such tab and shows the log |
| a mounted Spindle 3 disk: its load script in the Spindle script tab, each chunk opened as a PRG | `fixtures/d64/spindle-demo.d64` (written by `test/helpers/spindle-disk.ts`) mounts with *a Spindle 3 disk with 4 jobs*; the Explorer's *Load script* opens the tab with *4 jobs, 6 chunks*, the chunks `job01_0800.bin` … `job04_cf00.bin`, job 3's labels `02:` and `1f:` and job 4's *then jumps to $307a · loads under I/O*; a row opens `job01_0800.prg` at `$0800`, + adds `job02_4000.prg`; *Copy script* copies `# spin -e 0800` and a line per chunk; *Eject* takes the tab away |
| the Raster IRQs panel lists every IRQ handler with its $d012 and $d011 and goes to it | the demo: *1 raster interrupt, 1 handler*, the row `98 ($062)`, `$62`, `$1b`, `irq_08b7`, `$0836`, *main code via $0314*; clicking `irq_08b7` and `$0836` moves the cursor there |
| the Memory tab finds text as PETSCII and as screen codes, and bytes, and steps through the hits | `mimir` gives *2 matches*; Enter selects `$0949–$094d` (*1 of 2 matches · PETSCII*), Enter again `$0994–$0998` (*screen codes*), Shift+Enter goes back, and 10 bytes are coloured; *Bytes* `8d ?? d0` has hits and *Next match* steps; `8d 2` says *is not a byte* in red; Esc empties the field |
| the inspector writes a table in binary or decimal and words as numbers, several a row | the colour table at `colors_0939` is *Hex*; *Bin* gives `.byte %00000110, %00001110, %00000011…`, *Bytes per row* 4 gives `.byte %00000110, %00001110, %00000011, %00000001`; `W` makes it words (*Addr*: `.word $0e06`), *Dec* and *Words per row* 4 give `.word 3590, 259, 3587, 6`; `F7` verifies, `Ctrl+Z` twice goes back to `.word $0e06` |
| the tab row fits a small window: the listing tools lose their labels, then move into the ⋯ menu | at the default size every tool is in the row; at 1366 px *Listing tools* (⋯) holds them and the row does not overflow, *Cycles* is checked in it after a click, and the button closes the menu again; at 1100 px the tabs show only icons and *Graphics* still opens by name |
| open a VICE snapshot like a PRG | *Open PRG…* (stubbed dialog) on `fixtures/vsf/raster-demo.vsf` (x64sc 3.10, stopped in the demo's raster IRQ) loads `raster-demo.prg` at `$0200`: the toast names the snapshot, the entry points `$08c7` and `$08b7` and the program start `$0810` (from its BASIC line), the Explorer says Build & Run restarts the snapshot as it was taken (PC `$08c7`, `$01 = $37`), `irq_08b7` is code and `F7` verifies; with *include the zero page and the stack* ticked the same snapshot opens at `$0002–$ffff` and `F7` verifies again |
| deep analysis from the Problems tab | `fixtures/vsf/raster-demo.vsf` shows 4 problems (*BRK at $ffd2 …*: the snapshot's RAM under the ROMs is traced); ticking *Deep analysis* over the list gives *4 → 0 problems in 3 rounds, … s*, *No problems found.*, the log line *The JSR at $088f to $ffd2 reaches the KERNAL ROM there …*, and `F7` verifies; *Settings → Analysis* shows it ticked, and unticked there the 4 problems are back |
| cycle counting: cycles per line, a block's total, and branches taken or not | *Cycles* shows `6` on `inc VIC_IRQ_STATUS`, `4+` on `lda colors_0939,y` and `2/3` on `beq loop_08c2`; the `sub_0866` header counts `$0866–$08ad`: 104 cycles (status bar too); clicking `beq skip_0895`'s `2/3` marks it taken: 95, the skipped lines are dimmed and the inspector's box is ticked; unticking it gives 104 again; *Cycles* off removes the column and the section |
| timing code: a delay a timer sets the branch into is marked, and what it reads gets no label | a PRG written by the test (`lda $dc06 / eor #$07 / sta smc+1 / bpl * / lda #$a9 / lda #$a9 / lda $eaa5`, loaded up to `$eaff`) shows `bpl delay_0817` with *0-7 bytes into the delay, by CIA1_TB_LO ($dc06)*, the comment line *delay: the bpl at $0815 goes 0-7 bytes into it … 8 down to 0 cycles*, three rows marked *delay*, `lda $eaa5` and no `data_eaa5`; `F7` verifies |
| Problems warns when bank tracking is off and I/O is written as labels, and turns it on | a dump from `$0801` over `$d000-$d02f` (written by the test) with *Follow the memory configuration* unticked shows `sta …_d020` and a Problems row *Bank tracking is off … 2 I/O addresses … written as labels* (address `$d020`); its *Turn on* button ticks the setting, the row goes away, the listing shows `sta VIC_BORDER_COLOR`, and `Ctrl+Z` brings the row back |
| the installed app comes with unp64, and the unpacker setting points to it | only with `MIMIR_E2E_EXE`: `resources\unp64\unp64.exe` and `unp64.txt` are installed, a fresh profile shows that path and `{in}` in Settings, and *Unpack with unp64* turns `packed-demo.prg` back into the demo starting at `$0810` |
| a packed PRG is reported and unpacked with an external unpacker | `fixtures/prg/packed-demo.prg` (the demo packed by `fakePack`, a real 6502 decruncher) shows *packed-demo.prg is packed.*, the *packed* badge and a Problems entry; with the unpacker cleared in Settings, *Set up an unpacker…* opens the settings, where it becomes Node with `packages/core/test/helpers/fake-unp64.cjs {in}` (a stand-in that writes and prints like unp64); *Unpack* opens `packed-demo-unpacked.prg` with the start `$0810`, names the packer (FakePack), shows the output, and `F7` verifies |
| file dialogs open in the folder they were last used in | the stubbed dialogs record their options: the first Open PRG has no start folder, Mount D64 then starts in the PRG's folder, Open PRG again in `fixtures/prg` and Mount D64 in `fixtures/d64`; `recent-folders.json` in the profile holds both for the next start |
| mount a .d64 and open its PRG files | *Mount D64…* (stubbed dialog) lists `fixtures/d64/mimir-demo.d64`: `"MIMIR DEMO"`, `49 "RASTER DEMO" PRG`, `1 "SPRITE" PRG`, `1 "NOTES" SEQ` (not openable), 613 blocks free, in a *Disk* section right under Files (above *VICE quicksave*); a click opens RASTER DEMO, + adds SPRITE at `$c000`, `F7` verifies; *Eject* removes the disk and keeps the project |

The e2e tests are not part of `pnpm test`. Build & Run (`F5`) is not covered because it starts VICE. Failures
attach a screenshot of the window; results go to `apps/desktop/test-results/`.

### Windows package (electron-builder)

```bash
pnpm --filter @mimir/desktop package
```

The script runs `electron-vite build` and `electron-builder --win` with `apps/desktop/electron-builder.yml`. It
writes to `apps/desktop/release/<version>/`:

- `Mimir-Studio-<version>-setup.exe`: NSIS installer (per user, installation folder can be changed, Start menu
  and desktop shortcuts)
- `Mimir-Studio-<version>-portable.exe`: single exe that runs without installing
- `win-unpacked/`: the unpacked app (`Mimir Studio.exe`)

The installer also contains unp64 2.40 (iAN CooG) in `resources\unp64\`. It comes unchanged from
`apps/desktop/vendor/unp64` via `extraResources`, with its `unp64.txt` notice. Its license (Exomizer's) allows free
distribution for non-commercial use only. On the first start after an install, the app points Settings → Toolchain →
Unpacker at it. That replaces an empty or missing unpacker, or another copy of unp64, and happens once
(`bundledUnpacker` in `settings.json`). After that, whatever is picked in Settings is kept.

Exomizer 3.1.1 (Magnus Lind) is in `resources\exomizer\` the same way, from `apps/desktop/vendor/exomizer` with its
`LICENSE.txt` (the same non-commercial license). Settings → Toolchain → Exomizer points at it unless another one is set;
a setting that points at a file that is gone gets the bundled one, and an empty setting is kept.

The package holds `out/` and the production dependencies (only `zod`; `@mimir/core` is bundled into `out/` by
electron-vite, so it is a dev dependency). Electron is taken from `node_modules/electron/dist`. Electron 44 has no install
script: it fetches its binary the first time it is required, so the package script does `node -e "require('electron')"`
before electron-builder (a fresh clone has no binary until then). The NSIS tools are downloaded once into the electron-builder cache. The exe is not code-signed. Its icon is the Mimir Studio logo:
`apps/desktop/build/icon.svg` is the source, and `npx electron scripts/make-icons.cjs` (in `apps/desktop`) draws it into
`build/icon.png` and `build/icon.ico` (16-256 px) with Electron's own Chromium; the title bar draws the same logo
(`src/components/Logo.tsx`). Like `pnpm dev`, the packaged app keeps its settings in
`%APPDATA%\@mimir\desktop\settings.json` (the app name comes from `package.json`); KickAss.jar and x64sc are found the
same way as in development.

The program was called KickReasm Studio before. On its first start, Mimir Studio copies that name's settings once
from `%APPDATA%\@kickreasm\desktop` (`settings.json`, `recent-folders.json` and the window's preferences in
`Local Storage`, not the caches; `electron/main/migrate.ts`), and it opens projects saved then (`.krproj.json`, format
`kickreasm-project`) and saves them as `.mimir.json`.

The e2e tests also run against a packaged app: set `MIMIR_E2E_EXE` to its exe, for example
`release/1.0.0/win-unpacked/Mimir Studio.exe` (relative to `apps/desktop`) or an installed copy, and run
`pnpm --filter @mimir/desktop exec playwright test`.

## Layout

```
packages/core    @mimir/core: pure TypeScript engine (no DOM, no I/O)
  src/cpu        opcode table, decoder
  src/c64        symbols, BASIC, PRG, PSID
  src/analyze    memory, trace, evidence, pointers, music, vic, classify, labels, diagnostics
  src/render     line model -> Kick Assembler (kick.ts, lines.ts, include.ts)
  src/verify     Kick-subset assembler, round-trip verify, KickAss output parser
  src/node       '@mimir/core/node': spawn KickAss.jar / x64sc (argv arrays, no shell)
  test/          Vitest + fast-check; reference/ holds the original prototype engine as an oracle
packages/cli     mimir command line (tsup bundle)
apps/desktop     Electron app
  electron/main  window, IPC allowlist (zod), path policy, toolchain runner, settings, file watcher
  electron/preload  contextBridge -> window.kr
  shared/ipc.ts  the typed IPC contract (spec 13.4)
  src/           React 18 renderer: components, Zustand + Immer stores, analysis Web Worker (Comlink), Monaco
  test/          Vitest: main-process logic, undo/redo
  e2e/           Playwright for Electron: UI flows in the built (or packaged) app
  electron-builder.yml  Windows packaging (NSIS installer + portable exe)
docs/spec.md     technical specification
fixtures/prg     test programs (raster-demo.prg, and the loader, packed and Spindle demos)
fixtures/d64     disk images (mimir-demo.d64, and spindle-demo.d64, a Spindle 3 disk)
```

## Architecture notes

- **One line model, two views.** `render()` produces `Line[]`; the listing renders the tokens interactively and the
  `.asm` files are the same lines as text.
- **Worker.** The renderer posts the project to `analysis.worker.ts` (debounced 30 ms). `analyze()` re-runs only when
  files, overrides, entries, bank zones or settings change; renames and comments only re-render.
- **Build & Run with a program start.** When the program start is set by hand (Explorer → Program start), VICE loads
  the PRG without RUN and types `sys <start>` (`-autoload … -keybuf "sys2150\n"`); without it (or after *Clear*) the PRG is autostarted as
  before. A PRG that overwrites BASIC's work area ($0002-$03ff, a memory dump say) leaves no BASIC to type into (nor
  to RUN it), so VICE stops at READY (`-initbreak ready`) and runs `out/<name>.start.mon` instead: the labels, then
  `l "<prg>" 0` and `g <start>` in the monitor. Without a program start such a PRG gets a warning to set one.
  `packages/core/test/vice.integration.test.ts` checks all of this in the real x64sc when it is installed
  (headless, with its own config file, so nothing is written to your `vice.ini`).
- **Patches.** `P` (or right-click) on selected lines opens the patch dialog (`components/Patch.tsx`) with their code.
  `assemblePatch` in `packages/core/src/patch.ts` assembles it at the range's start with the built-in Kick-subset
  assembler, with the program's labels and zero-page variables and the hardware include at hand (names the code
  defines win), a label before each line telling where the line goes: the editor's address and bytes column.
  `planPatch` checks the length, the file and the other patches. `withPatch` writes it over the file's bytes and keeps
  the bytes it wrote over, so `withoutPatch`, `switchPatch` (off and on) and an edit put them back; `Project.patches`
  keeps them (base64 in `.mimir.json`, `off` for one switched off). The render marks each one that is on with
  `==== patch` lines; the export writes each patch's source to `patches/<name>.asm` (`patchSource`: the names it uses
  as `.label` lines, `.pc`, the code and the NOP fill, or its bytes as `.byte` lines when a name is gone), which
  assembles on its own, and the unpatched files to `original/`. See spec 10.2.
- **Disk images.** Mount D64… (or drop a `.d64`) lists the disk's directory in the Explorer, right under Files, the way the 1541 lists it.
  Click a PRG to open it, or + to add it to the project. `packages/core/src/c64/d64.ts` reads 35/40/42-track images,
  with or without error bytes, and follows each file's sector chain. While a disk is mounted, Build & Run puts a copy
  of it in VICE's drive 8 (`-8`), so programs that load more parts from disk find them, and types
  `open15,8,15,"i":close15:` before `run` (or `sys`): the drive reads the disk first, as loading from it would have
  made it, which fast loaders such as Sparkle need. See spec 13.5.
- **VICE snapshots.** *Open PRG…* and drag and drop also take `.vsf` files. `openC64File()`
  (`packages/core/src/c64/vsf.ts`) reads the snapshot's C64MEM and MAINCPU modules and opens its RAM from `$0200` as
  `<name>.prg`, or from `$0002` (zero page and stack included) with Settings → Analysis → *VICE snapshots: include
  the zero page and the stack*. The PC and the IRQ/NMI handlers its vectors point to in RAM become entry points. A BASIC line at
  `$0801` gives the program start for the analysis. The snapshot is kept with the project, and Build & Run restarts it as
  it was taken: `patchSnapshot()` puts the built program in its RAM and VICE loads it with `-autostart <name>.vsf`, so the
  CPU, `$01`, VIC, SID, CIAs, colour RAM and drives are as they were and the program goes on from the PC. Checked
  against an x64sc 3.10 snapshot in `fixtures/vsf`; see spec 13.7.
- **Music.** `detectMusic()` (`packages/core/src/analyze/music.ts`) finds a player by its jump table (`JMP init`, then
  `JMP play`, up to four JMPs, or the play code right after them) and decodes the code its entries reach where the trace
  did not get to it. A snapshot taken after init ran, a play called from an interrupt the trace missed and a player
  nothing traced reaches are found too. Play is the entry the IRQ calls (traced, or the vectors in a snapshot), else one
  the program or untraced code calls. The note frequency table every tracker player has counts. The program's start-up
  table, a routine that calls init and play, and a JMP pair in other code are not taken for players. On 57 real
  releases with a `.sid` next to them it finds 54 right (30 before). See spec 8.6.
- **Raster IRQs.** The bottom panel's *Raster IRQs* tab lists every IRQ handler with the raster line it runs at:
  `$d012` and `$d011` (bit 7 is bit 8 of the line, followed through `and #$7f` / `ora #$80`) where its vector is set,
  who sets it (the main code, the handler before it in a raster chain, or the handler itself) and where. A row goes to
  the handler. `rasterIrqs()` in `packages/core/src/analyze/raster.ts`; see spec 8.11d.
- **Loaders.** `findLoaders()` (`packages/core/src/analyze/loaders.ts`) names the loader a program uses: Spindle (2 and
  3), Krill's loader, Bitfire, Sparkle and the Covert Bitops loader by their own receive loops and install commands (the
  byte patterns come from their sources), any other disk loader by its 1541 drive code, `M-W`/`M-E`/`M-R` commands, KERNAL
  serial calls and `$dd00` receive loop, a tape turbo by CIA1's FLAG line and a timer, and the KERNAL's LOAD. Explorer →
  Loaders lists them with their parts; the listing and the exported source mark where each part starts and ends
  (`// ==== Bitfire (Bitbreaker/Oxyron): … ====`). A packed program's loader shows once it is unpacked. See spec 8.11c.
- **Packed programs.** `detectPacking()` (`packages/core/src/packing.ts`) reports a decruncher in front of compressed
  data. The signs are 1 KB windows with at least 7.2 bits/byte, almost no code that can be traced, and packer names in
  the bytes. The app shows a notice above the listing, a *packed* badge in the Explorer and a Problems entry, and
  `analyse` prints a `[pack]` line. When the unpacker is unp64, `unp64 file -i` also names the packer of every file opened.
  **Unpack with unp64** runs the external unpacker set in Settings → Toolchain on a copy of the PRG. It uses `{in}`/`{out}`
  in its arguments, picks up the file it wrote with its start address (`name.prg.xxxx`, or "return to mem: $xxxx"), and
  opens the result with that start. Checked against unp64 on 100 archive PRGs; see spec 8.11b.
- **Terminal.** The title bar's Terminal button opens PowerShell (through `cmd /c start`, so it gets a console of its
  own) in the last export folder, else the project's folder, else the folder last picked in a dialog. VICE is on PATH
  there and `kickass <file.asm>` runs KickAss.jar with the configured Java (`packages/core/src/node/terminal.ts`, spec 13.6).
- **Memory configuration.** `analyze/banks.ts` follows `$01` and the VIC bank (`$dd00`, the `$dd02` trick) along the
  traced code, through subroutines and into interrupt handlers, and the user can set them for a range (right-click →
  Memory configuration ($01) / VIC bank). Operands in `$a000-$bfff` and `$d000-$ffff` are named by what the instruction
  reaches: `sta VIC_BORDER_COLOR` with I/O banked in, `sta $d020` with RAM there, `jsr $ffd2` with the KERNAL out. Such
  an access to I/O or ROM makes no label in the program's bytes below either, so a block over `$d000-$dfff` in a memory
  dump is not split by `charset_d020:` lines (or `.label` lines when it is a binary file). Names never change bytes. Details in `docs/spec.md` 8.7b; the setting `bankTracking` turns it off.
- **Zero-page variables.** Their `.label name = $xx` lines in the file head can be renamed (`N`) and commented like a
  block: `;` at the end of the line, `/` or `*` above it, or the inspector's *Zero-page variable* section after a click on
  the line. The comments are kept at the variable's address and written only on its `.label` line (spec 10).
- **Bookmarks.** `Project.bookmarks` holds a title and a note per address. They are saved in the project file and never
  reach the source (`render()` does not read them). `B` adds or edits the one on the cursor line in an editor at the top of the Bookmarks view, beside the code, and the line gets a
  mark in the left margin. The Bookmarks view (`Ctrl+B`) lists them by address: a click shows the note, a double-click
  goes there, and `F2` / `Shift+F2` step through them (`src/components/Bookmarks.tsx`, spec 10). The export writes
  `NOTES.html` (`packages/core/src/notes-doc.ts`, spec 11.4). It is a self-contained page with the bookmarks and the
  comments, each with the code around it. Line numbers and syntax colours come from the exported `.asm` files.
  Settings → Kick Assembler output → *Bookmarks and comments in the export* writes `NOTES.txt` (plain text) instead,
  or no document.
- **Packing with Exomizer.** The Pack view packs the PRG that Build & Run builds, whole or the blocks you tick (or add
  from the listing's selection or right-click menu), as a self-extracting program (`sfx`: start by the BASIC line's SYS,
  RUN or a jump; effect, `$01` and interrupts after decrunching) or as crunched data for `exodecrunch.s` (`mem`). It
  shows the exact command (`file.prg,$addr,offset,length` for a range). *Pack* builds and verifies first, then the main
  process runs Exomizer in a folder of its own. An sfx is checked with Exomizer's `desfx`, whose 6502 emulator must
  decrunch the same bytes and start where Exomizer said. The result can be run in VICE or saved (`packages/core/src/pack.ts`,
  `src/components/Pack.tsx`, spec 13.8).
- **Build scripts.** In the source view `build.bat` and `build.sh` can be edited; everything else is read-only (it is
  rendered from the listing). The edit is kept in the project (`Project.scripts`, undoable) and the export writes it
  (`projectScripts`). *Restore generated* goes back to the script made from the toolchain settings.
- **VICE quicksave.** Alt+F11 in VICE (Snapshot → Quicksave snapshot) writes `C64SC.vsf` in VICE's settings folder
  (`%APPDATA%\vice`). The app watches it and opens each new one as a snapshot, undoably (Ctrl+Z goes back); `F9` or the
  Explorer's *VICE quicksave* section opens the newest, and *Open new quicksaves automatically* there turns the watching off (`electron/main/quicksave.ts`, spec 13.7b).
  The newest 5 are kept in the app's own folder (`QuicksaveHistory`), with names; a star makes one a favourite, which
  newer ones never push out.
- **Showcase demo.** *Demo* in the Explorer opens `showcaseProject()` (`packages/core/src/showcase.ts`), a C64 intro built from
  source. It has a multicolor bitmap logo in VIC bank 1 above a text screen in bank 0, raster bars, eight sprites, a scroller
  and three-voice music, with one block of every type the analysis finds. Its 15 bookmarks are a guided tour (F2), and it has
  names for the main routines and a few comments. The first start still shows the raster demo the tests use (spec 14.7).
- **Memory tab.** The loaded memory as the VICE monitor prints it: `m` (hex and text, 16 or 8 bytes a row), `i` (PETSCII)
  and `ii` (screen codes, inverse ones inverted), in either character set. Its field takes VICE's commands (`m 0801 08ff`,
  `ii 0400`); the cursor and selection are the listing's, and *Copy* writes the rows as VICE does. *Find* searches text
  (as PETSCII and as screen codes, in any case) or bytes (`a9 00 8d`, `??` for any byte) with `findInMemory()`, colours
  every hit and steps through them (Enter, Shift+Enter, F3). Checked against x64sc's own output
  (`packages/core/src/c64/monitor.ts`, spec 14.6).
- **Graphics tab.** It draws all 64 KB as characters (40 a row by default, 16, 32, 64 or any count up to 128 typed in),
  sprites, 8 KB bitmaps or 1 KB screens (hires or multicolor, C64 colours, zoom, byte offset), whatever the blocks say, to find graphics by eye as in ICU64. Screens are drawn with
  VICE's character ROM (read from the VICE in the settings, never shipped), the built-in letters or a charset in memory,
  and *Go* moves the grid so a screen starts there. *Font per row* draws a picture whose character rows each have their
  own font, 2 KB after the one above (passing over memory where no font can be: `$0000`, the character ROM the VIC sees
  at `$1000-$1fff` and `$9000-$9fff`, I/O at `$d000-$dfff`), and the same 40 screen codes (the first row of the screen). A click, `Shift`+click or a drag selects cells. The selection is the
  listing's, and *Mark as Charset / Sprite data / Bitmap / Screen matrix* sets the block. *Save…*
  saves it as raw bytes, with a load address (.prg/.64c), as a Koala or Art Studio picture, as a PNG image or as Kick
  Assembler `.byte` source shaped like the graphics (`packages/core/src/c64/gfxfiles.ts`). The
  geometry and drawing are in `src/lib/gfxview.ts`; see spec 14.5.
- **Cycle counting.** *Cycles* in the listing toolbar shows each instruction's 6510 cycles: `4`, `4+` (one more across a
  page) and, for branches, a `2/3` button that marks the branch as taken. `cyclePath()`
  (`packages/core/src/cpu/cycles.ts`) counts the selection, or the code block at the cursor, along one path. Taken
  forward branches skip their lines, and a loop shows what one more pass costs. The inspector's Cycles section and the
  status bar show the total. See spec 10.1.
- **Moving a byte to the next block.** A line at a block's edge, dragged by its address or bytes into the block above or below, gives
  that block its byte (the whole instruction in code, both bytes of a `.word`); a drag in the source text still selects.
  `moveBytes()` (`packages/core/src/edit.ts`) writes the overrides: the neighbour grows and keeps its type and settings, and the block
  the byte leaves keeps its type. Right-click → *Move $xxxx into the previous/next block* does the same.
- **Number formats.** The inspector's *Format* (Hex, Dec, Bin, and for words Addr: labels, the default) and *Bytes per
  row* / *Words per row* set how a data, table or word block writes its numbers (`.byte %00000110`, `.word 3590, 259`).
  `formatOverride()` (`packages/core/src/edit.ts`) writes the override, from the project's last override over the block
  so that quick changes in a row add up; the renderer writes words several a row, broken at labels and notes.
- **Undo/redo** stores Immer patches per edit (`src/store/history.ts`).
- **Security.** `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP, no remote code (Monaco and fonts are
  bundled). Every IPC request is checked for a trusted sender and validated with zod. File access is limited to folders
  picked in a dialog this session and to build folders the main process creates. Java and VICE come from the main
  process' settings and are started with argument arrays.
- **Verification.** Verify (F7) re-assembles with the built-in Kick-subset assembler and, when KickAss.jar is configured,
  with the real Kick Assembler in a temporary folder, comparing every byte with the original. Build & Run (F5) then starts
  x64sc with the PRG and the `-vicesymbols` label file.

## Kick Assembler compatibility (checked against KickAss 5.25)

- Forced addressing: `.abs` works on plain, `,x` and `,y` operands; `.zp` works on plain, `,x`, `,y` and `(zp,x)`.
  `.zp` on `(zp),y` is **rejected** by KickAss, so the generator writes no suffix there (none is needed).
- Upper-case mnemonics are **rejected** (`Pseudo command 'SEI' not defined`), so mnemonics are always lower case;
  the old "Mnemonics: UPPER CASE" setting is ignored.
- All undocumented mnemonics the generator emits (`slo rla sre rra sax lax dcp isc alr arr axs anc`) assemble to the
  expected opcodes. Ambiguous or unstable ones (NOP variants, `$2b`, `$eb`, XAA, AHX, TAS, SHX, SHY, LAS, LAX #imm)
  are emitted as `.byte` with the mnemonic in a comment.

## Behaviour changes from the prototype engine

The core is a line-by-line port of the original prototype, whose engine is kept as `packages/core/test/reference/core.prototype.cjs`;
`packages/core/test/differential.test.ts` proves it
produces identical analysis, listing, files and verification, except for these deliberate fixes (each is applied to
the reference as a patch in `test/helpers/reference.ts`):

1. No `.zp` on `(zp),y` operands (KickAss rejects it).
2. Mnemonics always lower case (KickAss rejects upper case).
3. A 1-byte Word table no longer writes its label twice.
4. Word tables keep offsets in `label+n` (they were widened to `label+$xxxx`, a wrong value).
5. "Mark as code" no longer starts inside an earlier instruction, claims bytes a later override owns, or crosses files.
6. Tracing never lets an instruction cross from one file into the next.
7. One music entry per final Music block, so the `.sid` file always holds the block's bytes.
8. A user music override replaced by a later code override no longer paints over the new instructions.
9. Branches that wrap around `$ffff/$0000` are written as `.byte` (no assembler accepts them as mnemonics).
10. Blocks whose layout would hide a referenced label (inside a word, sprite row or BasicUpstart2 stub) fall back to `.byte` rows.
11. "Mark as Bytes" (D) now works on data the heuristics detect: the marked bytes become their own plain user Data block
    instead of being detected again as a table, text and so on. Detection still runs on the unmarked bytes around them.
12. Only overrides that still win count: one that later overrides cover completely no longer splits the new block, leaks
    its props into it or (for code) stays an entry point and sweep. Marking a range therefore merges the blocks inside it
    into one, and "Clear override" (U) now really returns marked code to automatic analysis.
13. A block comment with a line break (the inspector field is multi-line) is one `//` line per text line; it used to be a
    single `//` line whose second half was read as code. Line breaks in a line comment become spaces.
14. The demo program now runs. Its `sei` came before the KERNAL text output, which ends with `cli`. So the raster IRQ
    fired while `$0314` still pointed at the KERNAL handler, which never acknowledges it, and the C64 hung after
    printing the text. The `sei` now comes after the text output. The raster bars no longer cover the title, and the
    second text line no longer breaks inside "C64". All addresses are unchanged.
15. With "raw addresses" (Settings → Kick Assembler output → *Real addresses*), an access to a hardware register or a
    KERNAL routine keeps its description as a comment (`sta $d020 // Border color`); it used to lose it. The unused
    `include/c64-hardware.asm` is no longer written then.
16. The CPU vectors `$fffa-$ffff` keep their names (`sta IRQ_VECTOR`, or `sta $fffe // Hardware IRQ/BRK vector`) even
    when the program's own bytes cover them, as a memory dump's do; setting the IRQ vector used to come out as
    `sta charset_fffe`, a label of the data there.
17. Renaming a zero-page pointer (`ptr_fb`) renames its high byte too: `sta ptr_fb+1` used to keep the old name, an
    undefined symbol. The app could not rename zero-page variables before, so it never showed.
18. Music detection was rewritten (spec 8.6): it needed both JMPs of the table traced, so most players went unseen (a
    snapshot taken after init ran, play called from an interrupt the trace did not find, play at +6, play code right
    after JMP init). The reference calls the production detector, and `test/music.test.ts` tests it on its own.
19. A graphics window ($d018's charset or screen, a sprite pointer's 64 bytes, a bitmap) only takes the bytes that are
    still data when most of what is loaded there is data, and a piece of it between code shorter than 8 bytes stays
    data. A variable between two routines in the window used to become a 1-byte Charset or Screen matrix block with no
    reason; every piece now gets the window's reason.
20. Memory configuration tracking: a VICE snapshot goes on with the `$01` it holds (from its PC and its live interrupt
    vectors) instead of the `$37` of a fresh start, and an interrupt handler that acknowledges its interrupt (`$d019`,
    `$dc0d`, `$dd0d`) runs with I/O visible. In a snapshot whose loader banks I/O out with `dec $01`, the IRQ's VIC
    stores came out as `sta var_d012 // RAM or I/O` (the differential test runs with bank tracking off). Where `$01`
    still cannot be told, `$d000-$dfff` counts as I/O, so a register keeps its name and gets no RAM label.
21. Code islands (`Settings.codeIslands`, on by default): a data block nothing traced reaches that starts with a
    routine (6+ documented instructions ending in RTS or JMP, no BRK, every branch inside it, not 1541 drive code) is
    traced as code, entry kind `guess`; marking it as data (D) undoes that. The differential test runs with it off.
22. A hardware name with an offset after `<`/`>` (a lo/hi pointer table, an immediate hint) keeps its parentheses:
    `>VIC_IRQ_ENABLE+$c0` is `(>VIC_IRQ_ENABLE)+$c0` to KickAss. 10 of 1060 real programs did not round-trip
    because of it.
23. Deep analysis (`Settings.deepAnalysis`, off by default, spec 8.11e) is new in the production engine: guesses
    traced on trial, branches decided by known flags, `$01` followed through the stack and variables, and rounds that
    do not follow calls into ROM, through operands code writes, or past routines that never return. With it off,
    nothing changes; the differential test runs with it off, and the fuzz test turns it on at random.
24. The VIC bank of a VICE snapshot comes from its CIA2 module ($dd00 and $dd02), as `$01` does from C64MEM. It used
    to be bank 0, so a snapshot showing bank 3 got its `$d018=$30` charset at $0000, over the zero page. A `$d018`
    store also counts in the bank that a `$dd00`/`$dd02` store right after it selects, and no graphics window goes
    over the zero page and the stack ($0000-$01ff). In 47 of 1060 real programs a guessed bitmap at $0000 had made
    the program's own bytes from $0800 a bitmap.
25. Timing code (spec 8.3b) is new in the production engine: a branch whose offset the code sets from a CIA timer or
    the raster enters a delay, which is decoded from its start, marked, and reads nothing the program has (no labels
    such as `data_eaa5`). A constant less the timer (`lda #c / sec / sbc $dc06`, Spindle's jitter correction)
    counts too, the delay then ending where its ways in first meet. 15 delays in 11 real programs (7 in 6 before the
    constant form), all round-tripping.
26. Spindle's effect drivers (spec 8.11f) are new in the production engine: the code Pefchain 3.x builds from each
    line of its script is read back into the line (the part's routines, its condition, what comes next), its drivers
    are entry points, and the Spindle script tab lists them. None in the 1078 programs of the test corpus.
27. A VICE snapshot opened from `$0200` still names a known loader whose code is in its zero page or stack (Sparkle's
    receive loop is at `$0160`): the part is marked `outside`, and the Explorer says how to open it. A later Sparkle
    (`inx` for `dex`, `ora #$01`) is known too.
28. Spindle 3 disks (spec 13.5b) are new: `readSpindleDisk` reads a disk's jobs and decrunches them (disk.c and
    pack.c of Spindle 3.1), and the Spindle script tab lists them for a mounted disk. Checked against disks spin.exe
    and pefchain.exe built (every chunk byte-identical with its file) and the four sides of Mojo.

Fixes 3–10 were found by the fast-check fuzz test, which covers more inputs (entries, comments, renames, every override
kind, every setting, two-file projects) than the prototype harness did. Fix 11 was found while writing the e2e tests,
fix 12 while making large selections merge into one block, fix 13 while adding comment lines and blocks. Fix 18 came
from a VICE snapshot whose music was not found, and was measured on real releases with their `.sid` files. Fix 19 came from
1-byte Charset blocks in the same snapshot.

Comment lines and blocks (`/` and `*` in the listing, `Project.notes`) are new in the production engine, so the
reference never sees them; the round-trip, fuzz and real KickAss.jar tests cover them. The same goes for following the
memory configuration and VIC bank (`bankTracking`, `Project.bankZones`): the differential test runs with it off, and
`test/banks.test.ts`, the fuzz test (random zones, on and off) and the KickAss.jar test cover it.

## Roadmap

M3 VICE binary monitor (`vice:attach` / `vice:command` already exist as stubs), M4 structs/macros/local labels,
M5 `.d64`/`.sid`/`.crt` import, M6 other assemblers. Packaging covers Windows only (unsigned, default icon);
macOS/Linux targets and code signing are not set up yet.
