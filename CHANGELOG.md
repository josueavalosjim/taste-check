# Changelog

## 0.3.0

**`hsl()`, `hsla()` and `hwb()` parse.** Both syntaxes each, all four angle
units, and hue wrapping in both directions. Every expected value in the tests
was read out of a browser with `getComputedStyle` rather than derived from the
formulas the parser uses. The perceptual spaces (`oklch()`, `lab()`,
`color-mix()`) still fail loudly and are still named in the error.

**`taste-check judge`.** A fresh-eyes review of your screenshots against your
checklist, run by a model command you configure. It ships the framing and no
design rules: a shipped checklist would just be somebody else's taste wearing
the authority of a tool.

It is a separate subcommand because a model's verdict is not reproducible. A
"fail" prints as a note and exits 0 unless `judge.failOn` is `"fail"`. Whether
the judge ran is a different question and never advisory: no screenshots, a
command that exited non-zero, output that was not JSON, or a reply that skipped
or invented a checklist line all exit 1 either way.

## 0.2.0

`@layer` is now transparent. A `:root` inside `@layer tokens` resolves as a
top-level `:root` does.

0.1.x treated every at-rule the same and ignored its contents unless a scope
opted in by name. That is right for `@media` and `@supports`, which apply
conditionally, and wrong for `@layer`, which always applies and only changes
cascade priority. Since a layered token file is the common modern shape, the
old default meant a correct config reported "theme resolved zero tokens" on the
first run. It failed loudly rather than passing falsely, but it should not have
failed at all.

Conditional at-rules (`@media`, `@supports`, `@container`, `@scope`) still need
opting into. Naming a layer in a scope still narrows to that layer.

A scope that selects nothing is now a failure, even when the theme resolves
tokens from its other scopes. This was the worse of the two bugs: write
`[data-theme="dark"]` where the stylesheet says `:root[data-theme="dark"]` and
the base scope still fills the table, so the dark theme was measured against
the light theme's values and reported a pass. Wrong numbers under an `ok`, not
a loud failure.

**Breaking, in one direction only:** a config that already opted into a layer
keeps working. A config that worked around the old behaviour by opting into a
layer it did not want to be narrowed to may now see more tokens than before.

## 0.1.1

First installable release. Two checks, both driven entirely by config.

- **Contrast.** Reads CSS custom properties, resolves them per theme as an
  ordered list of scopes, follows `var()` indirection, composites translucent
  foregrounds over their background, and reports every pair with its margin.
- **Treatments.** Scans markup for class names not on an approved list and for
  literal colours and lengths hardcoded into inline styles. Tags are found by
  walking with quote and brace depth tracked, so a `>` inside an arrow function
  or an attribute string cannot hide one.

A missing token, an empty file match, a theme resolving nothing, an unparseable
colour and an unknown config key are all failures rather than skips.

Known limits are listed under "What this does not do" in the README. The
largest: this reads a token file, not a rendered page.

0.1.0 was published and then withdrawn before anyone could install it. npm
retires a version number permanently once it has been published, so the usable
history starts here. The contents are the same.
