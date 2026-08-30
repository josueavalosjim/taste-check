# taste-check

Design review in CI, with a line down the middle of it.

Some of design review is measurable. Contrast ratios, values that should have
been tokens, class names nobody approved. taste-check measures those and fails
your build on them.

The rest is judgment, and it cannot be measured. For that it sends your
screenshots and your checklist to a model, and reports what comes back as an
opinion rather than a result.

Keeping those two apart is the whole design. A tool that blurs them either
blocks your pipeline on a coin flip or quietly downgrades a real failure to a
suggestion.

```bash
npm i -D @josueavalosjim/taste-check
```

```bash
npx @josueavalosjim/taste-check
```

```
contrast ok, 10 pairs across 2 themes
    ok  17.76:1  needs 4.5  light  --text-strong on --surface  body text
    ok   5.32:1  needs 4.5  light  --text-quiet on --surface  the translucent one
    ok   4.10:1  needs 3.0  light  --hairline on --surface  borders

treatments FAILED
  FAIL  src/Promo.jsx:7 class "promo-huge" on <div> is not approved
  FAIL  src/Promo.jsx:8 inline value "#ff0055" on <a> is a one-off. Use a token, or add it to approvedValues.
```

```bash
npx @josueavalosjim/taste-check judge
```

```
judge ok, 5 lines against 2 screenshots, 1 to read
  NOTE  fail   Nothing important is cut off at the edge: the third card runs
                past the right edge of the frame at roughly x=798 of 800.
```

Zero runtime dependencies. Node 22 or newer.

## Why this exists

Linters have a gate and no taste. They enforce what someone could write down
as a rule, which is why they can tell you an element fails 4.5:1 but not that
your borders answer to 3:1 while your captions answer to 4.5:1. That
distinction is yours, not the spec's.

The newer AI design reviewers have taste and no gate. They will tell you what
is wrong with a screen, in prose, in a chat window, and some of them arrive
with a few hundred opinions already loaded about what good looks like.

Both halves are useful and they need to stay separable. Run the same model
twice over the same unchanged screen and you can get two different answers,
which is fine for advice and disqualifying for a build gate. So the measured
half here gates, the judged half does not, and the tool will not let you
confuse one for the other by accident.

It also ships no design rules of its own. Not a palette, not a class list, not
a contrast floor, not a checklist. You supply all of it.

## What counts as a failure

Each of these exits 1 rather than passing quietly:

- a pair naming a token that does not exist
- a file pattern matching no files
- a theme whose scopes resolve no tokens
- a single scope inside a theme that selects nothing, even when the theme has
  tokens from its other scopes
- a colour value the parser does not understand
- an unknown key in the config, which is usually a typo doing nothing

A check that cannot fail is worse than no check, because it goes green and gets
quoted as evidence.

The judge is held to the same rule from the other side. Its verdicts never
affect the exit code by default, but a judge that could not run does: no
screenshots, a command that died, a reply that was not JSON or that skipped a
checklist line. "Did not run" and "found nothing" must not print the same
thing.

## The contrast check

Give it your custom properties, describe your themes, and list what must clear
what.

```json
{
  "contrast": {
    "tokens": ["styles/tokens.css"],
    "themes": [
      { "name": "light", "scopes": [":root"] },
      { "name": "dark", "scopes": [":root", "[data-theme=\"dark\"]"] }
    ],
    "pairs": [
      { "fg": "--text", "bg": "--surface", "min": 4.5, "label": "body text" },
      { "fg": "--hairline", "bg": "--surface", "min": 3.0, "themes": ["light"] }
    ]
  }
}
```

Passing pairs are printed with their ratio, not just failing ones, so you can
see which pair is one background nudge away from dropping under its floor.

`min` has no default. WCAG's 4.5 and 3.0 are documented here and never assumed
in code, because the floor for a decorative hairline and the floor for body
text are different decisions and both are yours.

A theme is an ordered list of scopes and later scopes win, which is the cascade
for equal specificity.

`@layer` is transparent. A `:root` inside `@layer tokens` resolves exactly as a
top-level `:root` does, because a layer changes cascade priority rather than
whether the declarations apply at all.

Conditional at-rules are different. `@media`, `@supports`, `@container` and
`@scope` only apply when their condition holds, so their declarations are
ignored unless a scope opts in by name:

```json
{ "name": "dark-system", "scopes": [":root", { "selector": ":root", "atRule": "prefers-color-scheme: dark" }] }
```

Without that, a `@media (prefers-color-scheme: dark)` block containing `:root`
would overwrite the light theme, and the light checks would measure against
colours the light theme never paints. You can also name a layer this way to
narrow a scope to it, but you should never need to just to see your tokens.

