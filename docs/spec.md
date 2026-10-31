# Mimir Studio — teknisk specifikation

<p class="lead">En professionell arbetsmiljö för att analysera Commodore 64-program (<code>.prg</code>) och återskapa dem som ren, strukturerad och kompilerbar Kick Assembler-källkod — med byte-exakt verifiering och direkt koppling till VICE.</p>

**Version** 1.0 · **Datum** 2026-10-18 · **Status** arkitekturprototyp (den här filen) + produktionsspecifikation

## 1. Sammanfattning

Mimir Studio är en desktop-applikation (Electron + React + TypeScript + Tailwind CSS) med ett mörkt, IDE-inspirerat gränssnitt. Den har tre huvudsyften:

1. **Djupgående analys.** Laddade PRG-filer disassembleras och varje byte i C64-minnet klassificeras som kod, grafik (bitmap, teckensnitt, sprites, skärmmatris), musik (SID), tabeller, text eller övrig data.
2. **Intelligent symbol- och adresshantering.** Hårdvaruregister (VIC-II, SID, CIA 1/2), KERNAL-rutiner, vektorer och systemvariabler får läsbara namn. Användaren döper om etiketter, kommenterar och ändrar blocktyper interaktivt, och allt slår igenom överallt direkt.
3. **Kick Assembler-export och arbetsflöde.** Projektet exporteras som ett välorganiserat Kick Assembler-projekt (`.asm`, `include/`, `gfx/*.bin`, `music/*.sid`, byggskript) som kompileras och startas i VICE (`x64sc`) med ett klick.

Fyra designprinciper bär hela arkitekturen:

| Princip | Innebörd |
|---|---|
| **Byte-exakt round-trip som kvalitetsgrind** | Varje export assembleras om och jämförs byte för byte med originalet innan den räknas som klar. Allt som analysen inte förstår exporteras som data, så resultatet är alltid korrekt även när det inte är vackert. |
| **En linjemodell, två vyer** | Samma radmodell (`Line[]`) driver både den interaktiva listningen och den genererade källkoden. Det som syns i listningen är exakt det som exporteras. |
| **Förklarbar heuristik** | Varje block bär sin evidens ("sprite pointer $07f8 = $80"), en konfidensnivå och kan granskas i Inspektorn. Inga svarta lådor. |
| **Användaren har sista ordet** | Automatisk analys < heuristik < användarens overrides. Overrides lagras som en ordnad lista och analysen körs om deterministiskt efter varje ändring. |

## 2. Mål, målgrupp och avgränsningar

**Målgrupp:** demoscenare som vill studera eller återanvända gammal kod, reverse engineers och crackers, spelutvecklare som moddar gamla titlar, samt musik- och grafikrippare.

**Mätbara mål för v1**

| Mål | Kriterium |
|---|---|
| Korrekthet | 100 % byte-exakt round-trip på testkorpusen (≥ 500 PRG från CSDb, spel, demos, intron, musikfiler). |
| Kodtäckning | ≥ 95 % av den kod som körs i VICE från startpunkten hittas automatiskt i okomprimerade demos (mätt med VICE-trace). |
| Läsbarhet | Hårdvaruåtkomster, KERNAL-anrop och IRQ-uppsättning visas symboliskt i ≥ 99 % av fallen. |
| Prestanda | Full analys av 64 KB under 50 ms i worker; listning 60 fps vid scrollning. |
| Arbetsflöde | Från PRG till körande om-assemblerat program i VICE på under 30 sekunder för en ny användare. |

**Icke-mål i v1:** ingen inbyggd emulator (VICE används), ingen automatisk uppackning av komprimerade program (detekteras och rapporteras; uppackning med ett klick med Sindri, den inbyggda uppackaren, 8.11b, eller ett externt verktyg som unp64), ingen export till andra assemblers (ACME/64tass/ca65 ligger på roadmap), inget stöd för cartridge-format (`.crt`) och diskavbilder (`.d64`) i v1 — `.d64`-import kommer i M5.

## 3. Teknikstack

| Del | Val | Motivering |
|---|---|---|
| Skal | **Electron 33+** (`contextIsolation`, `sandbox`) | Ett fönster, native filsystem, kan starta `java` och `x64sc`, plattformsoberoende. |
| UI | **React 18** + **TypeScript 5** (strict) | Komponentmodell som passar en IDE, stort ekosystem, typad domänmodell delas med kärnan. |
| Styling | **Tailwind CSS 3.4** med designtokens som CSS-variabler | Snabb, konsekvent styling. Tokens (`--bg`, `--accent`, `--g-code` …) mappas i `tailwind.config` så att mörkt/ljust tema byts i ett ställe. |
| Editor | **Monaco 0.45+** | Samma motor som VS Code: egen Kick Assembler-språkdefinition, hover, gå-till-definition, minimap, sök. |
| State | **Zustand** + **Immer** (patches för undo/redo) | Lättviktigt, selektorer utan onödiga omritningar, patch-baserad historik. |
| Analys | **@mimir/core** i en **Web Worker** via **Comlink** | Ren TypeScript utan DOM. Körs i worker (UI blockeras aldrig), i Node för tester och CLI. |
| Bygg | **electron-vite**, **electron-builder** | Snabb HMR i utveckling, signerade installationsfiler för Windows/macOS/Linux. |
| Test | **Vitest**, **Playwright for Electron**, **fast-check** | Enhetstester, end-to-end i den riktiga appen, egenskapsbaserade tester för disassembler och round-trip. |

**Om prototypen:** den här enfilsversionen använder samma designtokens i ren CSS i stället för Tailwind-runtime, och kärnan körs synkront i huvudtråden (den är snabb nog: ~20 ms för demot). Strukturen i koden motsvarar paketen ovan.

## 4. Systemarkitektur

<div class="diagram">
<svg viewBox="0 0 960 430" role="img" aria-label="Processmodell: renderer med UI och store, analysworker med kärnan, preload-brygga, huvudprocess med filsystem och toolchain, samt externa KickAss.jar och VICE x64sc">
<defs><marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="dg-head"/></marker></defs>
<rect x="20" y="40" width="330" height="230" rx="10" class="dg-box dg-main"/>
<text x="38" y="68" class="dg-t">Renderer-process (React)</text>
<text x="38" y="92" class="dg-s">Listing · Monaco · Inspektor · Paneler</text>
<rect x="38" y="108" width="294" height="54" rx="7" class="dg-inner"/>
<text x="52" y="130" class="dg-t2">Store (Zustand + Immer)</text>
<text x="52" y="149" class="dg-s">Project · overrides · undo/redo · UI-state</text>
<rect x="38" y="174" width="294" height="78" rx="7" class="dg-inner"/>
<text x="52" y="196" class="dg-t2">Vyer på samma linjemodell</text>
<text x="52" y="215" class="dg-s">Listning (virtualiserad) · Monaco (kickass)</text>
<text x="52" y="233" class="dg-s">Heatmap · grafikförhandsvisning · xrefs</text>
<rect x="20" y="320" width="330" height="92" rx="10" class="dg-box"/>
<text x="38" y="348" class="dg-t">Analysworker · @mimir/core</text>
<text x="38" y="372" class="dg-s">decode · trace · evidens · musik/VIC</text>
<text x="38" y="391" class="dg-s">klassificering · render (Kick) · verify</text>
<rect x="398" y="110" width="140" height="110" rx="10" class="dg-box"/>
<text x="414" y="138" class="dg-t">Preload</text>
<text x="414" y="160" class="dg-s">contextBridge</text>
<text x="414" y="178" class="dg-s">window.kr (typat</text>
<text x="414" y="196" class="dg-s">IPC-API)</text>
<rect x="586" y="40" width="190" height="230" rx="10" class="dg-box"/>
<text x="602" y="68" class="dg-t">Huvudprocess</text>
<text x="602" y="96" class="dg-s">Projekt-FS (.mimir)</text>
<text x="602" y="118" class="dg-s">Inställningar</text>
<text x="602" y="140" class="dg-s">Toolchain-runner</text>
<text x="602" y="162" class="dg-s">VICE monitor-klient</text>
<text x="602" y="184" class="dg-s">Fil-watcher</text>
<rect x="818" y="52" width="124" height="70" rx="10" class="dg-box dg-ext"/>
<text x="834" y="80" class="dg-t">KickAss.jar</text>
<text x="834" y="102" class="dg-s">java -jar</text>
<rect x="818" y="182" width="124" height="70" rx="10" class="dg-box dg-ext"/>
<text x="834" y="210" class="dg-t">VICE x64sc</text>
<text x="834" y="232" class="dg-s">-autostart</text>
<line x1="350" y1="165" x2="396" y2="165" class="dg-arrow" marker-end="url(#arw)" marker-start="url(#arw)"/>
<line x1="538" y1="165" x2="584" y2="165" class="dg-arrow" marker-end="url(#arw)" marker-start="url(#arw)"/>
<text x="356" y="155" class="dg-s">invoke</text>
<text x="545" y="155" class="dg-s">IPC</text>
<line x1="776" y1="87" x2="816" y2="87" class="dg-arrow" marker-end="url(#arw)"/>
<line x1="776" y1="210" x2="816" y2="210" class="dg-arrow" marker-end="url(#arw)"/>
<line x1="816" y1="232" x2="776" y2="232" class="dg-arrow" marker-end="url(#arw)"/>
<text x="780" y="78" class="dg-s">spawn</text>
<text x="780" y="200" class="dg-s">spawn</text>
<text x="770" y="256" class="dg-s">TCP 6502</text>
<line x1="150" y1="270" x2="150" y2="318" class="dg-arrow" marker-end="url(#arw)"/>
<line x1="220" y1="318" x2="220" y2="270" class="dg-arrow" marker-end="url(#arw)"/>
<text x="64" y="300" class="dg-s">Project</text>
<text x="228" y="300" class="dg-s">AnalysisResult + Line[]</text>
</svg>
</div>

### 4.1 Processer och ansvar

| Process | Ansvar | Får inte |
|---|---|---|
| **Huvudprocess** (Node) | Fönster, menyer, filsystem (öppna/spara projekt, exportera), inställningar (`electron-store`), starta KickAss och VICE via `child_process.spawn` (utan shell), VICE binary monitor (TCP), fil-watcher för exporterade projekt. | Tolka analysresultat eller rita UI. |
| **Preload** | Exponera ett smalt, typat API (`window.kr`) via `contextBridge`. Validerar argument. | Exponera `ipcRenderer` eller Node-API direkt. |
| **Renderer** | Hela UI:t, store, Monaco, kortkommandon. Skickar `Project` till worker och tar emot resultat. | Röra filsystemet eller starta processer. |
| **Analysworker** | Kör `@mimir/core`: `analyze()`, `render()`, `verify()`. Ren beräkning, deterministisk. | Ha sidoeffekter eller I/O. |

### 4.2 Säkerhet

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
- Strikt CSP i renderern: inga fjärrskript; Monaco och typsnitt paketeras lokalt.
- IPC-kanaler är en uttömmande allowlist (se 13.4). Sökvägar normaliseras och begränsas till användarvalda projektmappar; körbara filer (`java`, `x64sc`) anges explicit i inställningarna och startas med argumentlista, aldrig via shell-strängar.
- Projektfiler är JSON med schema-validering (zod) vid inläsning.
- Fildialogerna (Open PRG, Mount D64, projekt, Export) öppnas i den mapp där samma slags dialog senast användes, annars
  där någon dialog senast användes. Mapparna sparas i `recent-folders.json` i användardatamappen och gäller även efter
  en omstart (`electron/main/recent.ts`). En mapp som inte längre finns hoppas över. Exportdialogen öppnas i mappen
  runt den senaste exporten. Minnet anger bara var dialogen börjar: åtkomst får appen fortfarande bara till det
  användaren väljer.

### 4.3 Dataflöde

```
Project (filer, overrides, etiketter, kommentarer, inställningar)
   │  postMessage (Comlink)                     ← varje ändring, debounce 30 ms
   ▼
analyze(project)  →  AnalysisResult (minnesbild, instruktioner, xrefs, block, evidens, logg)
   │
render(result, project)  →  { lines: Line[], files: { "main.asm": "...", "music/…sid": Uint8Array, … } }
   │
   ├─▶ Listning (virtualiserad, interaktiv)      ├─▶ Monaco (samma text, radkarta för synk)
   ├─▶ Inspektor / heatmap / förhandsvisning      └─▶ Export (ZIP / mapp) + verify()
```

Etiketter och kommentarer påverkar bara `render()`, inte `analyze()`, så omdöpningar är omedelbara även för stora program. Overrides och inställningar kör om hela kedjan (fortfarande < 50 ms).

## 5. Kodbas och katalogstruktur

```
mimir-studio/
├─ apps/desktop/
│  ├─ electron/
│  │  ├─ main/index.ts            fönster, meny, livscykel
│  │  ├─ main/ipc.ts              registrering av IPC-kanaler (allowlist)
│  │  ├─ main/toolchain.ts        KickAss- och VICE-körning, felparsning
│  │  ├─ main/vice-monitor.ts     binary monitor-protokoll (TCP 6502)
│  │  ├─ main/project-fs.ts       öppna/spara .mimir, exportera projektmapp
│  │  └─ preload/index.ts         contextBridge → window.kr
│  └─ src/                        renderer
│     ├─ App.tsx
│     ├─ store/{project.ts, ui.ts, history.ts}
│     ├─ workers/analysis.worker.ts
│     ├─ components/{TitleBar, ActivityBar, Sidebar, Listing, SourceView,
│     │              Inspector, Heatmap, GfxPreview, BottomPanel, StatusBar,
│     │              CommandPalette, Settings, ContextMenu}.tsx
│     ├─ monaco/{kickass-language.ts, theme.ts, providers.ts}
│     └─ styles/{tokens.css, tailwind.css}
├─ packages/core/
│  ├─ src/cpu/{opcodes.ts, decode.ts}
│  ├─ src/c64/{symbols.ts, basic.ts, prg.ts, psid.ts}
│  ├─ src/analyze/{memory.ts, trace.ts, evidence.ts, pointers.ts, music.ts,
│  │               vic.ts, classify.ts, labels.ts, diagnostics.ts, index.ts}
│  ├─ src/render/{lines.ts, kick.ts, include.ts}
│  ├─ src/verify/{kick-subset-assembler.ts, verify.ts}
│  └─ test/{opcodes.test.ts, trace.test.ts, roundtrip.test.ts, fuzz.test.ts}
├─ packages/cli/                  mimir analyse|export|verify|unpack (Node, för CI och batch)
├─ packages/sindri/               Sindri, den inbyggda uppackaren: en emulerad C64 som följer ett packat program genom sina lager
├─ fixtures/{prg/, golden/}       testkorpus + förväntade .asm
└─ docs/
```

Prototypens sektioner motsvarar dessa filer: `1. OPCODE TABLE` → `cpu/opcodes.ts`, `2. C64 SYMBOL DATABASE` → `c64/symbols.ts`, `5. ANALYSIS ENGINE` → `analyze/*`, `6. RENDERING` → `render/*`, `7. VERIFIER` → `verify/*`, React-delen → `apps/desktop/src`.

## 6. Datamodell

```ts
type Addr = number;                       // 0x0000–0xffff

interface Project {
  format: 'mimir-project'; version: 1;
  name: string;
  files: LoadedFile[];                    // en eller flera PRG
  overrides: Override[];                  // ordnad lista, senare vinner
  entries: Addr[];                        // användarens extra startpunkter
  entryPoint: Addr | null;                // programstart satt av användaren (null: BASIC SYS eller laddadressen), 8.2
  labels: Record<Addr, string>;           // användarens namn (tom sträng = återställ)
  comments: Record<Addr, string>;         // kommentar i slutet av raden
  blockComments: Record<Addr, string>;    // kommentarer ovanför block (en // per textrad)
  notes: Record<Addr, Note>;              // egna kommentarrader och kommentarblock ovanför en adress
  bookmarks: Record<Addr, Bookmark>;      // bokmärken: titel och anteckning per adress, skrivs aldrig till källkoden (10)
  bankZones: BankZone[];                  // ordnad lista, senare vinner: vad koden i ett intervall körs med
  excluded: Addr[];                       // starten på block som lämnas utanför bygget (11.5)
  binary: Addr[];                         // starten på block som sparas som binärfil (11.6)
  settings: Settings;
}

interface Note {
  text: string;                           // flera rader tillåtna
  block?: boolean;                        // true: ett /* … */-block, annars en // per textrad
}

interface Bookmark {
  title: string;                          // högst 200 tecken; standard: etiketten på adressen, annars $xxxx
  text: string;                           // anteckningen, flera rader tillåtna (högst 20 000 tecken)
}

interface BankZone {                      // se 8.7b
  start: Addr; end: Addr;
  port?: number | null;                   // värdet på $01 (bit 0–2 räknas); null = tillbaka till detektering
  vicBank?: number | null;                // VIC-bank 0–3; null = tillbaka till detektering
}

interface LoadedFile { id: string; name: string; load: Addr; bytes: Uint8Array; }

type BlockKind = 'code' | 'data' | 'words' | 'text' | 'table' | 'lohi' | 'sprite'
               | 'charset' | 'bitmap' | 'screen' | 'music' | 'fill' | 'basic';

interface Override {
  start: Addr; end: Addr;                 // end exklusiv
  type: BlockKind | 'auto';               // 'auto' = rensa overrides i intervallet
  props?: { enc?: 'petscii' | 'screen'; row?: number; fmt?: 'hex' | 'bin' | 'dec';
            init?: Addr; play?: Addr };
}

interface Block {
  id: number; start: Addr; end: Addr; type: BlockKind; file: number;
  props: Record<string, unknown>;
  conf: number;                           // 0–1
  reason: string;                         // evidens i klartext, visas i Inspektorn
  user: boolean;                          // satt av användaren
  entropy: number;                        // bitar/byte
  hint?: 'code';                          // t.ex. "trolig oupptäckt kod"
}

interface XRef { from: Addr; kind: 'call' | 'jump' | 'branch' | 'read' | 'write' | 'rmw' | 'ptr'; }

interface AnalysisResult {
  mem: Uint8Array; owner: Int16Array;     // minnesbild + vilken fil som äger byten
  insLen: Uint8Array; codeOwner: Int32Array;
  xrefs: Map<Addr, XRef[]>;
  entryKind: Map<Addr, 'entry' | 'irq' | 'nmi' | 'brk' | 'sub' | 'ptr' | 'user' | 'jmp' | 'branch'>;
  blocks: Block[]; labels: Map<Addr, { name: string; kind: string }>;
  hints: Map<Addr, { kind: 'lo' | 'hi'; target: Addr }>;   // #<label / #>label
  music: MusicInfo[]; vic: VicEvidence; log: LogEntry[]; stats: Stats;
}

type Token = { t: 'lbl' | 'hw' | 'kw' | 'num' | 'str' | 'dir' | 'def' | 'p'; s: string; to?: Addr };
type Line =
  | { k: 'hdr'; a: Addr; blk: number; type: number; text: string }
  | { k: 'lbl'; a: Addr; name: string }
  | { k: 'ins'; a: Addr; n: number; mn: string; ext: '' | '.abs' | '.zp'; tok: Token[]; cmt: string }
  | { k: 'dat'; a: Addr; n: number; dir: '.byte' | '.word' | '.text'; tok: Token[]; cmt: string }
  | { k: 'dir'; a: Addr; n: number; tok: Token[]; cmt?: string }
  | { k: 'cmt'; a: Addr; text: string } | { k: 'blank'; a: Addr };
```

`Line` är kärnan i "en linjemodell, två vyer": listningen renderar tokens interaktivt (klickbara etiketter, hover på register), exporten gör `tokens.map(t => t.s).join('')` med formatteringsregler. Varje rad bär adress och bytelängd, vilket ger exakt synk mellan listning, Monaco och heatmap.

## 7. Disassemblermotorn (6502/6510)

### 7.1 Opkodstabell

Alla 256 opkoder är tabellstyrda. Varje post: `mnemonic`, adresseringsläge, längd, `ill` (odokumenterad), `unstable`, flödesklass (`seq`, `br`, `jmp`, `jmpi`, `jsr`, `ret`, `brk`, `jam`), minnesåtkomst (`read`, `write`, `rmw`) och `kick` (om Kick Assembler kan uttrycka den med mnemonic).

| Läge | Syntax | Längd | Exempel |
|---|---|---|---|
| implied / accumulator | `rts`, `asl` | 1 | `0a` |
| immediate | `#$nn` | 2 | `a9 00` |
| zero page (,x / ,y) | `$nn`, `$nn,x` | 2 | `a5 fb` |
| (indirect,x) / (indirect),y | `($nn,x)`, `($nn),y` | 2 | `b1 fb` |
| relative | `label` | 2 | `d0 fa` |
| absolute (,x / ,y) | `$nnnn`, `$nnnn,x` | 3 | `8d 20 d0` |
| indirect | `($nnnn)` | 3 | `6c fb 00` |

### 7.2 Odokumenterade opkoder

| Namn | Opkoder (urval) | Kick-mnemonic | Stabil | Exportpolicy |
|---|---|---|---|---|
| SLO, RLA, SRE, RRA | `$03…$1f`, `$23…`, `$43…`, `$63…` | `slo` `rla` `sre` `rra` | ja | mnemonic |
| SAX, LAX | `$83 $87 $8f $97`, `$a3 $a7 $af $b3 $b7 $bf` | `sax` `lax` | ja | mnemonic |
| DCP, ISC | `$c3…$df`, `$e3…$ff` | `dcp` `isc` | ja | mnemonic |
| ANC, ALR, ARR, AXS | `$0b`, `$4b`, `$6b`, `$cb` | `anc` `alr` `arr` `axs` | ja | mnemonic |
| ANC (dubblett), SBC `$eb` | `$2b`, `$eb` | — | ja | `.byte` + kommentar |
| NOP-varianter | `$04 $0c $14 $1a $1c $80 $82 …` | — | ja | `.byte` (flera kodningar per mnemonic) |
| XAA, LAX #imm, AHX, TAS, SHX, SHY, LAS | `$8b $ab $93 $9f $9b $9e $9c $bb` | — | **nej** | `.byte` + varning |
| JAM (KIL) | `$02 $12 $22 … $f2` | — | — | stoppar spårning, rapporteras som fel |

Principen: allt som har mer än en möjlig kodning, eller vars beteende är instabilt, exporteras som `.byte` med en kommentar som visar mnemonic. Då är round-trip garanterad oavsett assemblerversion.

**Vad de gör:** när pekaren står på en odokumenterad opkod visas en kort beskrivning (`undocumentedText()`,
`packages/core/src/cpu/undocumented.ts`). Den har mnemonic, opkod och adresseringsläge, andra namn (`isc` heter också
`isb`), vad den gör i en mening och som formel, vilka flaggor den ändrar (N V Z C, eller *none change*) och, för de
instabila, varför. I listningen sitter den på mnemonic och, för en opkod som skrivs som `.byte`, på `.byte` och
kommentaren. I källkodsfliken visar Monaco samma text när pekaren står på mnemonic, också i en kommentar.

### 7.3 Kantfall

| Fall | Hantering |
|---|---|
| Adress-wrap vid `$ffff` | All adressaritmetik är `& $ffff`; en instruktion som korsar filslutet spåras inte. |
| BIT-skip (`.byte $2c`) | När ett hopp landar på byte 2 i en `BIT abs`/`BIT zp` konverteras BIT-instruktionen till en 1-byte "skip" och den gömda instruktionen spåras. Exporteras som `.byte $2c // bit abs: skips the next 2-byte instruction`. Fungerar i båda spårningsordningarna. |
| Överlappande instruktioner (övrigt) | Spåras inte; varning i Problems med båda adresserna. |
| Självmodifierande kod | Skrivningar in i en instruktion detekteras; instruktionen får en etikett (`smc_xxxx`) och skrivande kod refererar `smc_xxxx+1`. Kommentar på målinstruktionen. |
| Inline-data efter JSR | Om målrutinen börjar med `PLA / STA zp / PLA` (hämtar returadressen) fortsätter spårningen inte efter JSR. |
| BRK | Avslutar kodvägen, varning. |
| JAM | Avslutar kodvägen, fel ("probably runs into data"). |

## 8. Analysmotorn och heuristiker

Analysen är en deterministisk pipeline. Varje steg är O(n) över max 64 KB och hela kedjan körs om vid varje override.

### 8.1 Minnesbild

Alla filer läggs i en 64 KB-bild; `owner[addr]` anger vilken fil som äger byten (senare fil vinner vid överlapp, med varning). Flera filer analyseras tillsammans, så korsreferenser mellan t.ex. `main.prg` och `music.prg` löses upp.

