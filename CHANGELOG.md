# Changelog

## 0.5.0

**`taste-check runtime` measures a rendered page.** It opens the URL in a
headless Chromium, or connects to a browser you already have, and reads colours
off `getComputedStyle` rather than deriving them from a token file. It closes
only a browser it started.

No dependency was added for this. The Chrome DevTools Protocol is JSON over the
WebSocket Node already ships, and the two methods needed here are small enough
to own. taste-check still installs with nothing behind it.

Two things it does that reading tokens cannot:

- **It composites the whole background stack.** White text on a 75% black scrim
  over a near-white page measures 10.57:1. Stopping at the first opaque
  ancestor, which is what the check this was ported from did, measures the
  white against the page and reports 1.04:1. That is a false failure, and the
  same shortcut produces a false pass with the colours reversed.
- **It can measure a state.** `before` runs on every navigation ahead of the
  page's own scripts, so a theme read at boot sees it. `after` runs once there
  is a document. Each state's setup is removed before the next, so they cannot
  leak into each other.

A selector matching nothing fails. So does a border colour on an edge with no
width: the question is wrong rather than the answer being zero.

CI now fails if the runner has no browser, because the runtime tests skip
themselves without one and a silently skipped suite is the failure this project
exists to prevent.

## 0.4.1

Documentation only. No code changed.

Repositioned around what the tool actually is. It was described as two
deterministic checks in a box, which undersold the part that is hard to find
elsewhere: it measures what can be measured and gates the build on it, asks a
model about what cannot and keeps that advisory, and does not let either
pretend to be the other.

Adds a section naming the tools that do parts of this better, because several
do. If enforcing tokens in code is your whole problem, @lapidist/design-lint
parses properly rather than scanning and autofixes. If you want good design
opinions supplied rather than writing your own checklist, the agent skills that
ship a hundred of them are the better fit. If you run one accessibility tool,
run axe against a real page.

Future work reordered. The runtime mode moved to the front: an advisory judge
is only worth listening to if the measured half beside it is genuinely
measured, and reading a token file is the weaker version of that.

## 0.4.0

**`oklch()` and `oklab()` parse.** Both syntaxes, percentage or number for
every component, all four angle units on the hue.

Out-of-gamut colours are clipped rather than gamut-mapped, matching what a
browser canvas produces. Verified rather than assumed: 200 generated colours
painted on a canvas in a real browser and read back as pixels, 50 of them
deliberately outside the sRGB gamut. The worst disagreement across all 200 is
one channel unit, which is the two roundings sitting either side of the same
real number.

`lab()` and `lch()` still fail loudly. They need a D50 white point and a
chromatic adaptation step that `oklch()` does not.

## 0.3.1

**`!important` is stripped from a token value.** A token declared
`--ink: #111 !important` was reaching the colour parser as the string
`#111 !important` and failing as unparseable, on completely valid CSS. Found
by diffing the parser against a real CSSOM: a browser reading the property back
gets `#111`, so the tool should too.

Testing got a lot harder in this release, which is how that bug surfaced.

- 230 randomly generated colours rendered in a browser, with getComputedStyle
  read back and committed as a corpus. All agree.
- The CSS walker diffed against a browser on a stylesheet full of braces and
  semicolons hidden inside comments, strings and `url()`.
- The CLI binary now has end-to-end tests. Every check before this called the
  modules directly, so the suite would have stayed green with a broken exit
  code, a dead subcommand or a mis-parsed flag.
- A seeded fuzz suite over both hand-rolled walkers, plus pathological inputs:
  5000-deep braces, a two million character line, unterminated strings and
  comments, null bytes, a lone surrogate, and 400-deep nested template holes.
  40,000 random inputs found no crashes and no hangs.

Also says "1 pair" instead of "1 pairs".

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