Two details make the numbers match a browser rather than approximate it.
Translucent foregrounds are composited over their background before measuring,
so `rgb(0 0 0 / 0.58)` on white scores 5.32:1 and not 21:1. And `var()`
indirection is followed within the theme, so a token pointing at another token
resolves to the value that theme actually uses.

A background that resolves to a translucent colour is refused rather than
measured. There is no page here to look through, so name the opaque surface
behind it instead.

## The treatments check

Give it your markup and your approved list.

```json
{
  "treatments": {
    "files": ["src/**/*.jsx"],
    "elements": ["a", "button", "div", "span", "p"],
    "approvedClasses": ["card", "card__link", "button"],
    "allowPrefixes": ["u-"],
    "approvedValues": ["0", "100%"]
  }
}
```

It reports two things: a class name that is not approved and matches no allowed
prefix, and a literal colour or length hardcoded into an inline `style`.

The parsing is a scanner, not a regex, and that is the whole reason it works. The obvious implementation is `/<a\b[^>]*?className="([^"]*)"/`, which
finds almost nothing while looking like it passes:

- `[^>]*` cannot cross `onClick={() => x}`. It stops at the arrow's own `>`,
  and the tag is skipped in silence.
- `title="a > b"` ends the tag early for the same reason.
- A `className` built as an expression is not a quoted string at all.

So tags are found by walking the source with quote and brace depth tracked, and
class names are collected from every string literal inside a `className`
expression. A ternary contributes both of its branches on purpose, because the
question is whether a class can appear at all. Over-reporting is the safer
direction to be wrong in.

Template literal holes are read into rather than blanked, so a class written
inside `` `card ${on ? 'card--on' : ''}` `` is seen.

## The judge

Everything above measures. This asks the question a measurement cannot: not
whether the screen is correct, but whether it is any good.

That question cannot be put to whoever just built the thing. The context that
made the choices is the worst placed to find them wanting, because the
reasoning that justified each one is still there ready to justify it again. So
the judge is a separate process that sees your screenshots and your checklist
and nothing else.

```json
{
  "judge": {
    "checklist": "design-checklist.md",
    "shots": ["shots/*.png"],
    "shotCommand": "node scripts/shots.mjs",
    "command": "claude -p",
    "failOn": "never"
  }
}
```

```bash
taste-check judge
```

Your `command` receives the prompt on stdin and the image paths as arguments,
so any model CLI works and no API key ever touches this tool. It must reply
with JSON:

```json
{ "findings": [ { "line": "<the checklist line, verbatim>", "verdict": "pass|fail|unsure", "why": "..." } ] }
```

taste-check supplies the framing: you are seeing this cold, you have not been
told what changed, answer every line, prefer unsure to a guess, do not be
agreeable, and name the specific thing you are looking at. That part is method
and it is the same for everyone.

The checklist is yours. taste-check ships none, and there is a test asserting
the framing mentions no design vocabulary at all, because a rule that arrives
inside a tool is somebody else's taste with the tool's authority behind it.
Checklist lines are list items in your file; a heading or a paragraph is prose
and is not judged.

### What the exit code means here

A verdict is an opinion, so a `fail` prints as a note and the command exits 0.
Set `failOn` to `"fail"` if you want it to block, knowing that two runs on the
same screenshot can disagree.

Whether the judge ran is not an opinion, and never advisory. Each of these
exits 1 whatever `failOn` says:

- no screenshots were produced or matched
- the command exited non-zero
- the reply was not parseable JSON
- the reply skipped a checklist line, invented one, or answered one twice

Without that split, "the judge did not run" and "the judge found nothing" print
the same thing.

## Config

Point your editor at `schema/config.schema.json` for completion and inline
docs. Paths inside a config resolve against the config file, so it can be run
from anywhere.

| Key | Meaning |
| --- | --- |
| `contrast.tokens` | CSS files holding the custom properties. Later files override earlier ones. |
| `contrast.themes[].scopes` | Selectors applied in order, later winning. A string, or `{ selector, atRule }`. |
| `contrast.pairs[].fg` / `.bg` | A token name, or a literal colour. `bg` must resolve to something opaque. |
| `contrast.pairs[].min` | The floor this pair must clear. Required. |
| `contrast.pairs[].themes` | Limit a pair to some themes. Omit to check it everywhere. |
| `treatments.files` | Markup to scan. Supports `dir/*.ext` and any-depth `**` patterns. |
| `treatments.elements` | Element names to scan. Omit or use `["*"]` for all of them. |
| `treatments.approvedClasses` | Every class allowed to appear. |
| `treatments.allowPrefixes` | Prefixes that are always allowed, as a deliberate escape hatch. |
| `treatments.approvedValues` | Literal values allowed inside inline styles. |
| `judge.checklist` | Your checklist file. List items are judged, prose is not. |
| `judge.shots` | Screenshots to hand the judge. Matching nothing is a failure. |
| `judge.shotCommand` | Optional command run first to produce those screenshots. |
| `judge.command` | The model command. Prompt on stdin, image paths as arguments. |
| `judge.failOn` | `"never"` (default) or `"fail"`. Whether a verdict blocks. |