### 8.2 Startpunkter

0. **Programstart satt av användaren** (`entryPoint`; Explorer → *Program start*, högerklick → *Set as program start*): blir `start`, spårningen börjar där och `$01` antas vara `$37` där (8.7b). En BASIC-stubs `SYS`-adress spåras ändå (den heter då `entry_xxxx` och `BasicUpstart2()` pekar dit), men laddadressen används inte längre. En adress utanför de laddade filerna ger en varning och den detekterade starten.
   **Clear** (Explorer, högerklick → *Clear program start*, kommandopaletten) nollställer den: analysen använder den
   detekterade starten igen och Build & Run startar programmet med RUN, utan någon startadress (13.2). Explorer visar
   alltid hur Build & Run startar det: med RUN, med `sys <start>` eller från monitorn, och varnar när RUN inte kan
   fungera (en PRG över `$0002-$03ff` utan start, eller en start i en annan fil än den som körs).
1. **BASIC-stub** vid `$0801`: radlänkar valideras, tokens avkodas (`10 SYS2064`), `SYS`-adressen blir `start`. Matchar stubben exakt det `BasicUpstart2()` genererar exporteras den så; annars som `.byte` med den avkodade BASIC-raden som kommentar.
2. Utan stub: första filens laddadress.
3. Användarens startpunkter (`E`) och kod-overrides (`C`).
4. Dynamiskt upptäckta: IRQ/NMI/BRK-vektorer, hopptabeller (8.5).

### 8.3 Rekursiv spårning (recursive descent)

```
kö ← startpunkter
medan kö inte tom:
  pc ← kö.pop()
  loop:
    stopp om pc ej laddad, redan kod, användardata, JAM, överlapp
    avkoda instruktion, markera bytes som kod
    branch      → xref(branch), köa mål, fortsätt på pc+2
    JMP abs     → xref(jump), köa mål, stopp
    JMP (ind)   → xref(ptr), registrera indirekt hopp, stopp
    JSR         → xref(call), köa mål, fortsätt (utom inline-data-rutin)
    RTS/RTI/BRK → stopp
```

### 8.3b Tidskod (fördröjning)

En stabil raster väntar så många cykler som en timer säger. Ett exempel, från en CIA-tajmad rasterrutin:

```
        lda $dc06               // CIA 1 timer B, låg byte
        eor #$07
        sta smc+1
smc:    bpl *                   // avståndet 0-7 sätts av koden
        lda #$a9                // a9 a9 a9 a9 ad a5 ea: varje ingång slutar på samma ställe
        lda #$a9
        lda $eaa5
```

`findDelays()` (`analyze/delay.ts`) körs efter varje evidenspass och känner igen mönstret:
- en gren vars avståndsbyte en STA/STX/STY skriver;
- ett värde som i den raka sträckan före kommer från en räknare: CIA 1:s eller 2:s timer A eller B (`$DC04–$DC07`,
  `$DD04–$DD07`, med speglingar) eller VIC:ens raster (`$D012`), via `AND`/`EOR`/`ORA`/`ADC`/`SBC` med konstanter
  och överföringar mellan registren;
- byten efter grenen: det mesta grenen hoppar (`AND`:ens, annars `EOR`:ens konstant, högst 63) är hur långt
  fördröjningen räcker, och varje ingång 0…n avkodas till instruktioner som bara tar tid (inga hopp och inga
  skrivningar) och slutar precis vid fördröjningens slut.

Spindles mall (`template/effect.s`) drar i stället timern från en konstant, och inget begränsar värdet:

```
        lda #39-(10)            // den tidigaste cykeln
        sec
        sbc $dc06               // A blir 0-8
        sta *+4
        bpl *+2
        lda #$a9
        lda #$a9
        lda #$a9
        lda $eaa5
```

En konstant (`lda #`) som en räknare dras från, läggs till eller EOR:as med (`SBC`/`ADC`/`EOR`) räknas också. Utan
`AND` eller `EOR` efter är fördröjningen den kortaste (2–63 byte) där varje ingång slutar vid dess slut. I en följd av
`lda #$a9` möts ingångarna först vid den sista instruktionen (`lda $eaa5`), så en `nop` efter räknas inte med. Mallen
ger 0–9 byte (10–0 cykler).

Då gäller:
- **Fördröjningen avkodas från början.** En snapshot kan ha avståndet 5 kvar från senaste avbrottet. Spårningen
  har då gått in mitt i, men fördröjningen avkodas om från början, och grenen skrivs `bpl delay_0886+5`.
- **Operanderna tar bara tid.** De ger inga korsreferenser och inga etiketter, som `data_eaa5` eller `zp_ea`, och de
  skrivs som tal (`lda $eaa5`).
- **Märkning:** etiketten `delay_xxxx` på början, en kommentarsrad ovanför (*delay: the bpl at $0884 goes 0-7 bytes
  into it by CIA1_TB_LO ($dc06), so it takes 8 down to 0 cycles*), kommentaren `delay` på varje rad och på grenen
  *0-7 bytes into the delay, by CIA1_TB_LO ($dc06)*. I listningen är raderna tonade, har en streckad kant och en
  bricka *delay*. Loggen har en rad per fördröjning.

`AnalysisResult.delays` (`DelaySled`) har grenen, skrivningen, timern, fördröjningens intervall, hur långt grenen går
i de laddade byten och hur många cykler den kan ta. **Mätt** på de riktiga programmen i testkorpusen: 15
fördröjningar i 11 program (7 i 6 innan konstanten minus timern räknades). De använder CIA 1:s timer A och B och
CIA 2:s timer A, är 7–29 byte, och alla återskapas byte för byte. **Test:** `test/delay.test.ts`, med Spindles mall.

### 8.4 Evidenspass (konstantpropagering)

Efter varje spårning körs ett linjärt pass över instruktionerna i adressordning med en enkel registermodell `A/X/Y = {värde, källa}`:

- `LDA #imm`, `LDX #imm`, `LDY #imm`, `TAX/TAY/TXA/TYA`, `INX/DEX/INY/DEY` uppdaterar kända värden; övriga instruktioner nollställer de register de skriver.
- Tillståndet återställs vid hoppmål. **Undantag:** täta loopar (alla inkommande kanter är bakåtbranches inom 24 byte) behåller tillståndet för register som loopkroppen inte skriver. Det gör att `lda colors,y / ldx $d012 / wait: cpx $d012 / beq wait / sta $d020` korrekt kopplar tabellen till färgregistret.
- `LDA tabell,X` markerar A som "indexerad läsning från tabell", och nästa konsument ger tabellen evidens:

| Konsument | Evidens | Resultat |
|---|---|---|
| `JSR $FFD2` (CHROUT) | petscii | Textblock (PETSCII) |
| `STA $0400–$07E7,X` | screen | Textblock (screen codes) |
| `STA $D020–$D02E` | color | Färgtabell (värden < 16) |
| `STA $D000–$D00F` | spritepos | Kurvtabell (sinus) |
| `STA $D012` | raster | Rasterradstabell |
| `STA $D400–$D418` | sid | SID-tabell |
| `BEQ/BNE` direkt efter | zt | Nollterminerad sekvens |

### 8.5 Pekare, vektorer och hopptabeller

- **Omedelbara pekarpar:** `LDA #lo / STA X / LDA #hi / STA X+1` (eller hi först). Destinationer i I/O-området ignoreras (annars blir `$d011/$d012` en falsk pekare). Operanderna exporteras som `#<label` / `#>label`.
- **Vektorer:** skrivs paret till `$0314` (IRQ), `$0316` (BRK), `$0318` (NMI), `$FFFE`/`$FFFA` köas målet som `irq_xxxx` / `nmi_xxxx`.
- **STROUT/SETNAM:** `LDA #<t / LDY #>t / JSR $AB1E` ger textpekare (nollterminerad PETSCII); `LDX/LDY + JSR $FFBD` ger filnamn.
- **Lo/hi-tabeller:** `LDA tA,X / STA p / LDA tB,X / STA p+1` → `tA` = lo-tabell, `tB` = hi-tabell. Längden är kortaste dataserien. Om ≥ 75 % av paren pekar in i laddat minne är det en pekartabell och exporteras som `.byte <fx_0919, <fx_091a, …`.
- **Hopptabeller:** om pekartabellens destination används av `JMP (p)`, eller är en vektor, köas alla mål som kod (`fx_xxxx` / `irq_xxxx`). Rasterkedjor med IRQ-tabeller hittas på samma sätt.
- **`.word`-hopptabeller:** `LDA t,X / STA p / LDA t+1,X / STA p+1` (indexet dubblat) följt av `JMP (p)`, eller med en vektor som `p`, är en tabell av ord. Den slutar vid nästa byte som koden refererar till, eller vid ett ord som inte är en laddad adress (högst 64). Alla mål köas som kod, och `t+1` blir `t+1`, inte en egen etikett. Tabellen klassas som Word table (*every word points at an instruction*).
- Spårning, evidens och tabellupplösning itereras tills inga nya startpunkter tillkommer (fixpunkt, max 8 varv).

### 8.6 Musikdetektering (SID)

`detectMusic()` (`packages/core/src/analyze/music.ts`) körs efter spårningen. En spelare börjar med en hopptabell på `B`:
`JMP init`, sedan `JMP play` (upp till fyra `JMP` i rad) eller play-koden direkt efter dem (`B+3`, `+6`, `+9` eller
`+12`). Koden som ingångarna når avkodas från tabellen där spårningen inte kom fram. Spelaren hittas därför också när
init kördes innan en VICE-snapshot togs (bara play är spårad), när play anropas från ett avbrott som spårningen inte
hittade, och när inget spårat når den alls. Avkodningen stannar vid JAM, BRK, instabila opkoder, mitten av en spårad
instruktion (utom BIT-skip-idiomet) och data-overrides. Fler än två sådana vägar, eller fler odokumenterade opkoder än
var åttonde instruktion, diskvalificerar.

**Play** är den ingång som IRQ:n anropar, alltså spårad avbrottskod eller hanteraren som vektorerna `$0314`/`$0318`/`$fffe`/`$fffa`
i minnet pekar på (en snapshots). Annars är det en ingång som programmet anropar, och annars en som ospårad kod anropar
(en `JSR`/`JMP` till den någonstans i minnet). Om ingen anropas blir play den ingång som skriver flest SID-register: en
volym- eller ljudeffektsingång skriver få. **Init** är `B`. Anrop räknas *utifrån*: från kod som inte är spelarens egen,
och inte från en `JMP` i en tabell strax före (högst 12 byte).

| Signal | Poäng |
|---|---|
| Hopptabellen | +2 |
| Både init och play anropas med JSR utifrån | +2 (en av dem: +1) |
| `B` är sidjusterad (t.ex. `$1000`) | +1 |
| Koden skriver ≥ 4 olika SID-register | +3 (1–3 register: +1) |
| Koden läser en notfrekvenstabell | +2 |

**Notfrekvenstabellen** finns i varje trackerspelare. `noteTables()` letar efter högbytena: minst 24 stigande byte, en
isär (låg- och högbyte i egna tabeller) eller två (i par), där en byte är ungefär dubbelt så stor som den tolv toner (en
oktav) före, minst sex gånger. Nollor i början av en sådan följd räknas inte. Koden läser tabellen när en `lda`
(absolut eller indexerad) når den eller högst `$20` byte före.

Tröskeln är 5 poäng. Dessutom gäller:
- **Något anropar tabellen** (spårat eller inte). Annars måste koden läsa en nottabell och `B` börja en sida, där
  spelare läggs. Ett `JMP`-par i annan kod som skriver till SID, t.ex. en rensning av registren, gör inget av det.
- **En tabell som koden före rinner in i** (eller som en gren når) och som ingen anropar är ett `JMP`-par inne i annan
  kod. Rinner koden före in i en tabell som anropas är det ett program som startar init så, och det räknas.
- **Play-kod direkt efter en enda `JMP`** kräver att både init och play anropas, eller en nottabell och en anropare.
  Slutet på en rutin och början på nästa ser ut så i all kod.
- **Programmets egen start** (BASIC SYS-målet eller laddadressen) är aldrig init.
- **Koden måste hålla ihop.** Den ska ligga inom `B−$800`…`B+$2000`, med högst 16 instruktioner utanför. Är mer än 8
  spårade instruktioner i regionen kod som tabellen inte når, får det vara högst var fjärde av dem. Några ingångar som
  programmet anropar direkt går bra.

**Flera tabeller:** alla tabeller prövas först.
- **Anroparen är ingen spelare.** En tabell vars kod hoppar till en annan spelares ingångar är den spelarens anropare,
  till exempel programmets starttabell eller en rutin som anropar init och play. Det gäller när hoppen kommer utifrån,
  koden inte kör in i den andra spelarens kod på annat sätt och de flesta SID-skrivningarna är den andras. Det gäller bara
  om den andra tabellen inleder sin kod. En tabell inne i en spelare, som spelarens egen kod hoppar till, har spelarkod
  före sig.
- **Den starkaste vinner där tabeller överlappar.** En svagare tabell inne i en spelare som redan hittats, eller vars kod
  kör in i den, räknas inte. En spelares kod slutar där nästa spelares tabell börjar.

Regionen sträcker sig från `B` till slutet av spelarkoden och dess datareferenser. Sedan förlängs den över efterföljande data tills något refereras utifrån, ny kod eller nästa spelares tabell börjar, eller 32 identiska byte (luckfyllnad) hittas. Fyndets skäl (`MusicInfo.why`, i inspektorn och analysloggen) säger hur spelaren hittades, t.ex. *Music detected at $1000-$1fff (score 9: JMP init / JMP play table, called from outside, page aligned, writes 13 SID registers, 4 instructions decoded from the table (the trace did not reach them), note frequency table at $14bb)*. Exporten skriver en **PSID v2-fil** (`music/music_1000.sid`, init/play, PAL, 6581) och laddar den idiomatiskt:

```
.var music = LoadSid("music/music_1000.sid")
        jsr music.init
        jsr music.play
.pc = music.location "Music"
        .fill music.size, music.getData(i)
```

Referenser in i musiken som inte är init/play blir `music.location+$xx`. Användaren kan när som helst byta blocktyp till Code för att disassemblera spelaren.

**Test:** `test/music.test.ts` bygger en spelare med en PAL-nottabell. Den testar:
- init och play anropade, och en VICE-snapshot tagen efter init där bara play är spårad, från IRQ:n. Källkoden får där
  `jsr music.play`, och verifieringen ger samma byte;
- en spelare som inget spårat når, på en sidgräns, men inte en sidförskjuten;
- play efter två och efter fyra `JMP`, och play-kod direkt efter `JMP init`;
- IRQ:ns ingång före en volymingång som programmet anropar;
- programmets starttabell och en rutin som anropar play, som inte är spelare;
- ett `JMP`-par i kod som rensar SID, som inte är någon spelare;
- notfrekvenstabeller i båda layouterna, och att en ramp, en fyllnad och en sinus inte är det.

Det differentiella testet låter referensen anropa den nya detekteringen (avvikelse 18), så att resten av analysen
jämförs som förut.

**Mätt på riktiga program:** 1060 program ur referensarkivet (intron, demos och spel, uppackade med unp64). 57 av dem har
en `.sid`-fil bredvid sig som facit (adress, init, play). Den nya detekteringen hittar 54 av dem rätt, mot 30 förut. Av
de tre andra:
- en `.sid`-fil har en egen init (`$dff6`) som demot inte använder (demot anropar `$e000`/`$e003`, som hittas);
- en spelare saknar hopptabell;
- en spelare har play direkt efter `JMP init` utan nottabell, med bara init anropad.

Detekteringen tar 10–20 ms för en hel snapshot. **Planerat:** spelare utan hopptabell, som bara känns igen på sina
anrop (klassiska spelrutiner).

### 8.7 VIC-II-evidens och grafik

Konstanta skrivningar ger exakta adresser:

| Register | Tolkning |
|---|---|
| `$DD00` | bank = 3 − (v & 3), bankbas = bank × `$4000` |
| `$D018` | skärm = bankbas + ((v >> 4) & 15) × `$400`; tecken = bankbas + ((v >> 1) & 7) × `$800`; bitmap = bankbas + ((v >> 3) & 1) × `$2000` |
| `$D011` bit 5 | bitmappsläge (annars teckenläge) |
| `$D016` bit 4 | multicolor |
| skärm + `$3F8…$3FF` | spritepekare: data på bankbas + v × 64 |

Med bankspårning (8.7b) räknas en `$D018`-skrivning som bitmapp bara när den `$D011`-skrivning som ligger närmast i koden slår på bitmappsläget. En delad skärm (en bitmapslogga ovanför text) ger då både bitmappen och teckenuppsättningen. Utan bankspårning gör bitmappsläge någonstans varje `$D018`-värde till en bitmapp. Teckenuppsättningar på `$1000–$1FFF` i bank 0 och 2 är ROM-skuggor och ignoreras. Inget fönster läggs över nollsidan och stacken (`$0000–$01FF`), som CPU:n ändrar hela tiden: `$d018=$30` i bank 0 (teckensnitt på `$0000`) eller en bitmapp på `$0000` blir ingen grafik, och loggen säger det när fönstret täcker laddade byte (*$d018=$30 would put the charset at $0000, over the zero page and the stack, …*). Ett fönster (teckensnitt, skärm, bitmap eller sprite) får sin typ bara på byte som fortfarande är data, och bara om det mesta av det som är laddat i fönstret är data, inte kod eller musik. En bit mellan kod som är kortare än ett tecken eller en bitmappscell (8 byte) förblir data. En variabel mellan två rutiner i fönstret blir alltså inget Charset-block på en byte. Varje bit får fönstrets skäl (*$d018=$1c selects charset at $3000*). Utan registerevidens används storlek och justering, med lägre konfidens: 8000 byte på 8K-gräns → bitmap, 2048 byte på 2K-gräns med tecken-lika celler (≤ 6 olika bytevärden per 8-bytecell i > 80 % av cellerna) → teckensnitt. Inspektorns förhandsvisning (Sprite/Chars/Bitmap, hires/multicolor) låter användaren bekräfta eller hitta grafik som heuristiken missat.

### 8.7b Minneskonfiguration ($01) och VIC-bank

Samma adress kan betyda olika saker beroende på 6510-porten `$01`: bit 0–2 (LORAM, HIRAM, CHAREN) väljer en av 8
konfigurationer (utan cartridge, DDR `$2F`). `$A000–$BFFF` är BASIC-ROM eller RAM, `$D000–$DFFF` I/O, tecken-ROM eller RAM,
`$E000–$FFFF` KERNAL-ROM eller RAM. Skrivningar till ROM-områdena går alltid till RAM under.

**Dataflöde (pass 2, efter spårningen i pass 1).** `analyze/banks.ts` följer för varje instruktion vilka konfigurationer
och VIC-banker den kan köras med, som mängder (bitmasker). Varje register bär de möjliga värdena på sina bit 0–2, så
`lda #$35 / sta $01`, `dec $01` / `inc $01`, `lda $01 / and #$f8 / ora #$05 / sta $01` och `ldx #$34 / stx $01` följs exakt;
allt annat gör registret okänt. Där vägar möts slås mängderna ihop.

- Programmet startar med `$37` och VIC-bank 0. En VICE-snapshot fortsätter i stället med det `$01` och den VIC-bank som snapshoten har (`$DD00` och `$DD02` ur modulen CIA2, `snapshotVicBank`), från programstarten, från PC och från avbrottsrutinerna som dess vektorer pekar på.
- Subrutiner lämnar tillbaka sitt tillstånd till varje anropare (via sina RTS); anrop utanför filerna (KERNAL) lämnar `$01` orört men registren okända.
- Avbrottsrutiner startar med det huvudkoden satt, begränsat av vektorn: `$0314/$0318` kräver KERNAL (HIRAM = 1), `$FFFE/$FFFA` kräver den urkopplad (HIRAM = 0). En rutin som kvitterar sitt avbrott (skriver `$D019` eller läser `$DC0D`/`$DD0D` innan den ändrar `$01`) körs dessutom med I/O synlig. Annars skulle avbrottet aldrig kvitteras och komma igen direkt. En huvudloop som växlar mellan `$35` och `$34` för att nå RAM under I/O, som en loader gör, ger därför inte IRQ-rutinens `sta $d012` en RAM-etikett (`var_d012`) med *RAM or I/O*.
- Kod kan bara köras där CPU:n ser RAM: kod på `$E000–$FFFF` körs med KERNAL ute, på `$A000–$BFFF` med BASIC ute, på `$D000–$DFFF` med allt RAM.
- VIC-bank: `$DD00` bit 0–1 ger bank 3 − v; tricket med `$DD02` (bankbitar som ingångar, läses som 1) ger bank v & 3 och antar att `$DD00` bit 0–1 är 0. En skrivning dit räknas bara där I/O syns.
- **BankZone** (användarens ord, högerklick → *Memory configuration ($01)* / *VIC bank*, eller inspektorn för ett kodblock): ersätter det detekterade tillståndet för instruktionerna i intervallet och flödar vidare till koden de når.

**Användning.** En operand i ett växlingsbart område namnges efter vad instruktionen når: alltid I/O eller ROM → hårdvaru-
eller ROM-namnet (`VIC_BORDER_COLOR`, `CHROUT`), aldrig etiketten på RAM-bytes under; alltid RAM → etikett eller adress,
aldrig ett hårdvarunamn (CPU-vektorerna `$FFFA–$FFFF` behåller sina namn). En åtkomst som alltid når I/O eller ROM ger
inte heller någon etikett där: ett block över I/O-området i en minnesdump (till exempel en charset över `$2000–$FFFF`)
delas därför inte av `charset_d020:`-rader för registren som koden skriver. Går det inte att avgöra, för att konfigurationerna
skiljer sig eller `$01` är okänt, räknas `$D000–$DFFF` som I/O (`reachesForName`): registret behåller sitt namn
(`sta VIC_RASTER`, inte `sta var_d012`) och ingen etikett skapas där, också när RAM under I/O är laddat (som i en
snapshot). Bara kod som säkert körs med RAM där (`$30`, `$34`) får RAM-etiketten. I övriga växlingsbara områden behålls
det vanliga namnet när det varierar. I båda fallen får raden kommentaren t.ex. `RAM or I/O: $01 is $34 or $37 here`. Skrivningar till `$01`/`$DD00`/`$DD02` får kommentaren
`memory $35 (RAM · I/O · RAM)` respektive `VIC bank 1 ($4000-$7fff)` och en rad i loggen; ett värde som inte går att följa
ger ett tips om att sätta konfigurationen. VIC-evidensen (8.7) använder banken där `$D018` och spritepekare skrivs, eller den
som en `$DD00`/`$DD02`-skrivning högst 5 instruktioner efter `$D018`-skrivningen väljer (`sta $d018 / lda #$00 / sta
$dd00` räknas i bank 3), och bortser från VIC-skrivningar med I/O urkopplat. Statusraden visar `$01` vid markören.

Namnen ändrar aldrig byten, så round-trip-garantin gäller oförändrad. Inställningen *Follow the memory configuration
($01) and VIC bank* (`bankTracking`, på som standard) stänger av allt detta; differentialtestet mot prototypen kör med
den avstängd. Utan den skrivs kodens åtkomster till I/O inne i de laddade bytes (en minnesdump över `$D000–$DFFF`) som
etiketter, t.ex. `sta charset_d020`. Analysen varnar då en gång (`ioLabelNotice`, kategori `banks`) med antal och de
första adresserna. I Problems har raden knappen **Turn on**, som slår på inställningen (ångras med `Ctrl+Z`).
Inställningen sparas i projektet och följer med till nästa PRG som öppnas.

### 8.8 Dataklassificering

Kvarvarande data delas vid objektstarter (adresser som refereras av kod, pekarmål, textpekare, tabellstarter) och varje del klassas med en beslutslista i prioritetsordning:

1. Lo/hi-tabell (8.5) · 2. Text med kodevidens (PETSCII eller screen codes, inklusive terminator) · 3. Fyllnad: alla byte lika (≥ 3 byte orefererat, ≥ 8 refererat) eller inre serier ≥ 32 byte · 4. Färgtabell (evidens + alla värden < 16) · 5. Kurvtabell: jämn kurva (medel |Δ| ≤ omfång/6, få teckenbyten) · 6. Ordtabell där varje ord pekar på en instruktion · 7. Orefererad PETSCII-text (≥ 8 byte, > 60 % bokstäver) · 8. Grafik efter storlek/justering · 9. Variabler (lästa och skrivna, ≤ 4 byte; intilliggande slås ihop) · 10. Övrig data (`.byte`).

