/** Split a user-entered argument string ("-vicesymbols -showmem", quotes allowed) into argv. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '', q = false, has = false;
  for (const c of s || '') {
    if (c === '"') { q = !q; has = true; continue; }
    if (!q && /\s/.test(c)) { if (has) out.push(cur); cur = ''; has = false; continue; }
    cur += c; has = true;
  }
  if (has) out.push(cur);
  return out;
}