```
taste-check [options]         Run the deterministic checks
taste-check judge [options]   Ask a fresh-eyes judge about your screenshots

  -c, --config <path>   Config file (default: tastecheck.config.json)
      --only <name>     Run one check: contrast or treatments
      --json            Machine-readable output
      --version         Print the version
```

Exit code is 1 if any check fails, 0 if every check ran and passed. The judge
plays by the rules in its own section above.

## Where it sits next to other tools

This is a small tool with a narrow claim, and several of these are better than
it at the thing they do. Reach for them.

**axe, pa11y.** They run against a real rendered page and catch far more than
contrast. taste-check checks pairs you declare in a config, before a page
exists and without a browser. Use both. If you only run one accessibility
tool, run axe.

**stylelint, eslint.** General code quality, with an enormous rule ecosystem.
Nothing here replaces them.

**@lapidist/design-lint.** More thorough than taste-check on the token and
component side: it parses properly rather than scanning, knows about
frameworks, autofixes, and manages deprecations. If enforcing tokens in code is
the whole of your problem, it is the better fit.

**Checklist Design and similar agent skills.** They arrive with a hundred or
more published checklists and review conversationally. If you want good
opinions supplied, take theirs. taste-check supplies none on purpose and runs
in CI with an exit code instead.

What is left, and the reason this exists: nothing above draws a line between
the part that can gate a build and the part that cannot. The linters have no
judgment, the judges have no gate.

## What this does not do

Read this before trusting a green run.

**It reads tokens, not a rendered page.** This is the real limit. The check it
was ported from ran in a browser and read colours off `getComputedStyle`,
because a token file cannot tell you what is actually painted behind an
element. An overlay, an ancestor background or a colour set inline by a
component are all invisible here. What this gives you is that the
values in your token file relate to each other the way you said they should. It
does not prove what a visitor sees.

**Only some colour formats parse.** Hex in 3, 4, 6 and 8 digits; `rgb()`,
`rgba()`, `hsl()`, `hsla()`, `hwb()`, `oklch()` and `oklab()`; and `white` /
`black` / `transparent`. `lab()`, `lch()` and `color-mix()` are not parsed yet.
A value it cannot parse fails, so you hear about it immediately.

An `oklch()` outside the sRGB gamut is clipped rather than gamut-mapped, which
is what a browser canvas does with it. That was checked rather than assumed:
the test corpus has fifty deliberately out-of-gamut colours painted in a real
browser and read back as pixels, and the parser agrees with all of them to
within one channel unit.

**There is no specificity resolution.** Scopes apply in the order you list
them. If your tokens rely on `.a.b` beating `.b`, list the scopes in the order
you want.

**Component indirection is invisible.** Classes applied by a helper
function, a `clsx` call importing names from elsewhere, or CSS-in-JS are
invisible to it.

## Future directions

Not built. Written down so the shape is clear.

**A runtime mode**, closing the gap named above by measuring `getComputedStyle`
in a real browser, as an optional peer dependency so the core stays free of
one. This is the one that matters most. An advisory judge is only worth
listening to if the measured half beside it is genuinely measured, and reading
a token file is the weaker version of that.

**YAML configs**, once there is a reason to take on a parser.

**SARIF output**, so findings land in a code scanning tab rather than only in
a log.

**A way to run the judge from an agent skill**, not only from a shell.

**`lab()` and `lch()`**, which need the D50 white point and a chromatic
adaptation step that `oklch()` does not. Completeness rather than reach, so
it sits behind the others. Worth doing the same way when it happens: derive it,
then check every case against a browser rather than trusting the matrices.

## Development

```bash
npm test
```

Releases are automated. `npm run release` runs the suite, bumps the patch
version, tags it and pushes. The tag triggers a workflow that runs the suite
again, checks both fixtures still produce the exit codes they should, verifies
the tag matches `package.json`, and publishes. Publishing uses npm's trusted
publisher over OIDC, so no npm token is stored in the repository and every
release carries a provenance attestation. For a minor or major bump, run
`npm version minor` or `npm version major` and `git push --follow-tags`.

34 tests. Most of them plant a violation into a fixture that was passing a
moment earlier and demand it gets caught: a token darkened below its floor, an
unapproved class added to a clean file, a class buried in a template literal
hole, a file pattern pointed at nothing.

## License

MIT