### 8.9 Etiketter och namngivning

| Prefix | Betydelse |
|---|---|
| `start` | Programmets startpunkt (SYS) |
| `irq_` `nmi_` `brk_` | Avbrottshanterare från vektorer eller tabeller |
| `sub_` | JSR-mål |
| `fx_` | Mål i en hopptabell |
| `loop_` / `skip_` / `l_` | Bakåtbranch / framåtbranch / blandat eller JMP |
| `smc_` | Instruktion som modifieras av annan kod |
| `txt_` `sine_` `colors_` `tbl_` `var_` `data_` | Data efter klassificering och åtkomst |
| `ptrlo_` / `ptrhi_` | Lo/hi-pekartabeller |
| `spr_` `charset_` `bitmap_` `screen_` | Grafik |
| `ptr_xx` / `zp_xx` | Nollsidesvariabler (pekare respektive övriga) |

Namnen innehåller adressen och är därför unika. Användarens namn ersätter dem överallt; validering kräver giltig Kick-identifierare, inget mnemonic-namn och ingen dubblett.

### 8.10 Konfidens och förklaringar

Varje block har `conf` (0–1) och `reason`. Inspektorn visar dem som "high / medium / low confidence" och en "Why"-rad. Block med låg konfidens får en `?`-markör i listningen så att användaren vet var granskning lönar sig.

### 8.11 Diagnostik

| Diagnos | Regel |
|---|---|
| Komprimerat program | Oklassad data ≥ 2 KB med entropi > 7,2 bitar/byte → råd att packa upp först. |
| Kodö (ospårad kod) | Ett datablock som börjar med en rutin blir kod, se nedan. |
| Trolig oupptäckt kod | Datablock som avkodas till ≥ 6 dokumenterade instruktioner och slutar med RTS/JMP men inte klarar kodöns krav → hint med ett klick "Mark as code". |
| Oupplöst indirekt hopp | `JMP (ind)` utan känd tabell → varning. |
| JAM, BRK, överlapp, kod in i data | Fel/varning med klickbar adress. |

**Kodöar** (`codeIslands()` i `analyze/diagnostics.ts`, inställningen *Decode unreached code that reads as a routine*,
`Settings.codeIslands`, på som standard). Kod som inget spårat når blir data, till exempel en startrutin som redan har
körts när en snapshot tas. Ett datablock (inte användarens) som börjar med en rutin blir därför kod.

Rutinen får börja efter fyllnad (3+ lika byte) och efter byte som koden läser eller skriver, på någon av de 8 följande
adresserna. Den ska ha minst 6 dokumenterade instruktioner och sluta med RTS eller JMP. RTI räknas bara om rutinen
kvitterar ett avbrott: `$40` avslutar många tabeller. Dessutom gäller:
- **ingen BRK** (nollor);
- **allt inom blocket**, och varje gren landar i det (efter starten) eller på spårad kod;
- **ingen JSR/JMP** in i mitten av en spårad instruktion, eller in i en musikspelare annat än dess init och play (en
  kopia av spelarens kod);
- **ingen 1541-kod:** högst en åtkomst till driverns VIA (`$1800–$180F`, `$1C00–$1C0F`) eller `bvc *`, för en
  snabbladdares drivkod är data för C64:an.

Starten blir en ingångspunkt av sorten `guess` (etikett `code_xxxx`, i inspektorn *Unreached code* med knappen *Mark
as data*). Spårningen fortsätter därifrån, så också det rutinen installerar (en IRQ via `$fffe`) och anropar hittas.
Sedan klassas minnet om för att hitta nya öar, i högst 4 varv, och 5.8–5.11 körs en sista gång. Spelare som hittats
behålls. Loggen får en rad per ö (*Unreached code at $0197: 26 instructions ending in RTS, so it is decoded as code.
Mark it as data (D) if it is not.*). Markerar användaren blocket som data (`D`) blir det data, och spårningen går inte
in i det. Det differentiella testet kör med inställningen av.

**Mätt** på 1060 riktiga program ur referensarkivet: 734 av dem får kodöar (3 495 öar, en fjärdedel mer kod). Alla
734 återskapas byte för byte, musikdetekteringens facit är oförändrat (54 av 57), och analysen tar i snitt 1,5 gånger
så lång tid (250 ms för en hel snapshot).

### 8.11b Packade program och uppackning

`detectPacking()` (`packages/core/src/packing.ts`) körs efter analysen och ändrar ingenting i den. Den avgör om en fil
är en uppackare (decruncher) framför komprimerad data. Tecknen är kalibrerade på några hundra PRG:er ur CSDB-arkivet:

- **Komprimerad data:** andelen 1 KB-fönster med minst 7,2 bitar entropi per byte. Kod ligger nära 6, text och grafik
  lägre, och moderna crunchers ger 7,5–7,95 rakt igenom.
- **Nästan ingen spårbar kod:** uppackaren kopierar sig själv och hoppar till kopian, vilket en statisk spårning inte
  kan följa. En packad fil visar därför några dussin byte kod. Äldre crunchers ger mindre entropi, ungefär 6,5–7.
- **Ett packarnamn i filen** (ASCII, PETSCII eller skärmkoder): Exomizer, PuCrunch, ByteBoozer, TSCrunch, Subsizer,
  Level Crusher, Time Cruncher, Dali, ZX0, Cruncher AB, Matcham, Sledgehammer eller "crunched/packed by".

*Packad* betyder att minst hälften av fönstren ser komprimerade ut, eller lite kod och minst 7 bitar per byte, eller ett
namn tillsammans med komprimerad data. *Kanske packad* betyder minst 20 % av fönstren i en fil med lite kod (under 10 %),
eller lite kod och minst 6,4 bitar per byte. Demon och vanliga program blir inte packade. Filer under 1 KB bedöms inte.

**Sindri, den inbyggda uppackaren** (`packages/sindri`, `@mimir/sindri`) kör varje öppnad fil i en emulerad C64, i en egen
Web Worker. Med C64-ROM:arna från användarens VICE (mappen `C64` bredvid x64sc i inställningarna, annars en VICE den
hittar; huvudprocessen läser dem, kanalen `toolchain:roms`) startar den maskinen, laddar filen och skriver `RUN`; utan
dem kör den med små ersättare för KERNAL och BASIC. Ett nytt lager börjar när processorn hoppar in i kod som det
körande lagret skrev och inte har kört. Varje lager får en sort (*mover*, *decoder*, *decruncher*, *jump*, sist
*program*) och ett fingeravtryck av opkoderna det körde; `data/signatures.json` har 321 kända fingeravtryck från 135
packare, och ett lager som liknar ett av dem till minst 80 % får dess namn. En fil som den skalar ett lager av visas som
packad, även om tecknen ovan inte räckte, med lagren i notisen (`unpackSummary()` i `packages/core/src/sindri.ts`:
"Sindri peels off 2 layers: Exomizer v3.0 (a decruncher at $0100) …; the program starts at $1000") och
packarnamnen i rubriken. Skalar den inget lager av fast den körde programmet tills det stod still (eller gick tillbaka
till BASIC) och tecknen bara räcker till *kanske*, visas ingen notis. Mot unp64 på 550 intron och demos ur arkivet ger
den samma startadress och samma byte för 488 och går ett lager djupare för 17; på 473 andra filer namnger den 429
packare precis som unp64, 2 med samma familj och ingen fel.

**Diskettstationen.** En fil som öppnas från en monterad D64 packas upp med den disken i en emulerad 1541 på
seriebussen: en egen 6502 med 2 KB RAM och DOS-ROM:en från VICE:s mapp `DRIVES`, VIA 1 på seriebussen (ATN, CLK, DATA
och stationens automatiska svar på ATN), VIA 2 på läshuvudet (stegmotor, motor, densitet, SYNC och byte ready på
processorns overflow-flagga) och disken som GCR-spår som 1541 formaterar dem, med D64-filens felbyte inskrivna.
Stationen går efter C64:an i sin egen takt (1 MHz) och hinner ikapp till rätt cykel varje gång C64:an läser eller
skriver seriebussen, så snabbladdare som räknar cykler fungerar. Startfilen läggs i minnet som `LOAD"*",8,1`, och
programmet laddar resten själv, med KERNAL eller sin egen laddare. På första disken av CSDB:s 190 bäst betygsatta demos
kommer 151 längre än startfilen (laddaren laddar och startar nästa del); utan stationen väntade 151 i startfilen, 35
gick tillbaka till READY och 4 kraschade. Ett program på flera disketter väntar när det ber om nästa; skydd som kräver
mer än en D64 rymmer (G64) kommer inte igenom.

