// The failure this check exists for. Both names read like they belong to a
// design system and neither is in ../tokens.css. They are the shape a model
// reaches for when it is writing plausible code without knowing the real
// names: a numbered ramp, and a tier borrowed from somewhere else.
export function Banner() {
  return (
    <aside style={{ background: 'var(--color-primary-500)' }}>
      <p style={{ color: 'var(--text-secondary, #666666)' }}>notice</p>
    </aside>
  );
}
