# taste-check

Design review in CI, with a line down the middle of it.

Some of design review is measurable. Contrast ratios, values that should have
been tokens, class names nobody approved. taste-check measures those and fails
your build on them, either from your token file or from a page it renders in a
real browser.

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

## Measuring the rendered page

The contrast check above reads your token file, which tells you what a colour
is declared to be. `taste-check runtime` opens the page and reads what is
actually painted.

```json
{
  "runtime": {
    "url": "http://localhost:3000",
    "states": [
      { "name": "light" },
      { "name": "dark", "before": "localStorage.setItem('theme', 'dark')" }
    ],
    "targets": [
      { "selector": ".caption", "prop": "color", "min": 4.5 },
      { "selector": ".panel", "prop": "borderTopColor", "min": 3.0 },
      { "selector": ".row.is-selected", "prop": "backgroundColor", "min": 1.25, "againstParent": true }
    ]
  }
}
```

```bash
taste-check runtime
```

It launches a headless Chromium, or connects to one you already have if you
give it an `endpoint`, and it never closes a browser it did not start. There is
no dependency for this. The Chrome DevTools Protocol is JSON over the WebSocket
Node already ships, and the part of it needed here is two methods.

Two things this does that reading tokens cannot.

**It composites the whole background stack.** White text on a 75% black scrim
over a near-white page measures 10.57:1. Stop at the first opaque ancestor, the
way the check this was ported from did, and you measure the white against the
page instead and get 1.04:1. That is a failure the design has not earned, and
with the colours the other way round the same shortcut hands you a pass it has
not earned either.

**It can measure a state.** `before` runs on every navigation ahead of the
page's own scripts, which is where a theme belongs because the page reads it at
boot. `after` runs once there is a document, for opening a panel or focusing a
field. Each state's setup is removed before the next one, so they cannot leak.

**A foreground composites over its own background. An edge measures against
what is outside it.** Those are different questions. Text sits on the thing
behind it, so its own background belongs in the stack. A border is a boundary,
and 1.4.11 asks whether that boundary can be told apart from what is adjacent
to it, which is the page rather than the control's own fill. A solid button
that sets its border to its own background colour measures 1.00:1 the first
way and 14.68:1 the second, and only one of those is the edge anybody sees.
Border properties are handled this way for you.

Use `againstParent` when the thing being measured is a fill rather than a
foreground. A selected row with its own background measured against itself
scores 1.00, which is a pass that means nothing.

A selector that matches nothing is a failure. So is a border colour on an edge
with no width: you asked for the contrast of something that is not being drawn,
and the question is wrong rather than the answer being zero.

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

### Letting an agent carry the call

A shell command is one way to reach a model and a poor one for an agent, which
is already a model and can spawn a genuinely fresh context of its own instead
of shelling out to a second copy of itself. So the judge splits in two:

```bash
taste-check judge --emit              # the prompt, and nothing else happens
taste-check judge --verdict reply.json  # or - for stdin
```

`--emit` prints the prompt and stops. It still refuses when there are no
screenshots or no checklist, because a prompt for nothing gets a confident
verdict about nothing. `--verdict` checks the reply against the checklist
exactly as the shell route does: every line answered once, no invented lines,
valid verdicts. Taking the agent route does not buy a softer grading.

`judge.command` is optional when you use this. There is a skill for it:

```bash
taste-check judge --skill    # prints the path to SKILL.md
```

Copy it wherever your agent keeps skills. It carries the mechanism, which is
that the agent must not be the judge: it is reading the session that built the
thing, and the reasoning that justified each choice is still sitting there
ready to justify it again. It carries no design rules, for the same reason
nothing else here does.

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
| `judge.command` | The model command. Prompt on stdin, image paths as arguments. Optional if an agent carries the call. |
| `judge.failOn` | `"never"` (default) or `"fail"`. Whether a verdict blocks. |
| `runtime.url` | The page to measure. A `file://` URL works. |
| `runtime.endpoint` | An existing CDP endpoint. Given one, taste-check connects rather than launching, and never closes a browser it did not start. |
| `runtime.browserPath` | Path to a Chromium. Falls back to `CHROME_PATH`, then the usual locations. |
| `runtime.states[]` | `before` runs ahead of the page's scripts, `after` once loaded, `waitFor` is a selector. |
| `runtime.targets[]` | `selector`, `prop`, `min`, and `againstParent` when measuring a fill. |

```
taste-check [options]         Run the deterministic checks over your files
taste-check runtime [options] Measure contrast on a rendered page
taste-check judge [options]   Ask a fresh-eyes judge about your screenshots

  -c, --config <path>   Config file (default: tastecheck.config.json)
      --only <name>     Run one check: contrast or treatments
      --format <kind>   text (default), json, or sarif
      --json            Alias for --format json
      --version         Print the version
```

Exit code is 1 if any check fails, 0 if every check ran and passed. The judge
plays by the rules in its own section above.

## SARIF

```bash
taste-check --format sarif > taste-check.sarif
```

Works on any of the three commands, and drops findings into a code scanning tab
instead of a log nobody opens.

```yaml
- run: npx taste-check --format sarif > taste-check.sarif
  continue-on-error: true
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: taste-check.sarif
```

`continue-on-error` because the step exits 1 when something fails, and you
still want the findings uploaded when it does.

Two things make this worth having over a log.

**Every finding points at the line you would edit.** A class points at the
markup. A contrast failure points at the line in your token file where the
foreground is declared, which is the half of a pair you usually end up moving.
A judge verdict points at the line in your checklist. Findings with no file
behind them, like a browser that would not start, point at the config, because
that is where the rule was written.

**Fingerprints are keyed to the content of the line, not its number.** Add an
import at the top of a file and every finding below it stays the same alert
rather than closing and reopening as a new one. Without that a code scanning
tab fills with churn and people stop reading it.

Levels follow the same rule the exit code does. Everything that gates the build
is an `error`. A judge verdict is a `note`, or a `warning` if you set
`failOn`, because it is an opinion either way.

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

**YAML configs**, once there is a reason to take on a parser.

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
