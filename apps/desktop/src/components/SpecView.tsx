/* The technical specification (docs/spec.md), rendered locally with marked. */
import { useMemo, useRef } from 'react';
import { Marked } from 'marked';
import spec from '../../../../docs/spec.md?raw';

const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9åäö]+/g, '-').replace(/^-|-$/g, '');

export function SpecView() {
  const html = useMemo(() => {
    const md = new Marked({ gfm: true });
    md.use({ renderer: { heading(text: string, level: number) { return `<h${level} id="spec-${slug(text)}">${text}</h${level}>`; } } });
    return md.parse(spec) as string;
  }, []);
  const toc = useMemo(() => spec.split('\n').filter(l => /^##\s/.test(l)).map(l => { const t = l.replace(/^##\s+/, ''); return { t, id: 'spec-' + slug(t) }; }), []);
  const body = useRef<HTMLElement>(null);
  return (
    <div className="spec">
      <nav className="spec-toc" aria-label="Specification contents">
        <div className="spec-toc-title">Innehåll</div>
        {toc.map(x => <a key={x.id} href={'#' + x.id} onClick={e => { e.preventDefault(); body.current?.querySelector('#' + CSS.escape(x.id))?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{x.t}</a>)}
      </nav>
      {/* the spec is a file from this repository, bundled at build time */}
      <article className="spec-body" ref={body}><div dangerouslySetInnerHTML={{ __html: html }} /></article>
    </div>
  );
}
