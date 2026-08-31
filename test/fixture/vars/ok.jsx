// Clean references. Every name here is declared in ../tokens.css, apart from
// the two that are deliberately not: `--set-from-js` is written by script at
// runtime and `--lib-gap` belongs to a third-party stylesheet. Neither can be
// in the token file, which is what `allow` and `allowPrefixes` are for.
//
// The references are spread on purpose. One lives in an object declared above
// the return, where a tag walker would never look; one is inside a ternary,
// which is the shape a CSS parser cannot read at all.
const panel = { background: 'var(--surface-raised)', color: 'var(--text-strong)' };

export function Panel({ dim, children }) {
  return (
    <div style={panel}>
      <span style={{ color: dim ? 'var(--text-quiet)' : 'var(--text-strong)' }}>{children}</span>
      <hr style={{ borderColor: 'var(--hairline, var(--surface))' }} />
      <a style={{ color: 'var(--link)', top: 'var(--set-from-js)' }} href="/x">
        go
      </a>
      <i style={{ width: 'var(--lib-gap)' }} />
    </div>
  );
}
