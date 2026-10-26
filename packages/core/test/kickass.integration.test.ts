/* Integration (spec 16): the generated projects must assemble with the real KickAss.jar to the
 * original bytes. Runs when Java and KickAss.jar are found (KICKASS_JAR / JAVA env vars or the
 * usual install folders), otherwise the suite is skipped. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { analyze, comparePrg, h4, makeDemo, OPC, openC64File, parsePrg, render, showcaseProject, type ProjectInput } from '../src';
import { findKickAssJar, runKickAssembler, writeVfs } from '../src/node';
import { allOpcodesProgram, fromSource, randomPrg, seededProject, SETTING_VARIANTS, zeroPageProgram } from './helpers/programs';

const jar = process.env.KICKASS_JAR || findKickAssJar();
const java = process.env.JAVA || 'java';
const available = !!jar && spawnSync(java, ['-version'], { windowsHide: true }).status === 0;

interface Case { name: string; project: ProjectInput }

const demo = (): ProjectInput => { const d = makeDemo(); return { name: 'raster-demo', files: [parsePrg(d.name, d.prg)] }; };

function cases(): Case[] {
  const out: Case[] = SETTING_VARIANTS.map((settings, i) => ({ name: `demo/settings#${i} ${JSON.stringify(settings)}`, project: { ...demo(), settings } }));
  {
    const A = analyze(demo()), code = A.blocks.find(b => b.start <= 0x0866 && b.end > 0x0866)!.start;
    out.push({ name: 'demo/blocks saved as binary files (code with labels inside, sine table, charset, music)', project: { ...demo(), binary: [code, 0x09b5, 0x3000, 0x1000] } });
    out.push({ name: 'demo/a binary code block left out of the build', project: { ...demo(), binary: [code, 0x09b5], excluded: [code] } });
  }
  {
    // a dump to $ffff that sets its own IRQ vector and reads RAM under the KERNAL, its top 8 KB one binary block
    const dump = fromSource('dump.prg', '.pc = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n.pc = $080d\n sei\n lda #<irq\n sta $fffe\n lda #>irq\n sta $ffff\n lda #$35\n sta $01\n lda $eaa5\n sta $d020\n cli\n jmp *\nirq:\n rti\n.pc = $e000\n .byte 1,2,3,4\n.pc = $ffff\n .byte 0');
    for (const hwInclude of ['import', 'none'] as const) out.push({ name: `dump over the CPU vectors, binary top block (hwInclude ${hwInclude})`, project: { name: 'dump', files: [dump], overrides: [{ start: 0xe000, end: 0x10000, type: 'charset' }], binary: [0xe000], settings: { hwInclude } } });
  }
  const snap = openC64File('raster-demo.vsf', new Uint8Array(readFileSync(join(__dirname, '../../../fixtures/vsf/raster-demo.vsf'))));
  out.push({ name: 'VICE snapshot (RAM $0200-$ffff, entries at the PC and the IRQ handler)', project: { name: 'snapshot', files: [snap], entries: snap.entries } });
  const snapZp = openC64File('raster-demo.vsf', new Uint8Array(readFileSync(join(__dirname, '../../../fixtures/vsf/raster-demo.vsf'))), { zeroPage: true });
  out.push({ name: 'VICE snapshot with the zero page and the stack (RAM $0002-$ffff)', project: { name: 'snapshot_zp', files: [snapZp], entries: snapZp.entries } });
  out.push({ name: 'demo/raw addresses with hardware comments (no include file)', project: { ...demo(), settings: { hwInclude: 'none', hwComments: true } } });
  {
    // the app's Demo: a bitmap logo above a text screen, a word jump table, the tour's names and comments
    const p = showcaseProject();
    out.push({ name: 'the showcase with its tour (names, comments, a commented zero-page variable)', project: p });
    out.push({ name: 'the showcase with raw addresses', project: { ...p, settings: { ...p.settings, hwInclude: 'none' } } });
  }
  out.push({ name: 'demo/renamed+commented', project: { ...demo(), labels: { 0x0810: 'main' }, comments: { 0x0810: 'entry "quoted" // and /* more */' } } });
  out.push({ name: 'text in every encoding (mixed case, @ inside screen code text)', project: { name: 'text', files: [randomPrg(77, 0xc000, 600)], overrides: [
    { start: 0xc000, end: 0xc080, type: 'text', props: { enc: 'screen-mixed' } }, { start: 0xc080, end: 0xc100, type: 'text', props: { enc: 'petscii-mixed' } },
    { start: 0xc100, end: 0xc180, type: 'text', props: { enc: 'screen' } }, { start: 0xc180, end: 0xc200, type: 'text', props: { enc: 'petscii' } },
  ] } });
  out.push({ name: 'demo/blocks excluded from the build (BASIC stub, sine table, music)', project: { ...demo(), excluded: [0x0801, 0x09b5, 0x1000] } });
  out.push({ name: 'demo/program start set by the user', project: { ...demo(), entryPoint: 0x0866 } });
  out.push({ name: 'demo/comment lines and blocks', project: { ...demo(), notes: { 0x0810: { text: 'set up the raster IRQ' }, 0x09c1: { text: 'block with "quotes"\nand */ inside', block: true } }, blockComments: { 0x0939: 'two\nlines' } } });
  out.push({
    name: '$01 and VIC bank switching (RAM under I/O, KERNAL out, $dd02)',
    project: {
      name: 'banks',
      files: [fromSource('banks.prg', '.pc = $c000\n lda #$35\n sta $01\n sta $d020\n jsr $ffd2\n dec $01\n lda $d000\n inc $01\n lda #$3d\n sta $dd02\n lda #$18\n sta $d018\n jsr sub\n rts\nsub: sta $d021\n rts\n.pc = $d000\n .byte 1, 2, 3, 4')],
      bankZones: [{ start: 0xc01a, end: 0xc01e, port: 0x34 }],
    },
  });
  out.push({ name: 'all opcodes', project: { name: 'opcodes', files: [allOpcodesProgram(OPC)] } });
  out.push({ name: 'zero-page program (.zp/.abs)', project: { name: 'zp', files: [zeroPageProgram()] } });
  // shapes the fuzz test found: wrapping branches at $0000, word tables, music overrides
  out.push({ name: 'load at $0000', project: { name: 'wrap', files: [randomPrg(-137153725, 0x0000, 200)] } });
  out.push({ name: 'word table + music overrides', project: { name: 'ov', files: [randomPrg(11, 0x0801, 1200)], overrides: [{ start: 0x0801, end: 0x080c, type: 'words' }, { start: 0x0900, end: 0x0940, type: 'music' }, { start: 0x0a00, end: 0x0a41, type: 'sprite' }] } });
  for (let seed = 1; seed <= 12; seed++) out.push({ name: `seeded #${seed}`, project: seededProject(seed) });
  return out;
}

