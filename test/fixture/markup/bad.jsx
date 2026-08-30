// Dirty markup. Four things in here should be caught: one class that is not on
// the approved list (inside a ternary, so only a scanner that reads both
// branches finds it), and three literal values hardcoded into inline styles.
export function Promo({ loud }) {
  return (
    <section className="card">
      <div className={loud ? 'promo-huge' : 'card'}>
        <a className="card__link" href="/somewhere" style={{ color: '#ff0055', paddingTop: '13px' }}>
          go
        </a>
      </div>
      <p className="card" style="margin-top: 7px">text</p>
    </section>
  );
}