**unp64 som externt verktyg.** När uppackaren i inställningarna är unp64 frågar appen den i stället (`unp64 fil -i`, som
inte packar upp något) vilken packare varje öppnad fil har. unp64 känner hundratals packare vid namn. En fil den känner igen visas som packad med det
namnet, även om tecknen ovan inte räckte. Känner den ingen packare och tecknen bara räcker till *kanske*, visas ingen
notis. Prov mot unp64 på 100 PRG:er ur arkivet:
- Av de 90 som unp64 känner igen fann igenkänningen 88.
- Av de 10 den inte känner räknades 9 som opackade.
- Av de uppackade resultaten räknades 65 som opackade. 20 hade ett packlager till som unp64 också känner igen, så de är
  rätt. Bara 9 var tveksamma: 5 *kanske* som unp64 inte känner (visas inte) och 4 *packad* (visas med "unp64 does not
  know the packer").

Med unp64 kan Unpack alltså behöva köras igen på resultatet, eller med unp64:s `-c` som packar upp alla lager. Sindri
går igenom alla lager på en gång.

Appen visar det på tre ställen: en notis över listningen med skälen och var uppackaren börjar, märket *packed* eller
*packed?* på filen i Explorer, och en rad i Problems. CLI:ns `analyse` skriver en `[pack]`-rad (och `packing` med `--json`),
och `mimir unpack fil.prg [-o ut.prg] [--no-roms]` packar upp med Sindri och skriver lagerrapporten
(`mimir unpack demo.d64 [--file NAMN]` tar diskens första PRG med disken i stationen, `--disk` sätter i en disk).

**unp64 följer inte med.** Tidigare installationer innehöll unp64 2.40 av iAN CooG, vars licens bara tillåter
icke-kommersiell spridning, och pekade uppackaren på den (`bundledUnpacker` i `settings.json`). Nu är Sindri
standard och unp64 ingår inte. Står inställningen fortfarande på den medföljande kopian töms den en gång
(`electron/main/settings.ts`), så att Sindri tar över; en uppackare användaren valt själv behålls. Ett e2e-test mot
den installerade appen kontrollerar att `resources\unp64` saknas, att inställningen är tom och att *Unpack* packar upp.

**Uppackning.** Knappen **Unpack** i notisen (eller i kommandopaletten) tar programmet som Sindri sparade
när filen öppnades: lagret där programmet startar, med dess start som programstart (ett BASIC-program som startas med
`RUN` får ingen, analysen hittar dess SYS-rad). Lagerrapporten (`unpackLog()`, som Sindris egen kommandorad skriver
den) visas under *Layer report*. Med ett externt verktyg (13.1: *Extern uppackare*, vanligen unp64) skriver knappen
**Unpack with unp64** i stället en kopia av PRG:n i en ny byggmapp och kör verktyget där med argumentlista, aldrig via
ett skal. Med `{out}` i argumenten används den filen; annars den största nya fil som verktyget skrev. Startadressen läses
ur filnamnet (unp64 skriver `namn.prg.xxxx` där xxxx är JMP-adressen, efter flera pass den sista), annars ur unp64:s
`return to mem: $xxxx`, annars `jmp`/`start`/`sys $xxxx` i utdata. unp64:s `Entry point:` är den packade filens start och
används inte. Packarens namn tas ur raden `<packare>, unpacker=$xxxx`. Ett projekt med en fil
ersätts av den uppackade filen med startadressen som programstart (8.2); i ett projekt med flera filer byts bara filen ut,
och det går att ångra. Verktygets kommandorad och utdata visas i en rad över listningen.

Testerna packar demon med `fakePack()` (`test/helpers/fake-packer.ts`). Det är en liten men riktig packare: en
uppackare i 6502-kod kopierar sin loop till `$0340` och avkodar programmet (xor en 16-bitars LFSR-nyckelström, ungefär
8 bitar per byte) på plats, och demon kör i VICE efteråt. Sindri ger tillbaka demon byte för byte i
`test/sindri.test.ts`, med ersättarna och med VICE:s ROM:ar när VICE finns, och känner igen en Exomizer-fil (när Exomizer
finns) på fingeravtrycket. Den riktiga unp64 packar upp den i `test/unpack.test.ts` när unp64 finns, och testet hoppas
över annars. E2e-testet packar upp med Sindri och sedan med en ersättare för unp64
(`test/helpers/fake-unp64.cjs`) som skriver sitt resultat och sin utdata som unp64, så att det inte beror på vad som är
installerat.

### 8.11c Loaders

`findLoaders()` (`packages/core/src/analyze/loaders.ts`) körs sist i analysen (`AnalysisResult.loaders`). Den letar upp
snabb-, IRQ- och bandladdare och KERNAL:s LOAD. Varje fynd (`LoaderFinding`) har ett namn och säger hur loadern
fungerar. Dess delar (`LoaderPart`) har adress, roll och beskrivning:

- **resident:** loadern på C64:an, med mottagarloopen;
- **drivecode:** koden som skickas till 1541:an och körs där;
- **command:** drivkommandona `M-W`, `M-E` och `M-R`;
- **install:** koden som skickar drivkoden och kommandona;
- **tape**, **kernal**, **text** (loaderns namn).

**Kända loaders**, igenkända på sin egen kod. Byte-mönstren kommer från deras källkod eller utgåvor. Bara byte som inte
beror på var koden ligger finns med, och `..` står för valfri byte:

| Loader | Känns igen på |
|---|---|
| Spindle 3 (lft) | den fasta sidan som börjar `lda #$18 / nop #1 / cmp #$38` (`A9 18 80 01 C9 38`); mottagarloopen `eor $dd00 / sax $dd00` (`4D 00 DD 8F 00 DD`). Delen är hela sidan (standard `$0200`, `jsr` dit laddar nästa del) |
| Spindle 2 (lft) | `ldx $dd00 / sty $dd00 / eor tabell,x` (`AE 00 DD 8C 00 DD 5D`), de två fasta sidorna `$0c00–$0dff` (läst ur spin.exe i 2.3) |
| Krill's loader (Krill/Plush) | `ora $dcc9,x / stx $dd02 / ror / ror / ldx #$3f / sax` och `adc $dd00 / stx $dd02 / iny / beq` (v194, hal-c64-c128.inc); installationen skickar `"M-E" $020b "KRILL."` |
| Bitfire (Bitbreaker/Oxyron) | `adc $dd00 / stx $dd02 / lsr / lsr / dey / cpy #$01`, `ora $dd00 / stx $dd02 / ror / ror / ldx #$3f / sax` (resident.asm), och den äldre `ldy #$37 / lda $dcc9,y / sty $dd02` |
| Sparkle (Sparta/OMG) | `lda $dd00 / sty $dd00 / lsr / lsr / dex / nop / ldy #$c0 / ora $dd00 / sty $dd00` och `and $dd00 / sta $dd00 / ora #0 / sta buffer,x / bvc` (sl.asm), i en senare version `inx` och `ora #1`; texten "sparkle" |
| Covert Bitops loader (Cadaver) | badline-väntan `lda $d011 / clc / sbc $d012 / and #$07 / beq` följd av `lda #$10 / ora $dd00 / sta $dd00` (v3 loader.s), och `M-W` lagrat baklänges (`"W-M"`) |

**I en VICE-snapshot** som öppnats från `$0200` (13.7) finns nollsidan och stacken bara i snapshoten. Sparkle har sin
mottagarloop i stacken (`$0160`). En känd loaders mönster (inte de fasta sidorna) söks därför också i snapshotens
`$0000–$01ff`. Delen som hittas där har `outside`: Explorer visar den utan länk, som *not opened*, och säger att
*VICE snapshots: include the zero page and the stack* i Settings → Analysis tar med den nästa gång snapshoten öppnas.

Den klassiska 2-bitsloopen `lda $dd00 / lsr / lsr / eor $dd00 …` finns i Covert Bitops-loadern men också i många äldre
loaders. Ensam ger den därför bara en okänd loader, med loopen beskriven. Ett namn ensamt, till exempel "KRILL." eller
"sparkle" i en text, räcker inte. Det räknas bara med loaderns kod eller direkt efter ett drivkommando.

**Andra diskladdare** känns igen på det som alla diskladdare har. De samlas i fyndet *A fast loader (not one of the known
ones)*. Är exakt en känd loader hittad blir de i stället dess delar:

- **Drivkod:** absolut åtkomst till 1541:ans VIA-register (`$1800–$180f`, `$1c00–$1c0f`) och GCR-väntan `bvc *` (`50 FE`),
  `lda $1c01` räknas dubbelt. Det gäller i data som C64-koden inte spårats in i. Minst tre åtkomster nära varandra (högst
  160 byte emellan) blir en del, som växer till blockets gränser när de ligger nära.
- **Drivkommandon:** `M-W`, `M-E` och `M-R` med en rimlig adress i drivens RAM eller ROM, i den ordningen eller baklänges.
  Delen säger vad kommandot gör (*M-W $0600, 32 bytes into the drive*, *M-R … reads the drive's ROM (which drive it is)*).
- **Mottagarloop:** minst fyra läsningar av `$dd00` inom 48 byte, också indexerade från `$dcc0–$dcff`. Den beskrivs som
  1-bit, 2-bit eller 2-bit + ATN genom `$dd02` (en enkel VIC-bankväxling läser `$dd00` en gång).
- **Installation:** spårad kod som anropar KERNAL:s LISTEN, SECOND, CIOUT, UNLSN, TALK, TKSA, ACPTR eller UNTLK. Den räknas
  bara när det finns en loader att skicka.

**Band:** spårad kod som väntar på CIA1:s FLAG-linje (`lda $dc0d / and #$10`, `lda #$10 / bit $dc0d` eller `lda #$90 /
sta $dc0d`) och läser eller startar en CIA-timer högst 256 byte därifrån. **KERNAL LOAD:** varje `jsr $ffd5` i spårad kod.

**Packade program:** loadern ligger packad tillsammans med resten, så den hittas inte förrän programmet är uppackat
(8.11b). Explorer säger det. Testerna med riktiga demos (lokalt) gav, uppackade med unp64, Bitfire i Fairlights *1337* och
*Eyes*, *Viva Las Vegas*, *Multiverse*, *O-Tech People III* och *The Lab*, och Sparkle i Genesis Projects *No Bounds*.

**Där det syns:**
- **Explorer → Loaders:** varje loader med namn, hur den fungerar och dess delar som länkar (de första tolv).
  *by its traits* betyder att den hittades på vad loaders gör, inte på sin egen kod. Utan fynd står det att ingen hittades,
  eller att programmet är packat.
- **Analysloggen:** en rad per loader (`Loader: Bitfire (Bitbreaker/Oxyron): …`).
- **Listningen och källkoden:** en kommentarsrad där varje del börjar (`// ==== Spindle (lft): resident page (jsr here to
  load the next part) ====`) och, för längre kod- och datadelar, där den slutar (`// ==== end of Spindle (lft): its part on
  the C64 ====`). Raderna sätts in som kommentarsrader (`Line.mark`), och `.byte`- och `.text`-rader bryts där. Bytena blir
  desamma. Filhuvudet listar loaderna. I listningen har markeringarna accentfärg, och blockrubriken för ett block med en
  loaderdel visar loaderns namn.

**Test:** `test/loaders.test.ts` bygger varje känd loaders loopar ur källkoden (odokumenterade opkoder som `.byte`). Den
testar också en okänd snabbladdare med drivkod, `M-W`/`M-E`, installation och 1-bitsloop, ett bandladdarmönster, KERNAL
LOAD, att demon, showcasen och en VIC-bankväxling inte ger något, och markeringarna i källkoden med verifiering byte för
byte. `fixtures/prg/loader-demo.prg` (Spindle 3-sida på `$0c00`, drivkod, kommandon och installation) är samma program
som testet bygger. E2e-testet öppnar den.

### 8.11d Rasteravbrott

`rasterIrqs()` (`packages/core/src/analyze/raster.ts`) körs sist i analysen (`AnalysisResult.raster`). Den listar varje
IRQ-rutin med rasterraden den körs på. Rutinerna är spårningens IRQ-ingångar och, i en VICE-snapshot, den som
snapshotens IRQ-vektor pekar på, också när koden som satte den inte spårats.

Ett pass över den spårade koden i raka sträckor, som evidenspasset (8.4), följer vad A, X och Y innehåller bit för bit.
Därför ger `lda $d011 / and #$7f / sta $d011` att bit 7 är 0, och `ora #$80` att den är 1.
- **Där en sträcka sätter en IRQ-vektor** (`$fffe/$ffff` eller `$0314/$0315`, båda byten konstanta) till en rutin, är
  sträckans skrivningar till `$d012` och `$d011` (de som ligger närmast) raden rutinen körs på.
- **En rutin som skriver `$d012` utan att sätta vektorn** körs igen på den raden (*itself*).
- **Raden** är `$d012` med bit 7 i `$d011` som bit 8. Skrivs inte `$d011` där räknas bit 8 som 0. Är `$d012` inte en
  konstant (en tabell) visas `?`.
- **Vem som sätter den:** IRQ-rutinen vars kod gör det (en rasterkedja), annars huvudkoden. En rutin utan någon rad
  står med *no line found* (till exempel ett timeravbrott).

Bottenpanelens flik **Raster IRQs** (med antal) visar en rad per avbrott, sorterade efter rasterrad:
- **Line** (decimalt och hex), **$d012**, **$d011** (värdet, *bit 7 = 0/1* när bara den biten är känd, `—` när den
  inte skrivs);
- **Handler**, **Set at** (skrivningen till `$d012`), **By** (huvudkoden, rutinen som sätter den, eller *itself*, och
  vektorn).

Ett klick på raden går till rutinen, ett klick på en adress dit. Demot ger en rad: rad 98 (`$62`, `$d011 = $1b`),
`irq_08b7`, satt av huvudkoden via `$0314`. **Test:** `test/raster.test.ts`: en kedja av tre med bit 8, en rutin som
sätter sin egen nästa rad, en rad ur en tabell, demot och en snapshots rutin som ingen spårad kod installerar.

### 8.11e Djupanalys

**Djupanalysen** (`packages/core/src/analyze/deep.ts`, `Settings.deepAnalysis`, av som standard) byter hastighet mot
noggrannhet. Den slås på med kryssrutan **Deep analysis** överst i fliken Problems eller i *Settings → Analysis → Deep
analysis (slower)*, och gäller projektet. Målet är så få problem som möjligt i Problems (loggens varningar, fel och
tips), utan att något döljs: varje beslut står i loggen (kategori `deep`).

Först görs en vanlig analys, som ger antalet problem att jämföra med. Sedan görs hela analysen om i **varv**:
- **Gissningar spåras på prov.** En kodö (8.11), ett mål i en pekartabell, en IRQ-, NMI- eller BRK-rutin som koden
  installerar och laddadressen utan BASIC-rad spåras först i en kopia av spårningsläget (`trial()` i `trace.ts`). Den
  behålls bara om spårningen inte går in i något problem: JAM, BRK, ett hopp in i en instruktion, överlapp, data som
  användaren markerat, eller ett indirekt hopp via en pekare som ingen kod skriver. Annars blir den kvar som data, och
  loggen säger varför (*The routine-like bytes at $5001 (and 37 more starts up to $5152) stay data: traced on trial,
  they run into a problem (BRK at $6a68 ends the code path)*). Kodöar söks i hela datablocket, inte bara i början, och
  deras grenar får gå ut ur blocket, eftersom provet ändå fäller det som leder fel. Ett tips *Possible unreached code*
  ges inte för byte som spårats på prov och gått in i ett problem.
- **Indirekta hopp via konstanter.** Skriver koden en konstant adress till pekaren som en `JMP (ind)` går genom, är
  adressen ett mål (spårat på prov), och hoppet varnas inte för som okänt.
- **Grenar med kända flaggor.** `CLC`, `SEC` och `CLV` sätter C och V, `LDA`/`LDX`/`LDY` med en konstant sätter Z och N,
  och instruktioner som inte rör flaggorna (`STA`, `PHA`, `SEI`, `NOP` …) behåller dem. En gren efter dem tar bara den
  sida flaggorna ger: efter `lda #$a9 / sta $6497 / bne` spåras inte byten efter `BNE`. Nås sträckan från något annat
  håll (ett hopp in i den, en BIT-skip, en ingångspunkt) eller skrivs instruktionen av kod, följs båda sidorna igen.
- **`$01` genom stacken och variabler.** Minneskonfigurationen (8.7b) följs också genom `PHA`/`PLA` (de två översta
  värdena) och genom variabler som koden bara skriver med `STA`/`STX`/`STY` (`lda $01 / sta save … lda save / sta $01`).
  Så försvinner tipset *$01 is written … with a value the analysis cannot follow* för den vanliga IRQ-rutinen
  `lda $01 / pha / lda #$35 / sta $01 … pla / sta $01`.

Det ett varv lär sig använder nästa varv redan när det spårar:
- **ROM:** en `JSR` eller `JMP` till ett mål som är ROM eller I/O i varje konfiguration instruktionen kan köras med
  följs inte in i RAM:et under (*The JSR at $c88a to $ffe4 reaches the KERNAL ROM there, so the RAM below it is not
  traced*). Ny kod antas köras med huvudkodens konfigurationer. En vektor i `$0314`–`$0319` som pekar på `$e000`–`$ffff`
  är KERNAL:ens egen rutin, för KERNAL:en anropar den med sin ROM inkopplad (`$ea31`).
- **Självmodifierad adress:** en `JSR` eller `JMP` vars operand koden skriver har sitt mål satt vid körning och följs
  inte (*The code at $b07b writes the address of the JSR at $b08c, so its target $b345 is set at run time*). En väg
  som når en instruktion som koden skriver och som nu är BRK eller JAM stannar där, med en rad i loggen i stället för
  en varning.
- **Rutinen finns inte än:** ingen rutin börjar med BRK eller JAM, så en `JSR` eller `JMP` dit följs inte: koden läggs
  dit vid körning, av en uppackare eller en kopieringsslinga (*The JSR at $080d goes to $0900, which holds $00: the
  routine is put there at run time*). Det gäller inte en gissning på prov: där fäller det gissningen.
- **Rutiner som aldrig återvänder:** når alla vägar i en rutin bara loopar, utan `RTS`, `RTI` eller `JMP (ind)`, spåras
  inte byten efter en `JSR` dit.

Varven slutar när nästa varv skulle besluta likadant (samma snitt i varvets kod, samma huvudkonfiguration), efter högst
6. Resultatet är djupanalysens, utom när den vanliga analysen har färre problem: då är det den vanliga, med en rad om
det. `AnalysisResult.deep` (`DeepReport`) har varv, problem före och efter, gissningar som lämnats, snitt, grenar och
tid; Problems visar *150 → 0 problems in 3 rounds, 1.5 s · the Log tells what it left out*. Det differentiella testet
kör utan djupanalys, och den vanliga analysen är oförändrad.

**Mätt** på 1060 riktiga program ur referensarkivet: 4 054 problem blir 620, och 733 program i stället för 341 har
inga problem alls. 105 av de 620 är *very high entropy* (packade program, som ska packas upp först). 7 % mer blir kod,
alla 1060 återskapas byte för byte, och analysen tar i snitt 4–5 gånger så lång tid (som mest drygt 2 s).
Användarens snapshot (en meny vid `$c800` med ett spel i minnet) går från 150 problem till 0 på 1,5 s. **Test:**
`test/deep.test.ts`: ett exempel per regel, att den vanliga analysen har problemen och djupanalysen inte, att allt
assembleras tillbaka byte för byte och att djupanalysen aldrig har fler problem; fuzz-testet slår på den slumpvis.

### 8.11f Spindle-skriptet (Pefchain)

Spindle (lft) länkar en trackmo med **Pefchain** efter ett skript: en rad per del med delens `.pef`-fil och villkoret
som avslutar den (`space`, `-` för direkt, `stay`, `adress = värde`, `@` för musikens interlock), `|` för att fortsätta
delen innan, `-` som namn för Pefchains tomma del och `NN:` för en etikett att söka till. Skriptet finns inte på disken.
Pefchain gör varje rad till en **driver**, ungefär 48 byte kod direkt efter delens kod: den installerar delens avbrott,
anropar dess setup, anropar laddaren och nästa dels prepare, väntar på villkoret, kör fadeout och cleanup och hoppar
till nästa driver. `findSpindle()` (`packages/core/src/analyze/spindle.ts`) läser tillbaka driverna i minnet till
skriptets rader (`AnalysisResult.spindle`, `SpindleDriver`), direkt efter startpunkterna (8.2).

- **Koden** är den Spindle 3.0 och 3.1 skriver (`pefchain.c`: `generate_drivers` och rutinerna den anropar,
  MIT-licens; `template/earlysetup.s` och `seek.s`, public domain). Den är kontrollerad mot driverna som
  `pefchain -v -v` skrev ut för egna testdelar. Spindle 2 bygger andra drivers, som inte läses.
- **Var de hittas:**
  - sidodörrar (`lda #$4c / sta zp / pla / sta zp+1 / pla / sta zp+2 / jsr zp`), där en sökning eller nästa
    disksida kommer in. Den första drivern har den tidiga setupen före och `clc / bcc` förbi sidodörren;
  - framdörrar som sätter `$fffe/$ffff` och gör `lsr $d019 / cli`;
  - de drivers som de hoppar till.
- **Krav:** hela drivern måste följa Pefchains mönster till slutet: `jmp` till nästa, `clc / bcc *`, ett söksprång
  till nästa disksida, eller en del som stannar. En framdörr som bara gör det vilken kod som helst gör (installerar ett
  avbrott, anropar och hoppar) räknas bara när den hoppar till en driver.
- **Vad som läses:**
  - delens rutiner (prepare, setup, irq, main, fadeout, cleanup) och villkoret;
  - nästa dels prepare;
  - om den laddar (`jsr` till laddarens residenta sida, `$0200` om inget annat syns);
  - nästa driver, och etiketten den söker innan den hoppar tillbaka (`-L`);
  - J-taggen (delens fadeout väljer en etikett);
  - Pefchains tomma del (dess avbrott och setup, och musiken den spelar);
  - `|`.
- **Ett ensamt anrop** som kan vara både delens cleanup och nästa dels prepare blir cleanup när det ligger närmare
  under den här drivern än under nästa.
- **Ordning och nummer:** delarna står i den ordning de körs, och den första driverns kedja kommer först. `|` behåller
  sin dels nummer. I en snapshot är den del som kör *running*: PC:n är i dess driver, eller IRQ-vektorn pekar på dess
  avbrott.
- **Startpunkter:** driverna är ingångar (`entry`). I en snapshot är driverna för delarna före den som kör gissningar
  (`guess`, som djupanalysen spårar på prov), eftersom senare delar kan ha laddat över deras rutiner.
- **Etiketter** heter efter delen:
  - `spindle_start` för den tidiga setupen;
  - `part2_driver` (`part2_driver2` för `|`) och `part2_seek` för sidodörren;
  - `part2_prepare`, `part2_setup`, `part2_irq`, `part2_main`, `part2_fadeout` och `part2_cleanup`.
- **Källkoden:**
  - filhuvudet har skriptet som kommentarer;
  - en `====`-rad markerar varje driver med sin skriptrad (*the early setup and the first driver*, *its driver*,
    *a driver that goes on with it*);
  - fler `====`-rader visar var sidodörren och framdörren är.

Bottenpanelens flik **Spindle script** (med antal) finns bara när analysen hittat drivers. Den har en rad per skriptrad:
- **Part**;
- **Script line**: namnet (`partN.pef` är påhittat, eller `|` eller `-`) och villkoret, med etiketten `01:` före när
  en loop visar den;
- **Driver**;
- **Routines**: klickbara etiketter, och *loads*, *blank part*, *interlock* eller J;
- **Then**: nästa del, *its | line*, *back to part 1 · seeks label 01*, *the end of the demo*, *stays*, *the next disk
  side*, eller en adress som inte är i minnet.

Ett klick på raden går till drivern, ett klick på en rutin dit. **Copy script** kopierar skriptet som text, så som
Pefchain läser det, med drivern och rutinerna efter `#`.

**Mätt:**
- inga drivers i de 1078 programmen i testkorpusen, och ungefär 2 ms per program;
- en VICE-snapshot av en trackmo som `pefchain` 3.1 byggt av fem egna testdelar gav alla sex drivers, med rätt villkor,
  rutiner och del som kör.

**Test:** `test/spindle.test.ts` innehåller:
- driverna pefchain skrev för fem skript: alla villkor, `|`, den tomma delen, etiketter, J, en loop och sista delen på
  en disksida;
- skriptet som text;
- etiketter, markeringar och byte-exakt bygge;
- en snapshot;
- kod som installerar ett avbrott som en driver gör men inte är en.

`fixtures/prg/spindle-demo.prg` är minnet från det första skriptet.

## 9. Symboldatabas

| Kategori | Område | Namnexempel |
|---|---|---|
| VIC-II | `$D000–$D02E` (speglat var `$40` till `$D3FF`) | `VIC_RASTER`, `VIC_BORDER_COLOR`, `VIC_MEM_SETUP`, `VIC_SPR0_X` |
| SID | `$D400–$D41C` (speglat var `$20`) | `SID_V1_FREQ_LO`, `SID_V1_CTRL`, `SID_MODE_VOL`, `SID_OSC3` |
| CIA 1 / CIA 2 | `$DC00–$DC0F`, `$DD00–$DD0F` (speglat var `$10`) | `CIA1_ICR`, `CIA1_PRA`, `CIA2_PRA`, `CIA2_TA_LO` |
| Färg-RAM, skärm | `$D800`, `$0400`, `$07F8` | `COLOR_RAM+12*40+5`, `SCREEN_RAM+24*40`, `SPRITE_PTRS+3` |
| KERNAL | hopptabell `$FF81–$FFF3` + kända rutiner | `CHROUT`, `GETIN`, `SETLFS`, `CLRSCR`, `IRQ_HANDLER` (`$EA31`) |
| BASIC-ROM | utvalda rutiner | `STROUT` (`$AB1E`), `LINPRT` (`$BDCD`) |
| Vektorer | `$0314–$0329`, `$FFFA–$FFFF` | `CINV`, `CINV+1`, `NMINV`, `IRQ_VECTOR` |
| Systemvariabler | nollsidan, sida 2 | `CPU_PORT` (`$01`), `LSTX` (`$C5`), `TIME+2`, `KEYD` |

**Upplösningsregler:** (1) laddat program vinner över ROM-namn, (2) I/O-namn vinner i `$D000–$DFFF` utom för JSR/JMP, (3) flerbytesymboler ger `NAMN+n`, (4) skärm och färg-RAM uttrycks som `rad*40+kolumn`, (5) speglingar som `VIC_RASTER+$40`. Symbolerna exporteras som `include/c64-hardware.asm` (`.label NAMN = $xxxx // beskrivning`), eller inline, eller inte alls. Det tredje valet heter *Real addresses* i Settings → Kick Assembler output → *Hardware registers and KERNAL routines* (`hwInclude: 'none'`, sparas i projektet). Då skrivs adressen själv (`sta $d020`, `jsr $ffd2`, i nollsidan med två siffror som förut), varken `#import` eller `include/c64-hardware.asm` skrivs, och med hårdvarukommentarer på står registrets beskrivning kvar som kommentar (`sta $d020 // Border color`). Listningen visar namnet när muspekaren står på adressen. **Planerat:** spårning av skrivningar till `$01` så att `$A000–$BFFF`/`$E000–$FFFF` tolkas som RAM när ROM är bortbankat.

## 10. Interaktiv editering och refaktorisering

| Kommando | Tangent | Effekt |
|---|---|---|
| Döp om etikett | `N`, dubbelklick, högerklick → *Rename label…* | Inline-popover; alla referenser uppdateras direkt. Gäller också `.label namn = $xxxx`-rader: nollsidevariablerna och andra filers etiketter i filhuvudet, och etiketterna i binärblock. Appen minns vilken sådan rad som klickades, eftersom filhuvudets rader delar adress. En nollsidevariabel har märket *zero page* på sin rad, och redigeringsrutan heter *Zero-page variable at $xx*, har varningsfärg och förklarar att varje åtkomst till `$xx` (och `$xx+1` för en pekare) får namnet. Högerklicksmenyn säger *Rename zero-page variable…*. Ett nytt namn får inte heller krocka med en nollsidevariabel |
| Kommentar | `;` | Kommentar i slutet av raden som följer med i exporten |
| Kommentarrad / kommentarblock | `/` / `*`, högerklick, dubbelklick för att ändra | Egen `//`-rad eller ett `/* … */`-block ovanför raden och dess etikett; `.byte`/`.text`-rader bryts vid adressen; tom text tar bort |
| Kommentera en nollsidevariabel | `;`, `/`, `*` och högerklick på dess `.label`-rad i filhuvudet, inspektorn | Som för ett block: inspektorn visar *Zero-page variable* (adress, referenser, namn, *Comment* ovanför `.label`-raden och *End-of-line comment* i slutet av den) när `.label`-raden klickats. Kommentarerna sparas på variabelns adress (`Project.comments`, `Project.notes`), som inte är laddade bytes, och skrivs bara på `.label`-raden: `.label ptr = $fb   // pekare till skärmen` med `//`-rader eller ett `/* … */`-block ovanför. Raderna bär adressen i `zp`, och listningen markerar den klickade raden. NOTES.html/.txt listar dem med variabelns namn |
| Markera som kod / bytes / ord / text | `C` / `D` / `W` / `T` | Override från markörens rad till blockets slut, eller över markeringen |
| Fler typer | högerklick → Mark as | Screen codes, PETSCII och screen codes i *mixed case* (gemener och versaler), tabell, sprite, charset, bitmap, skärmmatris, musik, fyllnad |
| Talformat och antal per rad | inspektorn: *Format* och *Bytes per row* / *Words per row* | För data, tabeller och words. *Hex* (standard för data och tabeller), *Dec* eller *Bin* (bitarna: `.byte %00000110`, `.word %0000111000000110`). Words har också *Addr* (standard): värdet är en adress och blir en etikett där det pekar in i programmet. Med ett talformat blir words alltid tal. Antal per rad är 1–64; standard är inställningen *Bytes per row* för data och 1 för words. Enter eller att lämna fältet tar det, och piltangenterna stegar det. Ändringen sparas som en override av blockets typ med dess övriga inställningar (`formatOverride` i core). Den utgår från projektets senaste override över blocket, så en andra ändring innan analysen hunnit med den första behåller den första. Ångras med `Ctrl+Z` |
| Rensa override | `U` | Återgår till automatisk analys |
| Slå ihop block | högerklick → *Merge with previous/next block*, inspektorn, kommandopaletten | Blocket och grannblocket före/efter (i samma fil) blir ett block av blockets typ, med dess inställningar (kodning, tabelltyp, talformat, radlängd, musikens init/play); lo/hi-tabeller och BASIC blir data. Görs som en override över båda (`mergeOverride` i core), så ångra och round-trip fungerar som vanligt; kod delas fortfarande per rutin |
| Flytta en byte till grannblocket | dra raden i adress- eller bytekolumnen till blocket ovanför eller nedanför, högerklick → *Move $xxxx into the previous/next block* | Bara en rad i blockets kant går att dra: blockets första rad uppåt och sista rad nedåt, till ett grannblock i samma fil. Raden visar handen i adress- och bytekolumnen, och tipset säger vilka byte som går vart. Under dragningen är målblocket markerat och en etikett vid pekaren säger vad som händer (*↑ Move $0960 into the Text block above*). Släpps raden någon annanstans händer ingenting, och `Esc` avbryter. Det som flyttas är en byte, utom i kod där hela instruktionen flyttas och på en `.word`-rad där båda byten flyttas. Fler byte flyttas med fler dragningar. Att dra i källtexten markerar som förut, och `Shift` gör alltid en markering. Grannblocket växer med byten och behåller sin typ och sina inställningar. Blocket de lämnar behåller sin typ för resten (text, tabell, ord, sprite, charset, bitmap, skärmmatris, musik och fyllnad, som detekteringen annars kunde läsa annorlunda när blocket blivit kortare). Blockets kommentar, uteslutning ur bygget och binärfil följer med när blockets start flyttas (`moveBlockKeys`). Det görs som overrides (`moveBytes` och `lineMove` i core), så det ångras med `Ctrl+Z`. Kod delas per rutin, så en instruktion kan inte flytta mellan två kodblock, och BASIC-raden läses från sina rader |
| Slå ihop ett intervall | `M`, högerklick → *Merge range into one block…*, inspektorns *Merge range…*, kommandopaletten | En dialog med start, slut (inklusive) och blocktyp. Står markören i ett block behövs bara slutet: starten och typen tas från blocket (ett valt intervall fyller i både start och slut). Dialogen visar direkt vilka block som blir ett och vilka block intervallet kapar (delen utanför behåller sin typ). Ingenting ändras förrän sammanfattningen bekräftats i ett andra steg (*Merge N blocks*). Intervallet måste ligga i en laddad fil. Har typen samma typ som blocket där intervallet börjar tas dess talformat, radlängd, tabelltyp och musikens init/play med. Görs som en override (`mergeRange` i core), ångras med `Ctrl+Z` |
| Bokmärke | `B`, högerklick → *Add bookmark…* / *Edit bookmark…*, `+` i bokmärkeslistan, kommandopaletten | En redigerare överst i bokmärkespanelen i sidofältet, med adress, titel och anteckning. Den täcker inte listningen, som visar koden på adressen mitt i bilden. Ändras adressen visar listningen den nya platsen, och *Cursor line* tar raden markören står på (man kan klicka i koden medan man skriver). `Esc` stänger utan att spara. Titeln föreslås från etiketten på adressen, annars `$xxxx`. Adressen kan ändras (bokmärket flyttas) men måste ligga i en laddad fil, och två bokmärken kan inte dela adress. `B` på en rad som redan har ett bokmärke redigerar det. Det gäller också en `.byte`-rad eller ett ihopfällt block som innehåller bokmärkets adress. Raden får en liten bokmärkessymbol i vänsterkanten; ett klick på den öppnar listan med anteckningen. Bokmärken sparas i projektfilen men aldrig i källkoden, och de ångras med `Ctrl+Z` |
| Bokmärkeslistan | `Ctrl+B`, aktivitetsradens bokmärkesknapp (visar antalet) | Alla bokmärken sorterade efter adress, med adress och titel, och filtrerbara på titel, anteckning och adress. Ett klick visar hela anteckningen med *Go to*, *Edit* och *Delete*, och ett klick till döljer den. Ett dubbelklick går till platsen i koden |
| Nästa / föregående bokmärke | `F2` / `Shift+F2` | Går till bokmärket efter eller före markörens rad och börjar om från första eller sista. Titeln visas i en toast |
| Patch | `P`, högerklick → *Patch selection/line/block with new code…*, kommandopaletten | Ny kod skrivs över markeringen (eller raden vid markören) i de laddade bytena; `P` på en patchad rad redigerar patchen (10.2) |
| Lägg till startpunkt | `E` | Spårning från adressen |
| Programstart | Explorer → *Program start* (adress eller etikett), högerklick → *Set as program start*, kommandopaletten | Ersätter den detekterade starten (8.2); *Use the detected start* tar bort valet |
| Korsreferenser | `X` | Bottenpanelen visar alla referenser till raden |
| Gå till / välj intervall | `G`, `Ctrl+G` | Hex-adress eller etikettnamn; ett intervall (`$2000-$27ff`, `colors_0939-$0ab4`, slutet inräknat) markeras |
| Följ en referens | klick på en etikett eller dess `+n` | Ett klick på etiketten i `lda tabell+1` går till tabellen. Ett klick på `+1` går till tabellen plus förskjutningen, alltså byten som instruktionen faktiskt läser. Det gäller även `smc_08ef+1` (operanden som självmodifierande kod skriver) och `music.location+$0020`. Förskjutningen kan stå decimalt, som `$hex` eller som `%binär`. Länken räknas ut i listningen, så motorns utdata är oförändrad |
| Navigering | `Enter` följ operand · `Esc` tillbaka · `Alt+←/→` | Navigeringshistorik som i en webbläsare. Är högerklicksmenyn (eller ⋯-menyn) öppen stänger `Esc` bara den, med undermenyn |
| Cykelräkning | *Cycles* i listningens verktygsrad, kommandopaletten | Visar varje instruktions 6510-cykler och räknar markeringen eller kodblocket vid markören längs en väg, med de brancher användaren markerar som tagna (10.1). Valet sparas per användare |
| Data som kod | *Data as code* i listningens verktygsrad, kommandopaletten | Visningsläge: varje block som inte är kod (utom fyllnad) visas disassemblerat linjärt från blockets start, kursivt och märkt *as code*, så att kod som klassats som data syns; markera och tryck `C`. Exporten, verifieringen och radnumren i filen påverkas inte (vänsterkolumnen visar då adresser). Raden man tittar på står kvar på samma ställe på skärmen när läget växlas åt båda hållen: markörens rad om den syns, annars översta raden med byte, fast raderna ovanför blir fler eller färre |
| Utanför bygget | högerklick → *Exclude block from the build* / *Include block in the build*, inspektorns *Include in the build*, kommandopaletten | Blocket står kvar under `#if INCLUDE_<namn>` med etiketterna i `#else`; rubriken märks *not built* och raderna tonas ned (11.5) |
| Fäll ihop / ut block | knappen på blockrubriken, `F`, högerklick, kommandopaletten (*Fold every block that is not code*, *Fold all blocks*, *Unfold all blocks*) | Ett ihopfällt block visar bara rubriken med antal dolda rader; rubriken står för hela blocket (markör, piltangenter, markering). *Gå till* en adress inuti blocket fäller ut det. Bara visning: exporten, radnumren i filen och projektfilen påverkas inte |
| Vänsterkolumn | *Address* / *Line* i listningens verktygsrad, kommandopaletten | Minnesadress (standard) eller radnummer i `.asm`-filen (samma som Kick Assemblers felmeddelanden och källvyn); valet sparas |
| Markering | dra i listningen eller heatmap, `Shift`+klick/pilar/`PgUp`/`PgDn`/`Home`/`End` | Intervall för mark-as; klick på en blockrubrik tar med hela blocket, dragning förbi kanten rullar listningen |
| Minneskonfiguration / VIC-bank | högerklick → *Memory configuration ($01)* / *VIC bank*, inspektorn för kodblock | Koden i markeringen (eller från raden till blockets slut) körs med det valda `$01`-värdet eller den valda banken (8.7b); *Detected* tar bort valet |
| Kopiera rader | `Ctrl+C` i listningen, högerklick → *Copy N selected lines* / *Copy line*, kommandopaletten | Markeringens rader som källkoden skriver dem, i ordning och med indrag: instruktioner och data, etiketter och kommentarsrader inuti den, och rubriken på ett block som markeringen täcker helt. Ett ihopfällt block i markeringen följer med helt. Utan markering kopieras raden vid markören. Text som markerats med musen någon annanstans (loggen, inspektorn) kopieras som vanligt |
| Ångra / gör om | `Ctrl+Z` / `Ctrl+Y` | Hela projektet; senaste åtgärden visas i tooltip |
| Kommandopalett | `Ctrl+Shift+P`, `F1` | Alla kommandon sökbara |
| Verifiera / bygg och kör | `F7` / `F5` | Round-trip / KickAss + VICE |

**Override-modellen:** overrides lagras som en ordnad lista i projektet. `analyze()` applicerar dem i ordning (senare vinner, `auto` rensar). Bara det som fortfarande vinner räknas: en override som senare overrides täcker helt lämnar ingen blockgräns, inga props, ingen startpunkt och ingen linjär disassemblering efter sig. Att markera ett intervall slår därför ihop blocken och de tidigare overrides i intervallet till ett nytt block; en override som bara delvis täcks behåller resten som eget block. Kod-overrides blir startpunkter och, om spårningen inte når hela intervallet, linjär disassemblering. Data-overrides blockerar spårning in i intervallet och rapporterar kodvägar som når dem.

**Strukturer:** datablock, tabeller och words har radlängd och talformat (`hex`/`bin`/`dec`, för words också adresser), se tabellen ovan. Sprites exporteras som 21 rader binära `.byte`-triplar plus utfyllnadsbyte, teckensnitt per tecken med teckenkod, skärmmatriser 40 byte per rad. **Planerat (M4):** användardefinierade structs (fältnamn, storlek, antal) som exporteras med `.struct`/`.byte`-fält och fältvisa etiketter.

### 10.1 Cykelräkning

`packages/core/src/cpu/cycles.ts` har cykeltalen för alla 256 opkoder på NMOS-6510, även de odokumenterade (JAM stoppar
CPU:n och visas `—`). Testet jämför tabellen med reglerna per adresseringssätt och åtkomst i opkodtabellen.
`instructionCycles` ger en instruktions cykler:
- Indexerade läsningar (`abs,x`, `abs,y`, `(zp),y`) får `+`: en cykel till om indexet går över en sida. En absolut bas
  med låg byte `$00` kan inte gå över (`$1000,x` stannar i `$10xx`) och får inget `+`.
- En branch tar 2 cykler när den inte tas och 3 när den tas, eller 4 när målet ligger på en annan sida än nästa
  instruktion. Det syns direkt i adresserna.

**Listningen** får en kolumn med `4`, `4+` och för brancher knappen `2/3` (eller `2/4`). Ett klick på knappen markerar
branchen som tagen, och den gällande siffran visas fet.

**Vägen** (`cyclePath`) räknas över markeringen, eller över kodblocket vid markören utan markering. Ett klick på en
blockrubrik markerar hela blocket. Vägen börjar vid starten och kör varje instruktion en gång:
- En tagen branch framåt hoppar till målet, och raderna emellan tonas ned och räknas inte.
- En tagen branch bakåt (en loop) upprepas inte. Inspektorn visar i stället vad ett varv till tar, från målet till och
  med den tagna branchen.
- `jmp` framåt följs. En retur, `jmp` bakåt eller ut, eller en branch ut ur intervallet avslutar vägen.
- Subrutiner (`jsr`) och sidövergångar räknas inte in, men antalet visas.

Kolumnen visar summan efter varje rad (`Σ`). Inspektorns **Cycles** visar:
- totalen för vägen och totalen utan tagna brancher;
- antalet instruktioner, hur många cykler sidövergångar kan lägga till och hur många `jsr` det finns;
- varje branch med kryssruta, sina två cykeltal och totalen om den togs åt andra hållet, eller loopvarvet.

Statusraden visar totalen. Markerade brancher är visningsläge och sparas inte i projektet.

**Historik:** i produktion används Immer-patchar (inverterbara) i stället för hela ögonblicksbilder; prototypen sparar 100 ögonblicksbilder, vilket är billigt eftersom filbuffertar delas.

### 10.2 Patchar

En patch är ny kod som användaren skriver över ett intervall av de laddade bytena (`packages/core/src/patch.ts`).

- **Dialogen** (`P` på en markering, högerklick, kommandopaletten) heter *Patch $xxxx–$yyyy* och har:
  - ett namn (förslag `patch_xxxx`), unikt i projektet och också namnet på PRG-filen;
  - koden, ifylld med intervallets rader som listningen skriver dem (instruktioner, data, etiketter, kommentarer);
  - *Fill the rest with*: NOP (`$ea`, standard) eller byten som redan står där;
  - *Overwrite past the range*.
- **Kodrutan** ser ut som en assemblerlistning. Till vänster om varje rad står adressen och de första byten den blir:
  en rad med bara en etikett får sin adress, och en rad som går förbi intervallet står i varningsfärg. Raden med
  markören och raden med ett fel har var sitt band över hela bredden. Rubriken säger *Code at $xxxx* och tangenterna.
  - Markören står på första instruktionen när dialogen öppnas.
  - `Tab` går till nästa instruktion och `Shift+Tab` till föregående, runt till första och sista. En instruktion är en
    rad med kod efter en eventuell etikett, inte en ensam etikett, en kommentar eller en tom rad.
  - `Enter` ger en ny rad med instruktionernas indrag.
  - `Ctrl+Enter` lägger in patchen och `Esc` stänger.
  - **Skriva över originalet** (en ny patch, vars rader börjar som originalets): ett tecken som skrivs där en
    originalinstruktion börjar (där markören står när dialogen öppnas och efter `Tab`) ersätter hela instruktionen
    till radens slut. Ändras en originalrad någon annanstans ändras bara det. I båda fallen flyttar originalet till
    kolumnen *Original* längst till höger, överstruket. Det är inte en del av koden och räknas inte. `Ctrl+Z` i
    kodrutan tar tillbaka originalraden, och då försvinner den ur kolumnen. Raderna följs när rader läggs till eller tas
    bort. Kolumnen syns när något har skrivits över.
- **Koden** är Kick Assembler. Den assembleras medan man skriver, med den inbyggda Kick-subset-assemblern, från
  intervallets start. Programmets etiketter och nollsidevariabler (som listningen namnger dem) och hårdvarunamnen i
  `include/c64-hardware.asm` går att använda. Ett namn som koden själv definierar vinner. Dialogen visar hur många byte
  koden blir av intervallets, vad resten fylls med, och byten som skrivs och byten de skriver över. Fel visas med
  radnummer i koden. Varje rad får en egen etikett före sig när den assembleras (`assemblePatch`), och etikettens
  värde är radens adress. Därför syns adresserna så långt assemblern kom, även när koden har ett fel eller är för lång.
- **Behåll cykeltalet** (*Keep the cycle count*, sparas med patchen som `cycles`):
  - Patchen måste ta exakt lika många cykler som originalet. Båda räknas rakt igenom från intervallets start till
    dess slut, eller till kodens slut när den är längre (`straightCycles`). Den nya koden räknas med sin
    NOP-utfyllnad (2 cykler per NOP), eller med originalets byte efter koden när de behålls.
  - Instruktioner vars tid varierar är en branch (2 eller 3 cykler, 4 över en sida), en indexerad läsning som kan gå
    över en sida (`abs,x`, `abs,y`, `(zp),y`, men inte `$xx00,x`) och JAM. Koden får bara ha sådana som originalet har
    i intervallet: samma opkod som varierar på samma sätt, till exempel `bne (2/3)` eller `lda $xxxx,x (4+)`. Den måste
    också ha alla originalets. Då varierar den nya koden precis som originalet, och lägsta och högsta tiden blir
    desamma. Annars blir det fel: en varierande instruktion som originalet inte har ger radnumret (*…, and the original
    has none*), och en som saknas ger *It has no bne (2/3)*. JAM går aldrig.
  - Kodrutan får kolumnen *Cy* med varje rads cykler, där en varierande står i varningsfärg (`2/3`, `4+`). Längst ner
    står *Cycles N of M*, eller *N–N′ of M–M′* när tiden varierar, och hur många som är kvar att använda, hur många för
    många eller *the same as the original*. Där står också originalets varierande instruktioner (*varies as the
    original: bne (2/3)*) eller vad koden saknar (*the code needs bne (2/3), as the original has*).
  - *Apply patch* går först när cyklerna är lika och de varierande instruktionerna stämmer.
- **Längden:** koden får inte bli längre än intervallet. Med *Overwrite past the range* får den skriva vidare över
  byten efter intervallet, och dialogen säger vilka. Den får aldrig gå utanför filen som håller intervallet eller in i
  en annan patch, och den måste skrivas i ett stycke från starten (ingen egen `.pc`). Utan kod fylls intervallet med NOP.
- **Patchen skrivs över filens byte**, och projektet sparar den i `Project.patches`: namnet, intervallet, koden,
  valen, byten den skrev (`bytes`) och byten den skrev över (`old`), base64 i `.mimir.json`. Analysen och allt annat
  (verifiering, Build & Run, Pack) ser alltså de patchade bytena.
- **Listningen markerar** de patchade byten: raderna tonas, byten och kanten står i varningsfärg, och första raden
  har märket *patch namn*. Källkoden får en kommentarsrad där patchen börjar och slutar
  (`// ==== patch "namn": $xxxx-$yyyy, N bytes written over the original ====`, `// ==== end of patch "namn" ====`).
- **Explorer → Patches** (bara när det finns patchar) listar dem efter adress med en på/av-knapp, namn och intervall,
  och storleken i tipset. Rubriken säger *N on* eller *N of M on*. Ett klick går dit och markerar byten, och knapparna
  redigerar, sparar som PRG och tar bort.
- **Av och på** (knappen i Explorer, högerklick, kommandopaletten, `switchPatch`): en avstängd patch lägger tillbaka
  de ursprungliga byten men står kvar i listan (`off` i projektet, nedtonad i Explorer). Den behåller sitt intervall,
  så ingen annan patch kan skrivas där. Listningen och källkoden markerar den inte, men exporten skriver ändå dess PRG.
  Påslagen skrivs den över byten igen.
- **Redigera:** `P` eller högerklick på en patchad rad öppnar *Edit patch "namn"* med den sparade koden. Patchen
  skrivs då om över byten den en gång skrev över. En avstängd patch förblir avstängd.
- **Ta bort** lägger tillbaka de ursprungliga byten. Allt ångras med `Ctrl+Z`.
- **Spara som PRG:** *Save patch as PRG…* (Explorer, högerklick, kommandopaletten) sparar `namn.prg` med patchens
  adress som laddadress och byten den skriver.
- **Exporten** skriver varje patch som en egen Kick Assembler-källa, `patches/<namn>.asm` (`patchSource`), och listar
  dem i README, där avstängda märks *switched off: not in the sources*. Filen assemblerar för sig själv till en PRG som
  laddas där patchen ska ligga:
  - en kommentar med namnet, intervallet och filen den skrivs över;
  - `.label` för de namn koden använder (programmets etiketter och nollsidevariabler och hårdvarunamnen);
  - `.pc = $xxxx "namn"`, koden som den skrevs och `.fill N, $ea` för NOP-utfyllnaden.

  Ger koden inte längre samma byte med programmets namn (en etikett har döpts om, till exempel), innehåller filen i
  stället byten som `.byte`-rader och koden som kommentar. Testerna assemblerar filen ensam med den inbyggda
  assemblern och med KickAss.jar. `original/` innehåller filerna som de laddades, utan patcharna, medan källkoden och
  `out/` har de påslagna patcharna i sig.
- En fil som tas bort ur projektet, eller packas upp, tar sina patchar med sig.

## 11. Kick Assembler-generatorn

### 11.1 Filens struktur

```
// raster-demo.prg — re-assembled by Mimir Studio
// load $0801-$37ff (12287 bytes) · entry start · Kick Assembler 5.x

#import "include/c64-hardware.asm"

// zero page
.label ptr_fb = $fb

.var music = LoadSid("music/music_1000.sid")

// ---- BASIC · $0801-$080c (12 bytes) ------------------------------
BasicUpstart2(start)                    // 10 SYS2064

// ---- Code · start · $0810-$0865 (86 bytes) -----------------------
.pc = $0810 "Code"
start:
        jsr CLRSCR                      // Clear screen and home cursor
        jsr init_screen
        sei
        lda #$00
        jsr music.init
        ...
        lda #<irq_08b7
        sta CINV                        // IRQ vector (KERNAL)
        lda #>irq_08b7
        sta CINV+1
        ...
        jmp *
```

### 11.2 Formatteringsregler

Inställningsbara: mnemonics gemener/VERSALER, hex-skiftläge, indrag (2/4/8), kommentarkolumn, byte per `.byte`-rad, adresskommentarer, hårdvarukommentarer. Etiketter står på egen rad. Varje block inleds av en sektionskommentar och, där det behövs, `.pc = $xxxx "Namn"` så att Kicks minneskarta (`-showmem`) blir läsbar.

### 11.2b Textkodningar

Ett textblock skrivs med Kick Assemblers `.encoding` och `.text` (`src/c64/text.ts`, tabellerna uppmätta med KickAss 5.25):

| Typ | `.encoding` | Skrivs som tecken |
|---|---|---|
| Text (PETSCII) | `petscii_upper` | `$20–$5d` utom `"` och `£` |
| Text (PETSCII, mixed case) | `petscii_mixed` | som ovan, `$41–$5a` som gemener, `$c1–$da` som versaler |
| Text (screen codes) | `screencode_upper` | `@` (`$00`), `A–Z`, `[`, `]`, `$20–$3f` utom `"` |
| Text (screen codes, mixed case) | `screencode_mixed` | `@`, `a–z` (`$01–$1a`), `A–Z` (`$41–$5a`), `[`, `]`, `$20–$3f` utom `"` |

Allt annat — inverterade tecken (`$80–$ff`), grafiktecken, `"`, `£`, `↑`, `←`, styrkoder — har inget tecken som visar
samma sak och skrivs som `.byte`, så att bygget blir byte-exakt. En screen code `$00` skrivs som `@` inne i en text men
som `.byte $00 // end` sist (ett slutmärke). Mixed case väljs för text gjord för teckenuppsättningen med gemener: med
`*_upper` skulle varje versal där bli en `.byte`. Det inbyggda assemblerets tabeller är desamma som KickAss.jar:s, även för
tecken som skickas igenom oförändrade.

### 11.3 Specialfall som garanterar byte-exakthet

| Situation | Utdata |
|---|---|
| Absolut adressering av nollsideadress (`AD 02 00`) | `lda.abs $0002` — annars väljer assemblern zp-formen och programmet krymper |
| Zp-adressering av programetikett som definieras senare | `lda.zp label` |
| Odokumenterad opkod utan entydig Kick-mnemonic | `.byte $8b, $00 // xaa #$00 (undocumented, unstable)` |
| BIT-skip | `.byte $2c` + etikett på den gömda instruktionen |
| `JMP` till sig själv | `jmp *` |
| BASIC-stub som matchar makrot | `BasicUpstart2(start)`, annars rå `.byte` med BASIC-raden som kommentar |
| Musik | `LoadSid` + `.fill music.size, music.getData(i)` |
| Teckensnitt / bitmap | `.import binary "gfx/charset_3000.bin"` (eller inline) |
| Text | `.encoding "petscii_upper"` / `"screencode_upper"` + `.text`; styrkoder och tecken som inte kan citeras som `.byte` med namn (`RETURN`, `CLR`) |
| Pekartabeller | `.byte <fx_0919, <fx_091a` / `.byte >fx_0919, >fx_091a` |
| Pekare i data / SMC | `label+1`, `smc_08ef+1` |
| Flera filer | En `.asm` per PRG; etiketter från andra filer deklareras som `.label` i sektionen "labels defined in other files" |

**Att validera mot Kick Assembler-versionen i produktion:** suffixsyntaxen för tvingad adressering (`.abs`/`.zp`) och mnemonic-listan för odokumenterade opkoder. Båda är inställningar i generatorn, och round-trip-steget med riktiga KickAss.jar fångar avvikelser direkt.

### 11.4 Exporterat projekt

```
raster-demo/
├─ raster-demo.asm              om-assemblerad källkod
├─ include/c64-hardware.asm     symboler (VIC, SID, CIA, KERNAL, system)
├─ music/music_1000.sid         PSID v2, laddas med LoadSid
├─ gfx/charset_3000.bin         binärdata med .import binary
├─ build.bat / build.sh         KickAss + VICE med inställningarnas sökvägar, eller användarens egen version
├─ README.md
├─ NOTES.html                   bokmärken och kommentarer med koden runt dem (bara när det finns några; eller NOTES.txt)
├─ raster-demo.mimir.json      projektet (kan öppnas igen)
├─ original/raster-demo.prg     indata
└─ out/raster-demo.prg          verifierad om-assemblerad PRG
```

**Byggskripten** genereras från verktygsinställningarna (`buildScripts`). I källvyn kan `build.bat` och `build.sh`
redigeras, men inte de andra filerna, som kommer ur listningen. Ändringen sparas i projektet (`Project.scripts`, en
stund efter sista tangenttrycket och när man byter fil) och ångras med `Ctrl+Z`. Exporten skriver då den versionen
(`projectScripts`), och det andra skriptet förblir genererat. Är texten åter lika med den genererade tas ändringen
bort. *Restore generated* gör det direkt, och skriptet följer sedan inställningarna igen. Appens egen Build & Run
använder alltid verktygsinställningarna, inte skripten.

**NOTES.html** (`notesDocument` i core) är ett självständigt dokument utan externa resurser, med ljust och mörkt tema och utskriftsläge. Det skrivs bara när projektet har bokmärken eller egna kommentarer. Huvudet visar projektnamn, filer, källfiler och exporttid, och README nämner filen. Därefter kommer två delar:

- **Bokmärken** sorteras efter adress och har en innehållsförteckning. Varje bokmärke visar titel och anteckning, etiketten (`namn` eller `namn+n`), blocket och filen med radnummer. Under det står ett kodutdrag ur den exporterade filen: etiketten och kommentarraderna ovanför, raden markerad och upp till sex rader av blocket efter. Utdraget har radnummer, adress, bytes och samma syntaxfärger som listningen. Ett bokmärke utanför de laddade filerna står kvar, märkt *not in the exported source*.
- **Kommentarer** listar kommentarer ovanför block, kommentarrader och kommentarblock samt kommentarer i slutet av en rad, efter adress. Varje kommentar visar sin typ, plats och kodrad. En kommentar som källkoden inte har med (till exempel mitt i en `.byte`-rad) utelämnas.

**NOTES.txt** (`notesText`) innehåller samma sak som ren text: rubrik, fakta, en innehållsförteckning och sedan bokmärkena och kommentarerna. Anteckningarna är indragna under rubriken. Kodraderna står som `.asm`-filen skriver dem, med radnummer, adress och bytes framför, och `>` markerar bokmärkets rad. Inställningen *Bookmarks and comments in the export* (fliken Kick Assembler output, `Settings.notesFormat`) väljer `html` (standard), `txt` eller `none`. Den sparas i projektet som de andra utdatainställningarna, och README nämner den fil som skrivs.

Allt räknas fram ur `RenderResult.fileLines`, så radnummer och kodrader är exakt de i `.asm`-filerna (`lineHtml` ger samma text som `lineText`, vilket testas för alla inställningar). Båda formaten byggs från samma underlag (`collect` i `notes-doc.ts`).

### 11.5 Block utanför bygget

Ett block kan lämnas utanför bygget (högerklick → *Exclude block from the build*, inspektorns *Include in the build*,
kommandopaletten; `Project.excluded` håller blockens startadresser). Det står kvar i källkoden:

```
// ---- Curve table · sine_09b5 · $09b5-$0ab4 (256 bytes) · excluded from the build ----
#if INCLUDE_sine_09b5
sine_09b5:
        .byte …
#else
.label sine_09b5 = $09b5          // alla etiketter i blocket, för koden som använder dem
#endif
```

Filens huvud listar `// #define INCLUDE_sine_09b5` för varje sådant block: ta bort `//` så byggs det igen. Nästa block
får alltid en egen `.pc`. Den byggda PRG:n saknar blockets byte; ligger blocket mitt i fylls luckan med `$00` (som Kick
Assembler gör), först eller sist börjar respektive slutar filen vid närmaste byggda byte. Verifieringen (inbyggd och
KickAss.jar, `comparePrg(…, skip)`) jämför bara de byggda byten och rapporterar hur många som lämnades utanför; det inbyggda
assemblerets preprocessor klarar `#define`, `#undef`, `#if`/`#elif`/`#else`/`#endif` med `!`, `&&`, `||` och parenteser.

### 11.6 Block som binärfil

Inspektorns *Save as a binary file*, högerklick → *Save block as a binary file (.import binary)* eller kommandopaletten
sparar ett block som en egen fil (`project.binary`, blockens startadresser, sparas i projektfilen). Exporten skriver då
blockets byte till `data/<etikett>.bin` (`data/block_xxxx.bin` utan etikett), och källkoden laddar den:

```
sine_09b5:
        .import binary "data/sine_09b5.bin"   // 256 bytes · Curve table
```

Mappen heter `data/` och inte `bin/`. `bin` är utdatamappen i många C64-miljöer, och Sublime Text-paketet *Kick
Assembler (C64)* tömmer den före varje bygge (`kickass_empty_bin_folder_before_build`, på som standard). En binärfil där
raderades alltså innan KickAss hann läsa den ("Can't open file").

Det fungerar för alla blocktyper, även kod. Etiketter inne i blocket som annan kod använder definieras som
`.label namn = $xxxx`, så att `jsr sub_0866` fortfarande fungerar. Det gäller bara etiketter som källkoden i samma fil
faktiskt refererar till (andra filer definierar sina egna). En etikett som bara används inne i blocket får ingen
`.label`. Det gäller också en adress som koden når som I/O-register: ett stort block över `$d000-$dfff`, som en
minnesdump, får etiketter som `charset_d011` från analysen, men koden skriver `sta VIC_SCREEN_CTRL1`. CPU-vektorerna
`$fffa-$ffff` behåller också alltid sina namn (`sta IRQ_VECTOR`, eller `sta $fffe` med kommentaren *Hardware IRQ/BRK
vector* vid riktiga adresser), även när programmets egna byte täcker dem. En läsning av RAM under KERNAL efter `$01 = $35`
(till exempel `lda charset_eaa5`) är däremot en riktig dataläsning och behåller sin etikett. Står blocket också utanför bygget (11.5) finns
definitionerna även i `#else`-grenen. Ett binärt musikblock laddas inte med `LoadSid`, och referenser till det skrivs med
etiketter i stället för `music.init`/`music.play`. Blockrubriken visar *binary* och filens namn, och den exporterade
README:n listar filen. Fuzz-testet sparar slumpvisa block som binärfiler (även tillsammans med utelämnade block), och
den riktiga KickAss.jar bygger demon byte för byte med kod-, tabell-, teckenuppsättnings- och musikblock som binärfiler.

## 12. Round-trip-verifiering

Verifieringen är produktens kvalitetsgrind:

1. `render()` producerar alla filer i minnet.
2. **Produktion:** huvudprocessen skriver dem till en temporär mapp och kör `java -jar KickAss.jar main.asm -odir tmp -showmem`. **Prototypen:** en inbyggd assembler för exakt den Kick-delmängd som generatorn skriver (`#import`, `.pc`/`*=`, `.label`, `.var`, `.byte`, `.word`, `.text`, `.encoding`, `.fill` med uttryck, `.import binary`, `LoadSid`, `BasicUpstart2`, alla adresseringslägen, `.abs`/`.zp`, flerpass-upplösning).
3. Resultatet jämförs byte för byte med originalfilen, inklusive start- och slutadress.
4. Avvikelser visas i Build output och Problems med adress, förväntat och faktiskt värde; klick hoppar till raden.
5. Exporten markeras verifierad och statusraden visar "✓ round-trip verified". Ändras projektet blir resultatet inaktuellt.
6. F7 (och Export och Build & Run, som verifierar först) väntar tills analysen av den senaste ändringen är klar. Varje
   analysresultat bär med sig projektet det gäller, och verifieringen startar först när det är samma projekt som i
   lagret. Annars kunde F7 direkt efter en ändring verifiera läget före ändringen, och resultatet visades som inaktuellt
   ("round-trip not verified") så fort den nya analysen kom. Det märktes på en belastad dator.

**Testat i prototypen:** demoprogrammet (12 287 byte) är byte-identiskt, och 1 500 slumpgenererade program (slumpdata, slumpkod, olika laddadresser, slumpade overrides och inställningar) passerar round-trip utan avvikelser.

## 13. VICE- och toolchain-integration

### 13.1 Inställningar

| Inställning | Standard (Windows) | Användning |
|---|---|---|
| Java | `java` | Körs med `-jar` |
| KickAss.jar | `C:\C64\KickAssembler\KickAss.jar` | Kick Assembler 5.x |
| Extra Kick-argument | `-vicesymbols -showmem` | Etikettfil för VICE, minneskarta |
| VICE | `C:\C64\VICE\bin\x64sc.exe` | Cykelexakt C64-emulering |
| Extra VICE-argument | `-autostartprgmode 1` | Laddar PRG direkt i minnet |
| Utdatamapp | `out` | |
| Extern uppackare | tom: Sindri, den inbyggda uppackaren | Ett externt verktyg (unp64) som packar upp packade PRG:er i stället för den inbyggda (8.11b) |
| Den externa uppackarens argument | `{in}` | `{in}` = den packade PRG:n, `{out}` = ett namn för resultatet; exomizer: `desfx -o {out} {in}` |
| VICE quicksave snapshot | tom: `C64SC.vsf`/`C64.vsf` i VICE:s inställningsmapp (`%APPDATA%\vice`) | Filen som Alt+F11 i VICE skriver och F9 öppnar (13.7b) |
| Exomizer | den medföljande Exomizer 3.1.1 i installationen (`resources\exomizer\exomizer.exe`); i ett utvecklingsbygge den som hittas i `C:\C64` (och `win32\` i undermappar), `EXOMIZER` eller `PATH`, annars tom | Packar det byggda programmet i vyn Pack (13.8) |

### 13.2 Bygg och kör (F5)

1. Spara/exportera projektet till projektmappen (eller temporär mapp).
2. `java -jar KickAss.jar main.asm -odir out -vicesymbols -showmem`.
3. Parsa stdout/stderr. Kicks felrader (`Error: … at line N, column M in file.asm`) blir Problems-poster och Monaco-markörer på rätt rad.
4. Round-trip-jämförelse (12).
5. `x64sc -autostartprgmode 1 -moncommands out/main.vs -autostart out/main.prg` — etiketterna finns direkt i VICE-monitorn.
   Har användaren satt en programstart (8.2) laddas PRG:n utan RUN och VICE skriver `sys <start>`:
   `x64sc -autostartprgmode 1 -moncommands out/main.vs -autoload out/main.prg -keybuf "sys2150\n"` (VICE läser `\n` som RETURN).
   Det kräver PRG-läget inject eller diskavbild; läget virtuellt filsystem laddar via tangentbordsbufferten, så
   `-autostartprgmode 0` ersätts då med 1. Bara den första filen körs; ligger starten i en annan fil startas den med RUN.
   En PRG som skriver över BASIC:s och KERNAL:s arbetsminne `$0002-$03ff` (zero page, stack, buffertar, vektorer;
   till exempel en minnesdump) lämnar inget BASIC att skriva `sys` i, och RUN fungerar inte heller. Då stannar VICE
   vid READY och kör monitorkommandon i stället: `x64sc -autostartprgmode 1 -moncommands out/main.start.mon -initbreak ready`,
   där `main.start.mon` är etiketterna följda av `l "out/main.prg" 0` (laddar på PRG:ns adress genom CPU:ns vy, som
   `LOAD"…",8,1`) och `g <start>`. Utan programstart varnar appen för en sådan PRG och ber användaren sätta en.
   `test/vice.integration.test.ts` kör detta i riktiga VICE (`-console`, egen konfigurationsfil, debug-cartridgens `$d7ff` som avslutningskod).

### 13.3 VICE binary monitor (M3)

Med `-binarymonitor` (TCP 6502) kan appen: sätta brytpunkter från listningen, läsa minne och register live, synka listningsmarkören med PC vid stopp, och "hot reload" genom att skriva om ett minnesområde utan omstart. Det ger också dynamisk täckning: adresser som körs i VICE men inte hittats statiskt kan föreslås som nya startpunkter.

### 13.4 IPC-kontrakt

| Kanal | Riktning | Argument → svar |
|---|---|---|
| `project:open` | renderer → main | `{ path? }` → `Project` (dialog om sökväg saknas) |
| `project:save` | renderer → main | `{ project, path? }` → `{ path }` |
| `prg:open` | renderer → main | `{ paths?, zeroPage? }` → `OpenedPrg[]` (`LoadedFile`, för en VICE-snapshot också `vsf`, `entries`, `start` och `snapshot`, 13.7) |
| `disk:open` | renderer → main | `{ path? }` → `{ path, name, bytes }` för en `.d64` (dialog om sökväg saknas; `null` om den avbryts) |
| `export:write` | renderer → main | `{ dir, files: Record<string, string \| Uint8Array> }` → `{ written: string[] }` |
| `toolchain:build` | renderer → main | `{ dir, entries: string[] }` → `{ ok, stdout, problems: Problem[], prg?: Uint8Array }` |
| `toolchain:run` | renderer → main | `{ prgPath, labelsPath?, start?, disk? }` → `{ pid, via: 'run' \| 'sys' \| 'monitor' }` |
| `toolchain:pack` | renderer → main | `{ files: { name, prg }[], prefs: PackPrefs }` → `{ ok, output, argv, dir, name?, path?, prg?, packed, report, check, error? }`: Brokkr i en arbetstråd eller Exomizer, efter `prefs.packer` (13.8) |
| `vice:quicksave` | renderer → main | `{ zeroPage? }` → `{ found, path, saved?, files? }`: VICE:s nyaste quicksave öppnad som snapshot (13.7b) |
| `vice:quicksave-info` | renderer → main | → `{ found, path, saved? }`: finns det en quicksave och när sparades den |
| `vice:quicksaves` | renderer → main | → `{ id, name, saved, size, favourite? }[]`: quicksavesen appen sparat (de nyaste och favoriterna), den nyaste först (13.7b) |
| `vice:quicksave-open` | renderer → main | `{ id, zeroPage? }` → som `vice:quicksave`: en sparad quicksave öppnad som snapshot |
| `vice:quicksave-rename` | renderer → main | `{ id, name }` → listan: ett nytt namn på en sparad quicksave |
| `vice:quicksave-save` | renderer → main | `{ id }` → `{ path }` eller `null`: en sparad quicksave kopierad dit användaren väljer i en spara-dialog |
| `vice:quicksave-favourite` | renderer → main | `{ id, on }` → listan: en sparad quicksave gjord till favorit, eller inte längre |
| `vice:chargen` | renderer → main | → `{ found, path, bytes? }`: C64-tecken-ROM:en (4 KB) ur den VICE som står i inställningarna, för skärmar i Graphics (14.5); sökvägen kommer aldrig från renderaren |
| `vice:quicksaved` | main → renderer | `{ path, saved }`: VICE skrev en ny quicksave |
| `file:save` | renderer → main | `{ name, bytes, title? }` → `{ path }` med en spara-dialog (`null` om den avbryts) |
| `terminal:open` | renderer → main | `{ dir? }` → `{ dir }`: ett terminalfönster (13.6) |
| `vice:attach` / `vice:command` | renderer → main | monitorkommandon → svar |
| `settings:get` / `settings:set` | renderer → main | `Settings` |
| `fs:changed` | main → renderer | `{ path }` (fil-watcher) |

### 13.5 Diskavbilder (.d64)

**Mount D64…** (Explorer, kommandopaletten, eller dra och släpp en `.d64`) läser en 1541-avbild med 35, 40 eller 42 spår,
med eller utan felbyte per sektor (`packages/core/src/c64/d64.ts`). Explorer visar katalogen, i sektionen *Disk* direkt
under *Files* (där knappen står), som 1541:an listar den:
diskens namn och id, en rad per fil med block, `"NAMN"` och typ (`*PRG` för en fil som aldrig stängdes, `PRG<` för en
låst), och "blocks free" (spår 1–35 utom katalogspåret). Tomma och raderade poster visas inte.

Ett klick på en PRG öppnar den som ett nytt projekt, och **+** lägger till den i projektet. Filens byte hämtas längs
sektorkedjan (en kedja som går i cirkel eller pekar utanför disken ger ett fel i stället för att hänga), och
filnamnet blir namnet med de tecken Windows inte tillåter bytta mot `_`, plus `.prg`. SEQ-, USR-, REL- och DEL-filer
listas men öppnas inte. Disken stannar monterad tills den matas ut, även när ett nytt projekt öppnas.

Vid **Build & Run** läggs en kopia av den monterade disken i VICE:s drive 8 (`-8 <kopia>.d64`, i en ny byggmapp), så
ett program som laddar fler delar från disken hittar dem, och ett program som sparar ändrar inte originalet. Det
kräver PRG-läget inject (diskavbildsläget lägger en egen disk i drive 8), så `-autostartprgmode 1` läggs till om
inställningarna säger något annat. Ett program som läggs rakt i minnet lämnar drivenheten som vid påslag, utan att
ha läst disken; på en C64 laddades det från disken (`LOAD"*",8,1`), och snabbladdare räknar med det (Sparkle i *We
Are The Anomaly* hänger med drivens lampa blinkande). Med en disk laddas därför PRG:n utan RUN (`-autoload`) och
VICE skriver `open15,8,15,"i":close15:` (initiera: driven läser disken) före `run` eller `sys <start>`. En snapshot
har med sin drive som den var; start från monitorn (13.2, ett program över BASIC:s arbetsområde) initierar inte.
`test/d64.test.ts` läser diskar som VICE:s `c1541` skrivit och låter `c1541` läsa och validera diskar som `makeD64`
skrivit; `test/vice.integration.test.ts` kör i riktiga VICE ett program som laddar sin andra del från disken, och ett
som läser diskens id ur driven (`M-R` av `$0012`): det finns där bara efter initieringen.

### 13.5b Spindle 3-diskar (Spins laddskript)

Spin, Spindles diskbyggare, läser ett laddskript med ett stycke per laddaranrop (ett **jobb**). Varje rad i ett stycke
är en bit: filen som laddas, dess adress, offset och längd. `NN:` är en etikett att söka till. Skriptet finns inte på
disken, men jobben gör det: Spin packar varje jobb och lägger det i omgångar av sektorer som drivkoden läser i vilken
ordning som helst. `readSpindleDisk()` (`packages/core/src/c64/spindle-disk.ts`) läser omgångarna och packar upp dem
till varje jobbs bitar (`SpindleDisk`, `SpindleJob`, `SpindleChunk`). Filnamnen finns inte på disken.

Formatet är Spindle 3.0:s och 3.1:s (`disk.c`, `pack.c` och `stage1.s`, MIT-licens):
- **Spår 18** har startprogrammet (18/8, 18/18, 18/9, 18/15), drivkoden och, i 18/17 på byte 253, den första
  kedjeposten. I 18/6 ligger söktabellen med etiketterna, baklänges.
- **En kedjepost** är 3 byte: flaggor (`$80` nytt jobb, `$40` nästa spår, `$20` sidans slut) och en bit per
  sektornummer (0–4 i första byten, 5–12 och 13–20 i de andra) för sektorerna i nästa omgång. En av dem har nästa post
  på byte 253.
- **En sektors första byte** är dess nummer, med `$40` när den har nästa post och `$80` när en enda enhet fyller den.
  Utfyllnadskopior av en sektor har samma nummer. Resten är poster uppifrån och ned: postens byte, sedan dess längd.
- **En enhet** är en destination (höga byten först) och en länk som uppackaren använder, sedan delar:
  `11llllll` och l+1 byte som de är, `10llllhh oooooooo` en kopia av l+3 byte från o+1 byte högre, och `0ooooooo` en
  kopia av 2 byte från o byte högre. Byten är omkastade för den seriella bussen (`scramble_bits`).
- **Andra poster:** 2 byte är kedjehuvuden. 3 byte med `$4c` är ett hopp som laddaren gör efter jobbet (Pefchains
  sidodörr). En enhet till laddarens sida är en ändring av laddaren (shadow-RAM under I/O).

Kopiorna kommer från högre adresser, så ett jobb packas upp från sin högsta byte och nedåt. **Startprogrammet** ger
adressen det fortsätter på efter jobb 1 (`spin -e`) och laddarens sida (`-r`). Spår 18 ger sidans och nästa sidas
knackkod (`-m`, `-n`), när en trackmo har flera sidor. Disken räknas som en Spindle 3-disk när startprogrammet har
början av Spindle 3:s residenta sida och hela kedjan går att följa till slutet.

**I appen:**
- Explorer säger om en monterad disk *Spindle 3 disk: N jobs the loader reads, not files*, med knappen **Load script**.
- Bottenpanelens flik **Spindle script** finns också då. Den visar laddskriptet med en rad per bit: jobb (och dess
  etiketter), adresser, längd, ett filnamn (`job02_1000.bin`, påhittat) och anmärkningar (*then jumps to $307a*,
  *loads under I/O*).
- Ett klick på raden öppnar biten som en PRG på dess adress, och **+** lägger till den i projektet.
- **Copy script** kopierar skriptet så som Spin läser det, med flaggorna för `spin` i en kommentar.
- Har snapshoten också Pefchain-drivers (8.11f) står de under laddskriptet.

**Mätt:**
- de diskar `spin` och `pefchain` 3.1 byggde av Spindles exempel och egna testdelar: varje bit är byte för byte lik
  sin fil;
- Mojos fyra sidor (33–39 jobb var) och Memento Moris sida 1 (16 jobb): ingen kopia saknar sin källa, och de
  uppackade jobben stämmer med RAM i VICE-snapshots tagna vid laddaranropen.

En Sparkle-disk känns inte igen som en Spindle-disk. **Test:** `test/spindle-disk.test.ts`, med diskar som
`test/helpers/spindle-disk.ts` skriver på samma sätt som Spindle. `fixtures/d64/spindle-demo.d64` är en av dem.

### 13.5c Bitfire-diskar (d64writes kommandorad)

Bitfire, Bitbreakers loader, har med flit inget laddskript: varje del laddar nästa fil (`link_load_next_comp`) eller en
fil efter dess nummer. Det som liknar ett skript mest är kommandoraden till d64write, Bitfires diskbyggare. Den listar
filerna i den ordning de laddas (`-b`), startprogrammet (`--boot`), sidan (`--side`), dir-arten (`-a`) och vanliga filer
(`-s`). Bitfire lägger sina filer utanför diskens katalog, i en egen katalog på spår 18, med varje fils laddadress och
längd. `readBitfireDisk()` (`packages/core/src/c64/bitfire-disk.ts`) läser den och sektorerna i den ordning d64write
fyller dem. En fil som är packad med Bitfires packare, bitnax (0.x) eller dali (1.x), packas upp. Filnamnen finns inte
på disken.

Formatet är d64writes (BSD-licens), och katalogen har ändrats mellan versionerna:
- **0.x (till och med 0.7, 2020):** 6 byte per fil i 18/18, 18/17 och 18/16: spår, sektor, laddadress och längd − 1.
  Sidan står i byte `$ff`. Varje fil börjar i en egen sektor. Filerna är packade med bitnax.
- **1.0 och 1.1 (2022):** 4 byte per fil (laddadress, längd − 1) i 18/18 och 18/17. Sist kommer den första filens spår,
  vilken i ordningen dess sektor är på spåret, dess första byte och sidan (`$fc`–`$ff`).
- **Efter 1.1:** samma, men de 4 byten står först och laddadressens höga byte är − 1.
- **1.2 och senare:** de 4 byten först, sedan en kolumn med 63 låga byte, en med höga byte − 1 och två med längd − 1.

Från 1.0 följer filerna på varandra utan glapp från spår 1 sektor 0, och hela sektorn är deras. d64write fyller var
fjärde sektor på ett spår (från 1.2 var tredje från spår 18), sedan igen från sektor 1, 2 och 3. Sidan är `$f0` + sida
− 1. Startpositionen som en katalogsektor anger för sin första fil måste stämma med var filerna hamnar. Annars är det
inte det formatet.

**dali** skriver vart filen packas upp (2 byte) och sedan en zx0-ström:
- Först en literal: en Elias-gamma-längd, sedan byten. Efter en literal kommer en kopia med förra offseten (0) eller en
  ny (1). Efter en kopia kommer en literal (0) eller en ny kopia (1).
- Talen är sammanflätad Elias-gamma: en 0 före varje bit, en 1 sist. Från 256 kommer de 8 låga bitarna först. Bitarna
  läses uppifrån i en byte, som hämtas när den behövs.
- En ny offset är ett tal (dess höga del + 1) och en byte: de 7 låga bitarna, sedan 1 för längd 2. Annars följer
  längden − 1 utan sin första 0. Talet 256 avslutar strömmen.
- En fil packad på plats har inget slut. Den slutar där skrivningen når läsningen, och resten är byten som de är.

**bitnax** (`unpackBitnax()`) läses som `lz.c` och `resident.asm` i Bitfire 0.7 (BSD-licens, bara lästa). Strömmen är
densamma i hela GitHub-historiken, från första incheckningen 2016 till 0.7:
- Först kommer vart filen packas upp och var uppackningen slutar (2 byte vardera; med `--overlap` bara den första).
  Bitarna läses uppifrån i en byte, som hämtas när den behövs, mellan de andra byten.
- En typbit kommer före varje literal (1) och kopia (0), men inte före kopian efter en literal kortare än 256.
- En literals längd är en 1 och biten för varje bit efter den första, sedan en 0 (256 blir 0). Sedan kommer byten.
- En kopias längd är 0 för 2. Annars kommer en 1 och sedan varje bit av längd − 1 efter den första, följd av 0, den
  sista av 1. Längden 257 avslutar strömmen.
- 2 bitar till ger ett prefix på 3 bitar, och det anger offsetens bitar: 8, 3, 6 eller 10 efter en kopia på 2, annars
  4, 7, 10 eller 13. Sedan kommer offset − 1. Under 8 bitar är bitarna inverterade, annars kommer de höga bitarna och
  sedan den låga byten inverterad.
- En fil packad på plats (standard) slutar vid slutadressen, och resten är byten som de är. En fil som packas upp någon
  annanstans (`--load-addr`) slutar också där, och efter den kommer slutet.
- Bitfires första demos (2014–2015, som Comaland, Comaland 100 % och Fantasmolytic) har ingen slutadress, alltid
  slutet och offseten i en annan ordning: 3, 6, 8 och 10 efter en kopia på 2. En disk har en depacker, så den ordning
  som packar upp flest filer gäller för hela disken (`oldBitnax`).
- En kopia från minnet före filens början (packad med en ordbok, `--full-dict`) går inte att packa upp, eftersom det
  minnet är okänt. Den filen lämnas packad.

En disk räknas som en Bitfire-disk när katalogen på spår 18 har sidbyten och första filen på spår 1, sektor 0, byte 0.
För 1.x måste katalogsektorernas startpositioner stämma, och för 0.x måste varje fil börja efter den förra. En katalog
först (efter 1.1 och 1.2, som packar med dali) räknas bara när minst en fil packas upp. Startprogrammet är den post i
den vanliga katalogen som pekar på spår 18. En dir-art är rader som pekar dit eller är DEL med 0 block.

**I appen:**
- Explorer säger om en monterad disk *Bitfire disk: N files the loader reads, not in the directory*, med knappen
  **Bitfire script**.
- Bottenpanelens flik **Bitfire script** finns då. Den har en rad per fil: nummer, var den laddas, vart den packas upp,
  storlek (packad → uppackad), ett filnamn (`file02_3800.lz`, påhittat: numret och uppackningsadressen) och
  anmärkningar (*packed with dali, in place*, *packed with bitnax*, *not packed*, var den börjar på disken). En disk
  packad som de första demona säger *packed as in 2014–2015* i rubriken.
- Ett klick på raden öppnar filen som en PRG: uppackad där den packas upp, annars som den laddas. **+** lägger till den.
- **Copy script** kopierar d64writes kommandorad, med en kommentar per fil ovanför.

**Mätt:** alla 276 419 diskar i referensarkivet lästes på 8 minuter. 1 476 är Bitfire-diskar: 916 av 0.x, 200 av 1.0
och 1.1, 35 efter 1.1 och 325 av 1.2 och senare. Bland dem finns The Lab, 1337, Next Level, Comaland, Eyes och
Wonderland XIV. På 1.x-diskarna packas nästan alla filer upp, till exempel alla 47 på The Lab sida 1 och alla 73 på 1337
sida 1. Filerna som inte packas upp laddas som de är, som Next Rounds teckentabeller. Ingen Spindle- eller Sparkle-disk
tas för en Bitfire-disk.

**Mätt, bitnax:** på de 916 0.x-diskarna (159 olika, räknat efter innehåll) packas 23 466 av 24 836 filer upp (4 483 av
4 834 på de olika), 20 208 av dem på plats. 653 diskar (102 olika) packas upp helt. 92 diskar (15 olika) är packade som
de första demona, och där packas 2 323 filer upp. Alla 1 476 Bitfire-diskar läses och packas upp på 9 sekunder. Några
av diskarna:
- Comaland sida 1–4: 20 av 22, 21 av 22, 17 av 17 och 42 av 42. På sida 1 är de två som inte packas upp data och en
  tabell som inte är packade. På sida 2 är det 18 KB tät data på `$6c00` som inte går att läsa som bitnax.
- The Ghost sida A och B: 17 av 17 och 45 av 45.
- Eyes sida A och B: 38 av 38 och 29 av 29.
- 2600: 38 av 39. Den sista är musikrutinen på `$e600`, som inte är packad.

Av filerna som inte packas upp är 12 olika packade med ordbok. Resten ser ut som filer som inte är packade: samplingar,
tabeller, musik och BASIC-program.

**Test:** `test/bitfire-disk.test.ts`, med diskar, dali-filer och bitnax-filer som `test/helpers/bitfire-disk.ts`
skriver som d64write, dali och bitnax gör (egna enkla packare, ingen kod från Bitfire). bitnax-testerna täcker literaler
(också 256 med en typbit efter), kopior med alla 8 offsetbredder, filer packade på plats, för någon annanstans, med
`--overlap` och som de första demona, och filer som inte är bitnax. `fixtures/d64/bitfire-demo.d64` är en av diskarna:
demot packat med slut, en tabell som inte är packad och en fil packad på plats.

### 13.6 Terminal

**Terminal** i titelraden (och kommandopaletten) öppnar ett terminalfönster i mappen du arbetar i: den senast
exporterade Kick Assembler-mappen, annars projektfilens mapp, annars mappen där en dialog senast valde något (PRG,
disk, projekt), annars hemmappen. På Windows är det PowerShell, startat med `cmd /d /c start "Mimir Studio" /D
<mapp> powershell.exe -NoLogo -NoExit -Command …`: `start` ger PowerShell en egen konsol (Windows 11 visar den i
standardterminalen), medan ett program som appen startar direkt får appens tomma standardhandtag och avslutas.
VICE:s mapp ligger först i `PATH` (så `x64sc fil.prg` fungerar), och `kickass fil.asm` kör `KickAss.jar` med den
Java som är inställd (`KICKASS_JAR`, `MIMIR_JAVA`). macOS öppnar Terminal.app i mappen, Linux `x-terminal-emulator`.
`test/terminal.test.ts` kör samma PowerShell-skript utan `-NoExit` och kontrollerar mappen, `x64sc` och att
`kickass` bygger en `.prg`.

### 13.7 VICE-snapshots (.vsf)

En VICE-snapshot öppnas som en PRG: med *Open PRG…* (dialogen visar `.prg` och `.vsf`), genom att släppa den i
fönstret eller med Shift för att lägga till den i projektet. `openC64File` i core känner igen den på huvudet
`VICE Snapshot File`, oavsett filnamn, och läser den med `parseVsf` (`packages/core/src/c64/vsf.ts`):
- **Huvud:** format, maskin (`C64` eller `C64SC`; andra maskiner avvisas) och, från VICE 3, VICE-versionen.
- **Moduler:** namn, version och storlek, där storleken räknar in modulens 22 byte långa huvud.
- **C64MEM:** CPU-portens data och riktning, sedan alla 64 KB RAM, även RAM under ROM och I/O.
- **MAINCPU:** cykelräknaren (8 byte från format 2, annars 4), sedan A, X, Y, SP, PC och status.
- En snapshot som saknar C64MEM eller har en modul som går förbi filens slut avvisas med orsaken.

**Som fil** blir RAM från `$0200` (`SNAPSHOT_LOAD`) till `$ffff` filen `<namn>.prg`. Nollsidan och stacken är
maskinens tillstånd och tas som standard inte med, så nollsidevariablerna får sina namn som vanligt.

Inställningen *VICE snapshots: include the zero page and the stack* (fliken Analysis, `Settings.snapshotZeroPage`) öppnar
RAM från `$0002` (`SNAPSHOT_ZP_LOAD`; `$00`/`$01` är CPU-porten), för kod som ligger där. En PC eller avbrottsrutin i
nollsidan eller stacken spåras då. Nollsidevariablerna blir etiketter på laddade bytes, och round-trip gäller lika väl.
Inställningen följer projektet och gäller nästa snapshot som öppnas: `prg:open` får `zeroPage`, och dra-och-släpp
läser den direkt. Ingångspunkter:
- **PC**, när den ligger i RAM (med `$01` från snapshoten).
- **Avbrottsrutinerna** som vektorerna pekar på i RAM: `$0314`/`$0318` med KERNAL inkopplad, annars `$fffe`/`$fffa`.

Ligger BASIC-raden på `$0801` med en SYS in i RAM, blir SYS-adressen programstart (8.2) som analysen spårar från.
Analysen hittar BASIC-raden också i en fil som börjar före `$0801`, men bara när dess SYS går in i samma fil. Toasten
säger vad snapshoten är, varifrån analysen spårar och programstarten.

**Build & Run startar om snapshoten som den var.** Snapshoten sparas med filen (`LoadedFile.vsf`, i projektfilen som
base64 under `files[].vsf`). Build & Run bygger och verifierar som vanligt. Sedan lägger det de byggda PRG-filerna i
snapshotens RAM (`patchSnapshot`: C64MEM-modulens 64 KB, i projektets ordning, ingenting efter `$ffff`) och skriver
`<namn>.vsf` i en byggmapp. VICE startas med `-autostart <namn>.vsf` (och etiketterna med `-moncommands`). VICE läser in
snapshoten och återställer allt som det var när den togs: CPU:ns register och stack, `$00/$01`, VIC (med färg-RAM), SID,
CIA-timrarna och avbrotten, nollsidan och diskenheterna. Sedan fortsätter programmet från snapshotens PC.

- Programstarten används inte för körningen, bara av analysen. Explorer säger det (*VICE restarts the snapshot as it was
  taken (PC $08c7, $01 = $37)*), och Build & Run-knappens tips likaså.
- Toasten och byggloggen säger var snapshoten fortsätter.
- Är programmet oförändrat (det byggda är byte-identiskt) får VICE exakt den snapshot som öppnades.
- Det gäller bara projekt med en snapshot. Andra program körs som förut (RUN, `sys` eller monitorn, 13.2).
- En fil som ser ut som en snapshot som öppnades innan snapshots sparades (från `$0200` eller `$0002` till `$ffff`, utan
  `vsf`) körs som förut, med en varning om att öppna `.vsf`-filen igen.
- Förut laddades RAM-et från monitorn och programmet startades vid programstarten. Det kraschade, eftersom CPU:n, `$01`
  och I/O-kretsarna inte återställdes och byten för `$d000–$dfff` hamnade i I/O-registren.

**Test:** `fixtures/vsf/raster-demo.vsf` är en snapshot från x64sc 3.10 av demon, stoppad i dess raster-IRQ
(`make-raster-demo.mon` beskriver hur den gjordes). `test/vsf.test.ts` läser den, och projektet från `$0200`
verifieras byte för byte (också med riktiga KickAss.jar). Testet täcker även äldre format, KERNAL urkopplad, andra
maskiner och trasiga filer. E2e-testet öppnar snapshoten via dialogen och verifierar med `F7`.
`patchSnapshot` testas så: det byggda programmet ger samma snapshot, och ändrade byte hamnar bara i C64MEM:s RAM.
`vice.integration.test.ts` startar riktiga x64sc med snapshoten, där programmet vid PC `$08c7` har bytts mot kod som
gör ramen och bakgrunden röda. VICE:s skärmbild visar att det fortsätter där. Ett e2e-test kör Build & Run med ett
program som ersätter VICE och kontrollerar att snapshoten VICE får är den som öppnades.

### 13.7b VICE:s quicksave-snapshot

I VICE 3.x sparar Snapshot → Quicksave snapshot (**Alt+F11**) maskinens tillstånd i `<maskin>.vsf` i VICE:s
inställningsmapp: `%APPDATA%\vice\C64SC.vsf` för x64sc (`C64.vsf` för x64), `$XDG_CONFIG_HOME/vice` eller
`~/.config/vice` på andra system. Inställningen *VICE quicksave snapshot* (13.1) pekar ut en annan fil. Tom betyder de två
filerna i VICE:s mapp, och den nyaste av dem gäller (`electron/main/quicksave.ts`).

- **Explorer** har en egen sektion, *VICE quicksave*. Den förklarar att Alt+F11 i VICE tar över den körande C64:an, och
  statusraden visar när den senaste sparades (`vice:quicksave-info`, utan att läsa filen) eller att det inte finns någon
  ännu. Där finns också knappen *Open the latest quicksave* (F9) och kryssrutan *Open new quicksaves automatically*.
- **Varje ny quicksave öppnas av sig själv.** Main-processen bevakar filerna genom att polla (`fs.watchFile`, 750 ms), så det
  fungerar även när mappen inte finns ännu. En ny ändringstid, när filen varit stilla en kvarts sekund, skickas som
  `vice:quicksaved` till fönstret. Där öppnas snapshoten när *Open each new one* (Explorer, `followQuicksave`, på som
  standard) är ikryssad, och statusraden uppdateras. Annars säger en toast att F9 öppnar den. En quicksave som finns när appen startar öppnas inte.
- **F9** (Explorer: *VICE quicksave*, kommandopaletten) öppnar den nyaste via `vice:quicksave`. Main läser filen från
  inställningen, aldrig från en sökväg som renderern skickar. Finns ingen säger toasten var VICE skriver den.
- **Öppningen är som Open PRG… på en .vsf (13.7):** RAM från `$0200` (eller `$0002`), ingångspunkterna och programstarten.
  Filen heter `quicksave.prg` och toasten säger när den sparades. Ett snapshot som VICE fortfarande skriver läses igen
  strax efter.
- **Ångringsbar:** det nya projektet är ett steg i historiken (`commitReplace`), så Ctrl+Z tar tillbaka projektet som var
  öppet innan och Ctrl+Y quicksaven igen. Andra filer man öppnar börjar fortfarande med en ny historik.
- **De 5 nyaste sparas** (`QuicksaveHistory`), eftersom VICE skriver varje quicksave över den förra.
  - **Var:** varje ny kopieras till appens egen mapp, `<userData>/quicksaves/<id>.vsf`, med `index.json` för namn,
    tid och storlek. Kopian görs innan fönstret får `vice:quicksaved`. Den quicksave som finns när appen startar
    kommer också med, liksom den i en fil som just valts i inställningarna.
  - **Vad som tas med:** samma sparning (samma ändringstid) tas bara med en gång. En fil som ännu inte är en hel
    snapshot läses igen strax efter och hoppas annars över.
  - **Den sjätte:** när en sjätte kommer tas den äldsta bort, med sin fil. Favoriterna räknas inte.
  - **Favoriter:** stjärnan på en rad gör den till favorit (`favourite` i `index.json`). En favorit tas aldrig bort när
    VICE sparar nya, och de 5 nyaste räknas bland de andra. Tar man bort stjärnan blir den en av de andra igen. Den finns
    kvar tills VICE sparar nästa quicksave, och tas då bort om den inte är bland de 5 nyaste. Toasten säger det.
  - **Namn:** en quicksave heter först `quicksave 2026-10-29 12:43:30`, alltså när VICE sparade den.
  - **I Explorer** listar *VICE quicksave* dem under knappen, den nyaste först, med namn och tid. Favoriterna står i en
    egen lista, *Favourites, always kept*, över de nyaste:
    - ett klick på namnet öppnar den som ett nytt projekt, som F9 (Ctrl+Z går tillbaka). Filen heter som namnet;
    - stjärnan gör den till favorit, eller tar bort den ur favoriterna (fylld och guld för en favorit);
    - pennan byter namnet (Enter behåller det nya, Esc inte);
    - pilen sparar en kopia i en mapp man väljer i en spara-dialog, som `<namn>.vsf`. Tecken som Windows inte tillåter
      i filnamn blir `-`, och dialogen öppnas i den mapp en quicksave sparades i senast.
  - Listan finns kvar när appen startas om.

**Test:** `apps/desktop/test/main.test.ts` täcker mapparna per system, den nyaste filen, en fil som saknas och en som inte
är en snapshot, bevakaren (en rapport per ny fil) och de sparade: fem kvar med den äldstas fil borttagen, samma sparning
en gång, namn som finns kvar efter omstart, en halvskriven fil som inte tas med, och id som inte går att använda som
sökväg. Favoriterna testas för sig: en favorit finns kvar efter sju nyare och efter omstart. Utan stjärna finns den kvar
tills nästa sparning och tas då bort, och en nyare utan stjärna stannar bland de 5. E2e-testet pekar inställningen på en fil i testets egen mapp (testmiljöns `settings.json` gör det redan, så
användarens VICE-mapp läses aldrig) och kopierar dit `fixtures/vsf/raster-demo.vsf` från x64sc 3.10. Den öppnas av sig
själv, Ctrl+Z och Ctrl+Y växlar projekt, och med *Open each new one* urkryssad meddelas en ny quicksave och F9 öppnar den.
Båda finns sedan i listan. Den nyaste döps till *intro* och sparas som `intro.vsf` med samma bytes, och den äldre öppnas
med ett klick. Stjärnan flyttar *intro* till favoritlistan, över de nyaste, där den öppnas. Tas stjärnan bort kommer den
tillbaka bland de nyaste.

### 13.8 Packa med Brokkr eller Exomizer

Vyn **Pack** i aktivitetsraden (ikonen med en låda, kommandopaletten *Show the Pack view*) packar PRG:n som Build & Run
bygger. Överst väljs packaren: **Brokkr**, Mimirs egen packare (`packages/brokkr`, standard), eller **Exomizer** 3
(verktygsinställningen, 13.1). Vyn ligger i sidopanelen, så listningen bredvid visar blocken som väljs. Inställningarna
sparas i projektet (`Project.pack`, `PackPrefs`), och varje ändring kan ångras. En projektfil från före Brokkr har ingen
packare; den packar med Brokkr (`packer`, `effort` och `format` får sina standardvärden i zod-schemat).

**Brokkr** skriver Exomizer 3:s strömformat (protokoll 39, som Exomizers egna uppackare läser) med egen kod: matchsökning
med ett binärträd, en optimal parsning som håller flera vägar till varje position (en per tillstånd och offset som kan
återanvändas), tabellerna optimerade mot parsningen tills strömmen slutar krympa, och en egen 6502-uppackare. På 163
uppackade demos, spel och intron blir strömmarna mindre än Exomizer 3.1.1:s på normal nivå, och packningen går flera
gånger fortare (siffrorna i Brokkrs README). Nivåer (`PackPrefs.effort`): *Fast*, *Normal* och *Max*, som söker vidare
från flera starter och prövar varje tabellfack en bit bredare och smalare, på alla kärnor utom en.

**Format** (`PackPrefs.format`, bara för Brokkr): *Exomizer 3* (standard), *Brokkr's own*, Brokkrs eget format för
största möjliga packning, eller *Brokkr fast*, dess snabba format för snabbast möjliga uppackning (nedan). Det kodar samma slags LZ-tokens med en binär aritmetisk kodare vars sannolikheter anpassar
sig efter varje bit, som LZMA: bokstäver i ett 8-bitars träd, längder med en sammanflätad gammakod, offset med längd i
bitar (i sammanhang av matchens längd) och därefter bitarna, och "samma offset igen" efter en literal. Parsningen
prissätter tokens efter vad kodaren tar block för block. På de 163 programmen blir strömmarna 6,6 % mindre än Exomizer
3.1.1:s (mindre på 152), men uppackningen tar i median 8 gånger så lång tid (upp till 24 för data som knappt packas;
varje bit kostar en multiplikation), och uppackaren behöver mer minne:
512 byte sannolikheter, 1 KB kvadrattabeller när det finns plats (en tredjedel snabbare; annars multiplicerar den
med skift och addition) och en resident del på omkring 425 byte i stället för 200. För små program är Exomizers format
därför mindre som självuppackande fil (på 159 program blev filerna 3,5 % mindre sammanlagt, mindre på 98); där
programmet inte lämnar plats blir filen i Exomizers format, med en notis.
`--format brokkr` står då i kommandot, *Crunched data* packas bara bakåt (*Forward* och *Compatibility* döljs), och
uppackaren för egen kod skrivs med `brokkr decruncher --format brokkr`.

*Brokkr fast* består bara av hela byte, så uppackaren läser inga bitar: en literalkörning på upp till 32 byte, en match
på 2–3 byte upp till 16 bakåt i en byte, en på 2–8 byte upp till 4096 bakåt i två, vilken match som helst i tre, och
"samma offset igen" i en; ett fullt längdfält tar en byte till, upp till 255. Uppackaren håller skrivpositionen i Y och
kopierar varje byte med `dey`, `lda`, `sta`, `dex` och `bne`; den är 215 byte (229 med RUN), utan tabeller, och ryms
i stackens sida. På de 163 programmen blir strömmarna 13,2 % större än Exomizer 3.1.1:s; som självuppackande filer (159
program) 12,5 % större än i Exomizers format, men uppackningen tar 0,56 av tiden sammanlagt (hälften på
medianprogrammet, 0,4 som bäst). Den blinkar inte med kanten (effekten döljs). `--format fast` står i kommandot, och
uppackaren för egen kod skrivs med `brokkr decruncher --format fast`. Ett första försök med bitar i ZX0:s stil blev bara
1,27 gånger så snabbt och lämnades.

- *Self-extracting*: Brokkr planerar var uppackarens två delar, dess tabell, nollsidebytes och den packade datan ska ligga
  (helst stackens sida `$0100-$01e7` och `$0334-$03ff`, så att inget syns på skärmen), så att uppackaren aldrig skriver över
  byte den inte läst, och väljer `$01` medan den packar upp så att allt den läser och skriver är RAM (`$34` när data
  ligger under I/O; då blinkar inte kanten). Filen körs sedan i Brokkrs emulerade C64 från SYS-raden tills programmet
  startar, och minnet jämförs med det som packades. Kontrollen syns som *Decrunched in Brokkr's emulated C64: … has the
  same … bytes, and it starts at $….*
- *Crunched data*: Exomizers mem-format (`-T4` som standard, för `exodecrunch.s`). Strömmen packas upp igen och jämförs,
  och kortet säger var den laddas för uppackning på plats. Brokkrs egen uppackare som Kick Assembler-källa skrivs med
  `brokkr decruncher`.
- Effekt: kantblink eller ingen. `$01` och avbrott efter uppackningen som för Exomizer. *Compatibility* blir `-T1` (inga
  literal sequences).

Huvudprocessen kör Brokkr i en arbetstråd (`electron/main/brokkr-worker.ts`, en egen ingång i electron-vite som blir
`out/main/brokkr-worker.js`), så att fönstret svarar medan den packar; på nivån *Max* startar tråden fler trådar som kör
samma fil (`workerData.brokkr`). Resultatet har samma form som en Exomizer-körning (`ExomizerReport`: minneslayout,
`$01` och avbrott före, under och efter, kontrollen), så kortet visar båda på samma sätt. Pack-mappen får indatafilerna
och den packade filen. Kommandot vyn visar är den fristående Brokkrs (`brokkr sfx --start sys -o x-brokkr.prg x.prg`,
`brokkrArgs`), som gör samma fil i pack-mappen; standardnamnet är `<fil>-brokkr.prg`.

**Exomizer** packar som förut:

**Vad som packas:**
- *Whole build*: de byggda PRG:erna hela. Flera filer packas ihop till en.
- *Chosen blocks*: adressintervall (`PackPrefs.ranges`, sorterade, utan överlapp). Vyn listar blocken med en kryssruta
  var: ikryssad när blocket är helt med, halvt när en del är med. *Selection* lägger till markeringen i listningen och
  *Block at the cursor* blocket där markören står. I listningens högerklicksmeny finns *Pack block/selection with
  Exomizer* och *Leave block/selection out of the pack*. Intervallen visas som chips med ett × som tar bort dem.

**Den packade filen:**
- *Self-extracting* (`exomizer sfx`): ett program som packar upp sig själv och startar. Det startar genom SYS-raden i
  BASIC-raden (`sys`), med RUN (`basic`) eller med ett hopp till en adress (`$xxxx`, förvalt programstarten). Vyn varnar
  när de valda blocken lämnar ut BASIC-raden och starten är `sys`. Övriga val:
  - Effekt: Exomizers egen, ingen (`-n`) eller kantblink (`-x1`–`-x3`).
  - `$01` efter uppackningen: `-Di_ram_exit`.
  - Avbrott efter uppackningen: `-Di_irq_exit`.
- *Crunched data* (`exomizer mem`): packad data som programmets egen kod packar upp med Exomizers `exodecrunch.s`.
  Laddadressen är för uppackning på plats (standard), en vald adress (`-l $xxxx`) eller ingen (`-l none`, en `.bin`).
  `-f` packar framlänges.
- För båda: `-c` (inga literal sequences), `-C` (snabbare packning), fler flaggor som text och filnamnet
  (standard `<fil>-exo.prg`).

Vyn visar exakt det kommando som körs (`packCommand` i `src/lib/pack.ts`, `packArgs` i `packages/core/src/pack.ts`).
En del av en PRG anges som Exomizer läser den, `fil.prg,$adress,offset,längd`. Offset räknas efter laddadressen.
Exomizer laddar delarna i tur och ordning (en senare vinner) och nollfyller luckor mellan dem.

**Pack** bygger och verifierar först som Build & Run (12; KickAss.jar när den finns, annars den inbyggda assemblern) och
skickar sedan de byggda PRG:erna till `toolchain:pack`. Main-processen skriver dem i en egen packmapp, kör Exomizer med en
argumentlista (aldrig genom ett skal), läser filen den skrev och tillåter mappen för sessionen. De fria flaggorna får
inte innehålla sökvägar, `-o` eller `--` (`extraProblem`, även i zod-schemat), eftersom filerna kommer från det som
valts. Resultatkortet visar:
- storlek före och efter, med procent;
- Exomizers minneslayout (packad data, uppackad data, uppackningstabell, packaren och dess nollsidebytes);
- `$01` och avbrott efter uppackningen;
- *Out of date* när programmet eller inställningarna ändrats sedan.

Knapparna är *Run in VICE* (med byggets etiketter och den monterade disken), *Save as…* (`file:save`, en
spara-dialog) och *Output*. Byggutdata visar båda kommandona och deras utskrift.

**Kontroll.** En sfx-fil packas upp med Exomizers `desfx`, som kör uppackaren i Exomizers egen 6502-emulator och
skriver det största området den skrev. `checkDecrunched` jämför det med minnet som packades och startadressen med den
Exomizer rapporterade. Resultatet är *same*, *differs* (första avvikande byte) eller *unchecked*. Det sista gäller när
desfx behåller ett annat område, vilket för så få bytes att packarens egen kopia vid `$00fd` är större. En mem-fil
kontrolleras inte, eftersom den packas upp av programmets egen kod.

**Exomizer** är en verktygsinställning (13.1). Installationen har med Exomizer 3.1.1 oförändrad i
`resources\exomizer\` med dess licenstext (`apps/desktop/vendor/exomizer`; licensen tillåter fri spridning för icke
kommersiellt bruk). I ett utvecklingsbygge används den som hittas i `C:\C64` (också `win32\` i en uppackad release),
`EXOMIZER` eller `PATH`. En inställning som pekar på en fil som inte längre finns ersätts med den medföljande, och en
tom inställning behålls.

**Test:**
- `packages/core/test/pack.test.ts`:
  - intervallen, kommandoraden, Exomizers utskrift och jämförelsen;
  - riktiga Exomizer på demon (hela, intervall med hopp, mem, fel), där desfx ska ge samma bytes;
  - riktiga VICE (`-console`, egen konfigurationsfil): det packade programmet räknar en xor över sina 4 KB data
    efter uppackningen och avslutar VICE med den genom debug-cartridgen. Det körs via SYS-raden och med valda block
    plus hopp, `$01 = $35` och avbrott av.
- `apps/desktop/test/main.test.ts`: inställningen, schemat och en packning med den medföljande Exomizer.
- E2e-testet packar demon hel och med valda block (meny, markering och kryssrutor), sparar filen och ångrar.

**Test av Brokkr:**
- `packages/brokkr/test`: strömmen för alla protokoll, Exomizers `raw -d` packar upp Brokkrs strömmar och Exomizers
  `desfx` en Brokkr-sfx, Kick Assembler assemblerar uppackarens källa till samma byte som Brokkrs assembler, mem-filer
  packas upp av Brokkrs uppackare i den emulerade C64:an, VICE:s c1541 läser D64:or Brokkr skrivit, och trådpoolen ger
  samma resultat som en tråd.
- `packages/brokkr/test/fast.test.ts`: det snabba formatet packar upp till samma data (alla tokens, längder över 255,
  offset upp till 65535), dess 6502-uppackare packar upp mem-filer på färre än tre fjärdedelar av cyklerna Exomizers
  format tar, och självuppackande filer (SYS och RUN) har uppackaren i stackens sida och går fortare.
- `packages/brokkr/test/brk.test.ts`: Brokkrs eget format packar upp till samma data (alla längder och offset), mem-filer
  packas upp av dess 6502-uppackare (båda multiplikationerna) i den emulerade C64:an, självuppackande filer startar
  programmet och faller tillbaka till Exomizers format utan plats; Kick Assembler assemblerar dess källa till samma byte.
- `packages/core/test/brokkr.test.ts`: demon hel och med intervall och hopp, mem, felen, nivån *Max* på två trådar,
  Brokkrs eget format (mindre fil, samma fil som kommandot), det snabba formatet (uppackaren i stackens sida, samma fil
  som kommandot), och att kommandot som visas gör samma fil med den fristående Brokkr.
- `apps/desktop/test/main.test.ts`: pack-mappen med indata och den packade filen, och schemat (en gammal projektfil
  packar med Brokkr, i Exomizers format).
- E2e-testet packar demon med Brokkr (hel, *Max*, mem, eget format, snabbt format) i den byggda appen, alltså med
  arbetstråden.

## 14. UI/UX-specifikation

### 14.1 Layout (ett fönster)

| Region | Innehåll |
|---|---|
| Titelrad | Öppna, Spara, Ångra/Gör om, kommandosök, Verify, Export, Terminal (13.6), **Build & Run**, tema, inställningar |
| Aktivitetsrad | Explorer, Blocks, Symbols, Bookmarks (med antal), Pack (med antal intervall), specifikation, kommandopalett |
| Sidopanel | **Explorer**: filer, monterad disk (13.5) direkt under dem, VICE-quicksave, patchar (10.2, när det finns några), loaders, programstart och minneskarta (64 KB-remsa och segmentlista), var och en ett kort vars rubrik fäller ihop det (valet sparas per användare, `sideClosed`) med vad det rymmer bredvid rubriken (*1 file*, *none found*, quicksavens tid, startadressen, antal block). *Demo* och *+* (lägg till en PRG) står i Files rubrik; hjälptexterna är en rad, resten står i knapparnas tips. Pack-vyns sektioner är likadana kort. **Blocks**: filtrerbar lista. **Symbols**: etiketter (med antal referenser) och använda hårdvaruregister. **Bookmarks**: anteckningarna efter adress (10). **Pack**: packning med Exomizer (13.8) |
| Editor | Flikar: **Listing** (interaktiv, virtualiserad; vänsterkolumnen visar adress eller radnummer), **Graphics** (allt minne som tecken, sprites eller bitmappar, 14.5), **Memory** (minnet som VICE-monitorns `m`, `i` och `ii`, 14.6), **main.asm** (Monaco), **SPEC.md** |
| Inspektor | **Memory map** (256 × 256 heatmap, lägen Type/Bytes/Refs, zoom till laddade sidor), **Block** (intervall, evidens, konfidens, typ, etikett, kommentar), **Preview** (sprite/chars/bitmap, multicolor, text, musik- och rutininfo) |
| Bottenpanel | Analysis log, Problems (med kryssrutan *Deep analysis*, 8.11e), Cross-references, Raster IRQs (8.11d), Spindle script (Pefchain-drivers, 8.11f, och en Spindle 3-disks laddskript, 13.5b, när de finns), Bitfire script (en Bitfire-disks filer och d64writes kommandorad, 13.5c, när en sådan disk är monterad), Statistics, Build output |
| Statusrad | CPU, filer, markörens adress/etikett/blocktyp, markering, analystid, verifieringsstatus |

Paneler storleksändras med drag och mins per användare. Under 900 px bredd blir sidopanel och inspektor utdragbara lådor.

Editorns flikrad anpassar sig efter editorns egen bredd (CSS container queries på `.main`), inte fönstrets, eftersom
sidopanelen och inspektorn tar sin del:
- **Under 1060 px:** listningens verktyg (bakåt, framåt, *Go to*, *Data as code*, *Cycles*, vänsterkolumnen *Adr*/*Line*)
  visar bara sina ikoner. Namnen finns kvar för skärmläsare och i verktygstipsen.
- **Under 860 px:** flikarna blir smalare.
- **Under 760 px:** verktygen flyttar in i menyn **⋯** (*Listing tools*). Där är *Data as code*, *Cycles* och
  vänsterkolumnens val bockade när de är på, och samma knapp stänger menyn.
- **Under 520 px:** de andra flikarna än den valda visar bara sin ikon, med namnet som verktygstips.

Källflikens filnamn kortas med "…" (högst 12 em, 8 em på smal rad). Verktygen syns därmed också i smala fönster, där
de tidigare var dolda.

### 14.2 Visuellt språk

Mörkt, grafitgrått tema med en accent hämtad från C64:ans ljusblå (`#8b80f9` i mörkt läge). Blocktyper har fasta färger i alla vyer (gutter i listningen, heatmap, chips, legender): kod blå, grafik orange, musik turkos, tabeller gul, text magenta, BASIC violett, data och fyllnad neutrala. Typsnitt: IBM Plex Sans för gränssnittet, JetBrains Mono för kod, Silkscreen för logotypen.

```js
// tailwind.config.js — tokens från styles/tokens.css
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: { extend: {
    colors: {
      bg: 'var(--bg)', panel: 'var(--panel)', editor: 'var(--editor)', line: 'var(--line)',
      fg: { DEFAULT: 'var(--fg)', 2: 'var(--fg-2)', 3: 'var(--fg-3)' }, accent: 'var(--accent)',
      kind: { code: 'var(--g-code)', gfx: 'var(--g-gfx)', music: 'var(--g-music)', table: 'var(--g-table)',
              text: 'var(--g-text)', basic: 'var(--g-basic)', data: 'var(--g-data)', fill: 'var(--g-fill)' },
    },
    fontFamily: { ui: ['IBM Plex Sans', 'system-ui'], code: ['JetBrains Mono', 'monospace'] },
  } },
};
```

### 14.3 Monaco-integration

- Språket `kickass` (Monarch): kommentarer, `#import`, direktiv (`.pc`, `.byte`, `.word`, `.text`, `.fill`, `.label`, `.var`, `.encoding`, `.macro` …), makron (`BasicUpstart2`, `LoadSid`), etikettdefinitioner, dokumenterade och odokumenterade mnemonics (olika färger), hårdvarusymboler, tal (`$`, `%`, decimal), strängar, `#<`/`#>`.
- **Hover:** hårdvaruregister visar adress och beskrivning; etiketter visar adress, blocktyp och antal referenser.
- **Gå till definition** (Ctrl+klick, F12) på etiketter.
- **Synk:** markören i listningen markerar motsvarande rad i Monaco och tvärtom — möjligt eftersom båda bygger på samma `Line[]`.
- Källkoden är skrivskyddad i v1; redigering sker i listningen så att projektet förblir sanningskällan. **Planerat:** "detach"-läge där exporterad källkod redigeras fritt och fil-watchern bygger om.

### 14.4 Tillgänglighet

Synlig fokusmarkering, tangentbordsnavigering överallt, `aria`-etiketter på ikonknappar, färg är aldrig enda bäraren av information (blocktyp står också i text och tooltip), `prefers-reduced-motion` respekteras, kontrast ≥ 4,5:1 för text i båda teman.

### 14.5 Grafikvyn (Graphics)

Fliken **Graphics** (även kommandopaletten) ritar hela minnet, oavsett vilka block analysen eller användaren satt, för
att man ska hitta grafik med ögonen, som i ICU64. Geometri och ritning ligger i `src/lib/gfxview.ts` och testas i
`test/gfxview.test.ts`. **Lägesraden** överst (`ViewModes`, gemensam med Memory) har en knapp per läge med ikon och cellens storlek (*8×8*,
*24×21*, *320×200*, *40×25*). Det valda läget är ifyllt med accentfärgen, och bredvid står lägets namn med vad vyn
visar (*Sprites · 64 bytes each · 8 a row · hires · 2×*). Där står också *Go*-fältet. Under den ligger inställningarna i
grupper med rubrik: *Fonts* (Font per row), *Layout* (per rad, zoom, förskjutning), *Characters* (Screens) och
*Colours*. I en smal editor döljs först storlekarna och sedan knapparnas namn (ikonerna och raden bredvid står kvar).

**Samma adresser i alla lägen:** adressen överst i bilden, dit man scrollat eller gått med *Go*, står kvar överst när
man byter läge, antal per rad eller zoom. Raden med den adressen hamnar överst, och i Bitmaps är det den 8 KB-ruta den
ligger i. Adressen följer bara ens egen scrollning, så Characters → Bitmaps → Characters hittar samma teckenrad igen.
Font per row har fonter i stället för adresser och lämnar den orörd. När fliken öppnas visas markören, eller markeringen.

Det finns fem lägen:
- **Characters:** 8 byte per tecken, 16, 32, 40 (standard, en skärms bredd) eller 64 per rad. Med *Other…* skrivs
  vilket antal som helst från 1 till 128 in. `Enter` eller att lämna fältet tar det, och piltangenterna stegar det. Ett
  sparat 32, den tidigare standarden, blir 40 en gång (`GfxPrefs.v` 2). Ett annat valt antal behålls.
- **Sprites:** 64 byte per sprite, 24 × 21 pixlar, 4, 8 eller 16 per rad.
- **Bitmaps:** en ram på 320 × 200 (8000 byte) per 8 KB.
- **Screens:** en skärmmatris per 1 KB, som VIC placerar dem: 40 × 25 skärmkoder (1000 byte), 1, 2 eller 3 per rad. Varje
  skärmkod ritas med en teckenuppsättning som väljs i *Charset*:
  - **C64 ROM, upper case / lower case:** VICE:s tecken-ROM (4 KB). Den läses från den VICE som står i inställningarna
    (`vice:chargen`: mappen `C64` bredvid `bin`, eller bredvid programmet, `chargen-901225-01.bin` eller `chargen`).
    ROM:en följer aldrig med appen. Saknas den ritas de inbyggda tecknen, och valet säger *(not found)* och var den letades.
  - **Built-in letters and digits:** demons font på sina skärmkoder (@, A–Z, mellanslag till ?), med kod 128–255 inverterade.
    Grafiktecknen är tomma.
  - **Charsets found:** teckenuppsättningar som analysen eller användaren har satt.
  - **2 KB of memory at:** vilken 2 KB-gräns som helst i minnet.

  En skärm kan ligga var som helst i ett program (en titelbild som kopieras till `$0400`, till exempel). Därför flyttar *Go* i
  det här läget rutnätet så att en skärm börjar där man går till (*Offset* visar hur mycket). Under vyn står rad och
  kolumn i skärmen och, för en skärm på en 1 KB-gräns, `$d018`-värdets höga nibble och VIC-banken
  (`$d018 = $1x in VIC bank 0`).
- **Font per row:** en bild där varje teckenrad har sin egen font (256 tecken, 2 KB), som när programmet byter
  teckenuppsättning (`$d018`) på varje teckenrad. Alla rader visar samma 40 skärmkoder, skärmens första rad, så det är
  fonterna som avgör vad som syns. Raderna tar en font var 2 KB från *First font* (`fontRowStarts`, `fontRowsLayout`):
  - *Screen codes:* adressen till de 40 koderna (hex eller etikett), eller ett block ur rullmenyn bredvid. Menyn listar
    analysens block efter typ, de typer koderna oftast finns i först (skärmmatris, text, data, tabeller …) och kod sist,
    med etikett och storlek (`$0985 txt_0985 · 48 bytes`), och `$0400` (C64:ans skärm) när inget block börjar där. En
    adress som inte är ett blocks start visar *Blocks…*. Pilarna bredvid menyn (*Previous block* / *Next block*), mushjulet
    över den och `↑`/`↓` när den har fokus stegar ett block i taget i menyns ordning. Från en adress utanför listan går
    nedåt till det första blocket och uppåt till det sista. Är koderna inte laddade, till exempel för att skärmen fylls när
    programmet körs, används koderna 0–39 och vyn säger *not loaded: 0–39*.
  - *First font:* fonten för den första raden (hex eller etikett, vilken adress som helst).
  - *Rows:* 1–25. Rader som skulle börja efter `$ffff` tas inte med.
  - *Skip where no font can be* (på som standard): 2 KB där ingen font kan ligga hoppas över, och raden tar nästa 2 KB
    (`NO_FONT`). Det gäller 2 KB som rör:
    - `$0000–$07ff`: nollsidan, stacken och skärmen;
    - `$1000–$1fff` och `$9000–$9fff`: VIC ser tecken-ROM:en där (i bank 0 och 2), inte RAM;
    - `$d000–$dfff`: I/O och färg-RAM.

    RAM under BASIC- och Kernal-ROM:en (`$a000–$bfff`, `$e000–$ffff`) hoppas inte över, för VIC läser alltid RAM där.
    Vyn säger vilka som hoppades över (*skipped $1000, $1800*). Ligger *First font* där ingen font kan vara börjar bilden på
    nästa möjliga. Från `$3000` får 22 rader plats före `$ffff`, eftersom `$9000`, `$9800`, `$d000` och `$d800` hoppas över.

  En cell är en rad, alltså dess font. Ett klick väljer radens font (2 KB), och *All N rows* väljer alla fonterna (från den
  första till den sista, med det som hoppades över emellan). Under
  vyn står rad, kolumn, tecknet och fonten (`row 0, column 0: char $08 of the font at $3000`) och adressen till
  teckenraden under pekaren. *Mark as Charset* sätter blocktypen för fonterna. Vänsterkanten visar varje rads font.

**Visning:** zoom 1–4×, hires eller multicolor (bitpar: BG, MC1, MC2, FG). Färgerna väljs ur C64-paletten. *Offset*
flyttar rutnätet byte för byte, för data som inte börjar på en cellgräns. Byte som inte är laddade ritas i en egen
blågrå ton. Vänsterkanten visar adressen för varje rad och, med blockgruppens färg, vad som redan är klassat där.
Under vyn står byten under pekaren, med teckennummer i sitt 2 KB-teckensnitt, spritepekare och VIC-bank, eller
bitmappens 8 KB, samt blocket den ligger i. Valen sparas per användare.

**Markering:**
- Ett klick väljer en cell, och `Shift`+klick eller dragning väljer flera.
- *Go* tar en adress, en etikett eller ett intervall.
- Markeringen är listningens markering, så inspektorn och statusraden följer med.
- *Whole charset (2 KB)* och *Whole bitmap (8000 bytes)* utvidgar markeringen till VIC:s gränser. *With the sprite pointers
  (1 KB)* tar med de 24 byte efter en skärm (16 oanvända och de 8 spritepekarna).
- *Mark as Charset / Sprite data / Bitmap / Screen matrix* sätter blocktypen (en override som `C`/`D`/…, ångras med `Ctrl+Z`). Vyns egen
  typ ligger först.
- *Show in listing* och dubbelklick går till platsen i listningen. `Esc` tar bort markeringen.

**Spara (*Save…*):** markeringen sparas med en spara-dialog (`file:save`) i ett av dessa format:
- **Raw bytes (.bin):** bytena som de är.
- **With its load address (.prg):** laddadressen först, så att `LOAD"…",8,1` lägger tillbaka den. För tecken heter det
  *Charset with its load address (.64c)*.
- **Koala Painter (.kla) och Art Studio (.art)**, bara för bitmappar (vyns läge först):
  - Koala: `$6000`, bitmappen, skärmmatrisen (`%01` hög och `%10` låg nibble), färg-RAM (`%11`) och bakgrunden, 10003 byte.
  - Art Studio: `$2000`, bitmappen, skärmmatrisen (satta bitar hög nibble), ramfärgen och 6 byte utfyllnad, 9009 byte.
  - Färgerna är vyns: en uppsättning för hela bilden. En kortare markering fylls ut med nollor.
- **Image as shown here (.png):** markeringen ritad som i vyn men utan mellanrum (`gfxImage`). Tecken ligger 16 per rad och
  sprites 8 per rad, en bitmapp blir 320 × 200, en skärm också (ritad med vyns teckenuppsättning, en per 1 KB, under
  varandra), de valda raderna av en font-per-rad-bild som 320 × 8 per rad, och multicolour-pixlar är två breda. Celler efter markeringens slut är
  genomskinliga.
- **Kick Assembler source (.asm):** en kommentar, en etikett och `.byte`-rader formade efter grafiken (`gfxSource`):
  - tecken som en binär byte per rad, åtta rader per tecken, så att formen syns;
  - sprites som tre binära byte per rad, med 21 rader, utfyllnadsbyten och spritepekaren i kommentaren;
  - bitmappar i hex, åtta per rad (en cell);
  - skärmar i hex, en skärmrad med 40 koder per rad, och de 24 byte efter de 1000 på en egen rad (*then 16 unused bytes and
    the 8 sprite pointers*);
  - fonterna i en font-per-rad-bild som tecken.

En skärm sparas som rå bytes, med laddadress (.prg), som bild eller som källkod. Den har inget eget bildformat som Koala.
Filen får blockets etikett när markeringen börjar ett block, annars `charset_`/`sprites_`/`bitmap_`/`screen_`/`fonts_` och
adressen.
`packages/core/src/c64/gfxfiles.ts` har formaten. `test/gfxfiles.test.ts` kontrollerar bilderna och assemblerar
källkoden till samma bytes, med den inbyggda assemblern och med riktiga KickAss.jar (showcasens sprites och
teckenuppsättning). E2e-testet sparar en teckenuppsättning (.bin, .64c, .asm), en sprite (.png, 24 × 21) och en bitmapp
(.kla med vyns färger). Ett annat e2e-test går till texten vid `$0985` i läget Screens och sparar den som .bin, .prg,
.png (320 × 200) och .asm (25 rader). Ett tredje ritar *Font per row* med koderna i `txt_0985` och fonterna från `$3000`,
väljer en rad och alla rader och sparar en rad som .png (320 × 8).

### 14.6 Minnesvyn (Memory)

Fliken **Memory** (även kommandopaletten) visar det laddade minnet som VICE-monitorn skriver ut det
(`packages/core/src/c64/monitor.ts`, `src/components/MemoryDump.tsx`). Lägesraden är densamma som i Graphics: *Hex and
text*, *PETSCII* och *Screen codes*, var och en med monitorns kommando som en tangent (`m`, `i`, `ii`), och bredvid vad vyn
visar (*Hex and text · 16 bytes a row · upper case*), kommandofältet och *Copy*. Under den grupperna *Layout*, *Text* och
*Find*:
- **`m`**: en rad är `>C:0801  0b 08 0a 00  9e 32 30 36  34 00 00 00  00 00 00 20   .....2064...... `, alltså adressen, 16
  byte i grupper om fyra (8 som i en 40-kolumnsmonitor, valbart) och samma byte som text. En kort sista rad fylls ut så att
  textkolumnen står kvar.
- **`i`**: 40 byte per rad som PETSCII-text.
- **`ii`**: 40 byte per rad som skärmkoder, med `*C:` först. `$80-$ff` visas inverterade.

VICE skriver textkolumnen som bytena själva och låter monitorns C64-typsnitt rita dem. Här blir en byte det tecken C64:an
visar (`monitorChar`), i teckenuppsättningen med versaler och grafik eller, med *Lower case*, den med gemener. `£ ↑ ← π`
finns med. Styrkoder och grafiktecken skrivs som `.`. Raderna börjar där varje laddat område börjar. Mellan områdena står en
rad om minnet som inte är laddat.

**Kommandon:** fältet tar VICE:s egna kommandon: `m 0801 08ff`, `i 0801`, `ii 0400 07e7`, en adress eller en etikett (med
eller utan `.`), och `0801-08ff`. Slutet räknas med, som i VICE. Kommandot byter läge, börjar raderna på sin adress som VICE
gör (raden före blir kortare) och markerar intervallet eller sätter markören.

**Sök** (verktygsradens andra rad, `Ctrl+F` i dumpen) letar i det laddade minnet (`findInMemory`):
- **Text** jämförs med tecknen som dumpen visar, i den valda teckenuppsättningen, utan hänsyn till skiftläge och
  inverterade tecken. Den hittas både som PETSCII och som skärmkoder. Siffror och tecken som är lika i båda räknas som en
  träff (*PETSCII and screen codes*).
- **Bytes** är hexpar: `a9 00 8d`, `$a9,$00` eller `a9008d`, med `??` för vilken byte som helst. Det som inte är en byte ger
  ett fel i rött.

Varje träff färgas i både hex- och textkolumnen. En träff går aldrig över slutet av ett laddat område, och sökningen
stannar efter 5000 träffar. `Enter` (eller ↓, och `F3` i dumpen) går till nästa träff efter markören och `Shift+Enter`
(↑, `Shift+F3`) till den före. Träffen markeras, så den kan markeras som text, skärmkoder, data eller kod direkt.
Statusen säger vilken träff det är och hur den matchade (*1 of 2 matches · PETSCII*). `Esc` tömmer fältet.

**Markör och markering** delas med listningen:
- Ett klick på en byte, i hexkolumnen eller textkolumnen, sätter markören där.
- `Shift`+klick eller att dra markerar, och piltangenterna flyttar (med `Shift` växer markeringen).
- Ett dubbelklick visar byten i listningen.
- En markering kan markeras som text, text i skärmkoder, bytes eller kod härifrån.

**Kopiera:** *Copy selection* / *Copy all* lägger raderna på urklipp som VICE skriver dem (`monitorText`), med raderna från
markeringens början. Raden under vyn beskriver byten under musen eller vid markören: värdet i hex, decimalt och binärt,
tecknet som PETSCII och som skärmkod, och blocket. *Block colours* färgar byten efter blockets typ som i minneskartan.

**Test:** `packages/core/test/monitor.test.ts` kör riktiga x64sc 3.10 (`-console`, egen konfigurationsfil, `logname`/`log on`
i monitorn), som laddar demon och skriver `m 0801 08ff`, `i` och `ii`. Radadresserna och hexkolumnen ska vara exakt de VICE
skriver, och textkolumnen bytena själva. E2e-testet går igenom `m`, `i` och `ii`, markören, piltangenterna, ett kommando,
*Copy selection*, *Mark as Bytes* och dubbelklicket till listningen.

### 14.7 Showcase-demon (Demo)

**Demo** i Explorer (och *Load the showcase demo* i kommandopaletten) öppnar `showcaseProject()`
(`packages/core/src/showcase.ts`). Programmet byggs från källkod med verifierarens assembler, liksom `makeDemo()`, och blir
`mimir-showcase.prg` ($0801–$613F). I VICE är det ett litet intro:
- en multicolor-bitmapslogga (MIMIR) i VIC-bank 1 ovanför en textskärm i bank 0, med rasterstreck i övre och nedre ramen;
- åtta multicolor-sprites, en skuggad boll i fyra bilder, som rör sig på tre sätt (SPACE byter, och efter 256 bilder byts det
  av sig självt);
- en färgvåg, en mjuk scroller och trestämmig musik (Am F C G). RESTORE stänger av och sätter på musiken.

Det har ett block av varje typ som analysen hittar: BASIC, kod, text (PETSCII via `$ab1e`/`$ffd2` och skärmkoder), bytes,
`.word`, färg- och kurvtabeller, lo/hi-tabeller, sprites, teckenuppsättning, bitmapp, skärmmatris, musik och fyllnad. Det har
också det analysen letar efter:
- tre rasteravbrott och en NMI;
- en `.word`-hopptabell (8.5) och självmodifierande kod;
- BIT-tricket och odokumenterade opkoder (LAX, DCP);
- en nollsidepekare, KERNAL-anrop och VIC-bankväxling.

Delningen mellan bitmapp och text kräver bankspårning (8.7), så Demo slår på den.

**Turen:** projektet har 15 bokmärken i adressordning. F2 går till nästa, Ctrl+B listar dem, och Demo öppnar bokmärkesvyn.
De förklarar vad koden gör och vad man kan prova i appen: F5 och F7, Cycles, Graphics, Memory (`ii`) och Pack. Huvud-
rutinerna har namn (`irq_top`, `move_sprites` och så vidare, som *set by you*). Det finns också några kommentarer och
kommentarrader, nollsidevariabeln `row_ptr` med kommentarer (10) och två blockkommentarer. Inget av det ändrar en byte.

Den första starten med en ny profil visar fortfarande raster-demon (`demoProject()`), som testerna bygger på.

**Test:** `test/showcase.test.ts`:
- varje blocktyp på sin plats, de spårade avbrotten och hopptabellen;
- round-trip, och turens bokmärken, namn och kommentarer i källkoden;
- att charset och bitmapp skiljs åt bara med bankspårning.

`test/kickass.integration.test.ts` bygger turprojektet med riktiga KickAss.jar, också med råa adresser. E2e-testet laddar
Demo, går igenom turen med F2, hittar alla blocktyper i Blocks-vyn och verifierar.

## 15. Prestanda

| Område | Budget | Teknik |
|---|---|---|
| Analys 64 KB | < 50 ms | Typade arrayer, O(n)-pass, worker |
| Render (linjemodell + text) | < 30 ms | Ett pass per block, strängar byggs en gång |
| Omdöpning | < 16 ms upplevd | Endast `render()` körs om |
| Listning | 60 fps | Virtualisering (20 px rader, ~60 synliga), memoiserade rader |
| Heatmap | < 5 ms | En `ImageData` 256 × 256, overlay-canvas för markering |
| Verifiering | < 200 ms (prototyp), < 2 s (KickAss.jar) | |

## 16. Teststrategi

| Nivå | Innehåll |
|---|---|
| Enhet | Alla 256 opkoder (längd, läge, flöde, kodning); BASIC-parsning; PSID-skrivning/läsning; symbolupplösning |
| Heuristik | Små syntetiska program per regel (IRQ-uppsättning, lo/hi-tabeller, BIT-skip, SMC, musik, `$D018`-varianter) med förväntade block och etiketter |
| Golden files | Korpus av riktiga PRG → förväntad `.asm`; diff vid ändring kräver granskning |
| Round-trip | Hela korpusen och fuzzning (fast-check): slumpade PRG, overrides och inställningar ska alltid ge byte-identisk utdata |
| Integration | Riktig KickAss.jar i CI (Java i containern); VICE headless (`-console -limitcycles`) för täckningsmätning |
| UI | Playwright for Electron: ladda PRG, döp om, markera, exportera, bygg |
| Prestanda | Benchmark per commit för analys/render på 64 KB-fall |

## 17. Roadmap

| Milstolpe | Innehåll |
|---|---|
| **M1 Kärna** | Opkoder, spårning, evidens, symboler, Kick-generator, verifierare, CLI, testkorpus |
| **M2 Desktop-MVP** | Electron-skal, listning, Monaco, inspektor, overrides, undo, export, KickAss-bygg, VICE-start |
| **M3 VICE live** | Binary monitor: brytpunkter, minnes-/registervy, dynamisk täckning, hot reload |
| **M4 Strukturer** | Användardefinierade structs, makroigenkänning (upprepade kodmönster → `.macro`), lokala etiketter (`!loop:`), scopes per rutin |
| **M5 Format** | `.d64`-import, `.sid`-import (PSID/RSID), `.crt`, Koala/Art Studio-export av bitmappar |
| **M6 Fler mål** | Export till ACME, 64tass, ca65; plugin-API för egna heuristiker |

## 18. Risker och öppna frågor

| Risk / fråga | Åtgärd |
|---|---|
| Komprimerade/krypterade program ger lite att analysera | Entropidetektering och tydligt råd; M3-dynamisk analys kan dumpa uppackat minne från VICE |
| Kod som bara nås via beräknade hopp (RTS-trick, tabeller i ZP) | Diagnostik + "Mark as code"; dynamisk täckning i M3 |
| Skillnader mellan Kick Assembler-versioner | Generatorsyntax konfigurerbar; round-trip med användarens egen KickAss.jar avgör |
| Falska positiva i grafikheuristiken | Konfidensnivåer, förklaringar och förhandsvisning; overrides är billiga |
| Stora projekt med många filer | Analys per fil i worker-pool, delad symboltabell |
| Licens för symbolbeskrivningar och exempel | Egna formuleringar; inga ROM-dumpar distribueras |

## 19. Prototypen i den här filen

Den här HTML-filen är en körbar arkitekturprototyp av renderern och kärnan:

- **Fungerar på riktigt:** 6502/6510-disassemblering med alla odokumenterade opkoder, rekursiv spårning, konstantpropagering, IRQ-vektorer, hopptabeller, BIT-skip, SMC, musik- och grafikdetektering, dataklassificering, symboler, interaktiv omdöpning, kommentarer, mark-as, ångra/gör om, heatmap, grafikförhandsvisning, korsreferenser, statistik, Monaco med Kick Assembler-språk, round-trip-verifiering, ZIP-export med byggskript, projektfiler.
- **Simulerat:** att starta KickAss.jar och VICE kräver desktop-appens huvudprocess. Här visas exakta kommandon och den inbyggda verifieraren ersätter KickAss.jar.
- **Prova:** demoprogrammet laddas automatiskt, och *Demo* i Explorer öppnar showcasen med en guidad tur (14.7). Öppna egna `.prg` med *Open* eller dra in dem. Tryck `N` på en etikett, `C`/`D`/`T` för att ändra typ, `F7` för att verifiera och *Export* för ett komplett Kick Assembler-projekt.