async function assembleWithKick(c: Case) {
  const A = analyze(c.project);
  const R = render(A, c.project);
  const dir = await mkdtemp(join(tmpdir(), 'kickreasm-it-'));
  try {
    await writeVfs(dir, R.files);
    const results = [];
    for (const [fi, f] of A.files.entries()) {
      const entry = `${R.fileNames[fi]}.asm`;
      const run = await runKickAssembler({ java, jar: jar!, cwd: dir, entry, outDir: 'out', args: ['-vicesymbols', '-showmem'] });
      const cmp = comparePrg(f, run.prg, R.excluded.filter(x => x.file === fi));
      results.push({ entry, run, cmp });
    }
    return results;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!available)(`real Kick Assembler (${jar ?? 'not found'})`, () => {
  it('assembles every generated project byte-identical to the original', async () => {
    const all = cases();
    const failures: string[] = [];
    let next = 0, assembled = 0;
    const worker = async () => {
      while (next < all.length) {
        const c = all[next++];
        for (const { entry, run, cmp } of await assembleWithKick(c)) {
          assembled++;
          if (!run.ok || !cmp.ok) {
            const why = run.problems.length ? run.problems.map(p => `${p.file}:${p.line}:${p.column} ${p.message}`).join(' | ') : run.output.split('\n').slice(-6).join(' / ');
            failures.push(`${c.name} (${entry}): ${why} ${cmp.diffs.slice(0, 3).map(d => d.msg ?? `$${h4(d.addr)} expected ${d.exp} got ${d.got}`).join('; ')}`);
          } else {
            expect(run.vsPath, `${c.name}: -vicesymbols should write a VICE label file`).not.toBeNull();
          }
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    expect(failures).toEqual([]);
    expect(assembled).toBeGreaterThanOrEqual(all.length);
  }, 300_000);
});
