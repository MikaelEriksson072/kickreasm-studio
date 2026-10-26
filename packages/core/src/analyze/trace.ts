/* 5.4 entry points and recursive-descent code tracing, 5.7 forced code */
import type { Ctx } from './context';
import { OPC } from '../cpu/opcodes';
import { decode } from '../cpu/decode';
import { $4, h2 } from '../util/hex';

/** The program start set by the user, BASIC SYS targets, the first file's load address, user entries and code overrides. */
export function seedEntries(ctx: Ctx): void {
  const { basics, files, ov, project, enqueue, loaded, L } = ctx;
  // a start the user set replaces the detected one; a BASIC stub's SYS target is still code, the load address no longer is
  const userStart = project.entryPoint != null && loaded(project.entryPoint);
  if (userStart) { enqueue(project.entryPoint!, 'entry'); ctx.entry = project.entryPoint!; L('info', `Program start set by you: ${$4(project.entryPoint!)}`, project.entryPoint!, 'entry'); }
  else if (project.entryPoint != null) L('warn', `The program start you set (${$4(project.entryPoint)}) is not in a loaded file; using the detected one`, null, 'entry');
  for (const b of basics) if (b.sys != null) { enqueue(b.sys, 'entry'); ctx.entry = ctx.entry ?? b.sys; }
  if (files.length && !userStart && !basics.some(b => b.file === 0) && !ov[files[0].load]) {
    enqueue(files[0].load, 'entry'); ctx.entry = ctx.entry ?? files[0].load;
    L('info', `No BASIC stub in ${files[0].name}; using load address ${$4(files[0].load)} as entry point`, files[0].load, 'entry');
  }
  for (const a of project.entries || []) enqueue(a, 'user');
  for (const o of ctx.ovList) if (o.type === 'code') enqueue(o.start, 'user');
}

export function trace(ctx: Ctx): void {
  const { queue, mem, insLen, codeOwner, skip, loaded, forcedData, addX, enqueue, ijumps, inlineCalls, S, L } = ctx;
  while (queue.length) {
    let pc = queue.pop()!;
    for (;;) {
      if (!loaded(pc)) break;
      if (insLen[pc]) break;
      if (codeOwner[pc] >= 0) {
        const s = codeOwner[pc], op = mem[s];
        if ((op === 0x2c || op === 0x24) && pc === s + 1 && !skip.has(s)) {
          skip.add(s); insLen[s] = 1;
          for (let k = 1; k < OPC[op].len; k++) codeOwner[s + k] = -1;
          L('info', `BIT-skip idiom at ${$4(s)}: $${h2(op)} hides the instruction at ${$4(pc)}`, s, 'code');
        } else {
          L('warn', `Jump into the middle of the instruction at ${$4(s)} (target ${$4(pc)}); overlapping code is not traced`, pc, 'code');
          break;
        }
      }
      if (forcedData(pc)) { L('warn', `Code path runs into user-defined data at ${$4(pc)}`, pc, 'code'); break; }
      const info = OPC[mem[pc]];
      if (info.jam) { L('err', `JAM opcode $${h2(mem[pc])} reached at ${$4(pc)}; the path probably runs into data`, pc, 'code'); break; }
      if (info.ill && !S.illegal) { L('warn', `Undocumented opcode $${h2(mem[pc])} at ${$4(pc)} stops tracing (undocumented opcodes are disabled)`, pc, 'code'); break; }
      let ok = true;
      for (let k = 1; k < info.len; k++) {
        const b = (pc + k) & 0xffff;
        // every byte must be loaded by the same file: an instruction never crosses a file end (spec 7.3)
        if (!loaded(b) || ctx.owner[b] !== ctx.owner[pc] || insLen[b] || codeOwner[b] >= 0 || forcedData(b)) { ok = false; break; }
      }
      if (!ok && (mem[pc] === 0x2c || mem[pc] === 0x24) && insLen[(pc + 1) & 0xffff]) {
        skip.add(pc); insLen[pc] = 1;
        L('info', `BIT-skip idiom at ${$4(pc)}: $${h2(mem[pc])} hides the instruction at ${$4(pc + 1)}`, pc, 'code');
        break;
      }
      if (!ok) { L('warn', `Instruction at ${$4(pc)} would overlap other code or leave the file; tracing stopped`, pc, 'code'); break; }
      insLen[pc] = info.len;
      for (let k = 1; k < info.len; k++) codeOwner[(pc + k) & 0xffff] = pc;
      const d = decode(mem, pc), next = (pc + info.len) & 0xffff;
      if (info.flow === 'br') { addX(d.target!, pc, 'branch'); enqueue(d.target!, 'branch'); pc = next; continue; }
      if (info.flow === 'jmp') { addX(d.target!, pc, 'jump'); enqueue(d.target!, 'jmp'); break; }
      if (info.flow === 'jmpi') { addX(d.v!, pc, 'ptr'); ijumps.push({ pc, ptr: d.v! }); break; }
      if (info.flow === 'jsr') {
        addX(d.target!, pc, 'call'); enqueue(d.target!, 'sub');
        const t = d.target!;
        if (loaded(t) && mem[t] === 0x68 && mem[(t + 1) & 0xffff] === 0x85 && mem[(t + 3) & 0xffff] === 0x68) {
          inlineCalls.add(pc);
          L('warn', `JSR ${$4(t)} pops its return address; inline data follows ${$4(next)}`, pc, 'code');
          break;
        }
        pc = next; continue;
      }
      if (info.flow === 'ret') break;
      if (info.flow === 'brk') { L('warn', `BRK at ${$4(pc)} ends the code path`, pc, 'code'); break; }
      pc = next;
    }
  }
}

/** User "mark as code": linear sweep over the override range after tracing. */
export function sweepForcedCode(ctx: Ctx): void {
  const { ovList, insLen, codeOwner, mem, loaded, forcedData } = ctx;
  for (const o of ovList) {
    if (o.type !== 'code') continue;
    let a = o.start;
    while (a < o.end) {
      if (insLen[a]) { a += insLen[a]; continue; }
      const info = OPC[mem[a]];
      // Never start inside an instruction decoded earlier (overlapping code overrides), and leave
      // bytes that a later override turned back into data alone, as tracing does.
      let ok = codeOwner[a] < 0 && !forcedData(a) && loaded(a + info.len - 1) && a + info.len <= o.end;
      for (let k = 1; ok && k < info.len; k++) if (insLen[a + k] || codeOwner[a + k] >= 0 || forcedData(a + k) || ctx.owner[a + k] !== ctx.owner[a]) ok = false;
      if (!ok) break;
      insLen[a] = info.len; for (let k = 1; k < info.len; k++) codeOwner[a + k] = a;
      a += info.len;
    }
  }
}
