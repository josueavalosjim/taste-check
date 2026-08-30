// Clean markup. Every class is on the approved list, and the only inline style
// is a computed custom property, which carries no literal value to flag.
//
// The two traps in here are deliberate. `onClick={() => open(href)}` contains a
// ">" inside braces, and `title="a > b"` contains one inside quotes. A regex
// that stops at the first ">" skips both of these tags entirely and reports a
// clean file.
export function Card({ featured, href, span, title }) {
  return (
    <article className="card" style={{ '--card-span': span }}>
      <a className={featured ? 'card__link card__link--featured' : 'card__link'} href={href}>
        {title}
      </a>
      <span className={`card__tag ${featured ? 'card__tag--on' : ''}`}>tag</span>
      <button className="button" onClick={() => open(href)} title="a > b">
        open
      </button>
      <p className="u-visually-hidden">opens in this tab</p>
    </article>
  );
}
