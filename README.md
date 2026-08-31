# taste-check

Design review in CI, with a line down the middle of it.

Some of design review is measurable. Contrast ratios, values that should have
been tokens, tokens that were never real, class names nobody approved.
taste-check measures those and fails your build on them, either from your token
file or from a page it renders in a real browser.

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

tokens FAILED
  FAIL  src/Promo.jsx:8 "--color-primary-500" is referenced here but declared in no token file. Check the name, or add it to allow.
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

It also enforces no rule it wrote. Not a palette, not a class list, not a
contrast floor. It will scaffold you a starter checklist, and that file lands
in your repo: what runs is the copy you edited, never its own.

## What counts as a failure

Each of these exits 1 rather than passing quietly:

- a pair naming a token that does not exist
- markup referencing a token that is declared nowhere
- a file pattern matching no files
- a token file that declares no custom properties at all
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

## The tokens check

Give it the stylesheet that declares your tokens and the markup that uses them.
It reports every `var(--x)` in your markup where `--x` is declared nowhere.

```json
{
  "tokens": {
    "declaredIn": ["src/styles/tokens.css"],
    "files": ["src/**/*.jsx"],
    "allow": ["--scroll-progress"],
    "allowPrefixes": ["--radix-"]
  }
}
```

The failure it is built for is a token name that was never real:
`var(--color-primary-500)` in a system that says `--brand-action-bg`. A name
like that is not a typo. It is what gets written when the code is produced
without the token file open, which is most of what a model does, and it looks
correct in review because it looks like a token.

**It scans markup, not stylesheets, and that is deliberate.** See
[where it sits](#where-it-sits-next-to-other-tools). Stylelint already owns the
CSS side and does it better.

For markup the scan is the whole file rather than the tags, because `var(--`
means one thing everywhere it appears. So a reference in an object declared
above the `return`, in a styled-components template, or in a constant in
another module is found, and nesting comes free: both names in
`var(--a, var(--b))` are checked, not only the outer one.

`allow` and `allowPrefixes` are the escape hatch, and you will need them. A
custom property set from JavaScript with `setProperty`, or one owned by a
library's stylesheet, is legitimately absent from your token file.

Two things it does not treat as failures. A bare `--x` written where you meant
`var(--x)` is stylelint's `custom-property-no-missing-var-function`, not this.
And a run that finds no references at all is reported in the summary rather
than failed, because a codebase that keeps its styling in stylesheets has none
and is not broken:

```
tokens ok, 1 token file, 84 declared, 41 files scanned, 0 references
```

If that zero is a surprise, your `files` pattern is pointed at the wrong tree.
A pattern matching no files at all is a failure, as everywhere else here.

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

The checklist is yours, and there is a test asserting the framing mentions no
design vocabulary at all, because a rule that arrives at the moment of judgment
carries the tool's authority rather than its author's. Checklist lines are list
items in your file; a heading or a paragraph is prose and is not judged.

Starting from nothing is its own problem, so there is a scaffold and a linter
for the lines you write. Both are in the next section.

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

## Starting a checklist

An empty file is the hardest part of the judge, so:

```bash
taste-check checklist --new
```

It writes a starter into your repo. Six lines, and every one is about whether
the screen is broken rather than whether it is good, because that is the only
kind of line that is not somebody's taste. It refuses to overwrite a file that
exists, since the moment it lands it is yours.

That is a scaffold and not a default, and the difference is the whole reason it
is allowed to exist here. A default judges every user who never opened the file
against opinions they did not choose. A scaffold is a file you edited and
committed, and taste-check never reads its own copy. eslint is the same shape:
it ships rules and no default configuration, and `--init` writes you one.

```bash
taste-check checklist --lint
```

This checks your lines and never their content. It has no opinion about what
you ask for, only about whether asking it produces a verdict:

```
checklist, 3 to look at
  unfalsifiable   design-checklist.md:12  "Does it feel premium and modern"
                  "premium", "modern", "feel" describes a feeling rather than
                  something visible. A judge answers unsure, every run.
  not-in-a-still  design-checklist.md:13  "Is the hover animation smooth"
                  "animation", "hover" cannot be seen in a screenshot.
  measurable      design-checklist.md:14  "Body copy hits at least 4.5:1"
                  this asks for a number. Put it in a contrast pair instead.
```

It also flags a line asking two things at once, since one verdict cannot answer
both. "The primary action reads as the primary action" passes: it is an opinion,
a strong one, and none of the linter's business, because it can be settled by
looking.

## Config

Point your editor at `schema/config.schema.json` for completion and inline
docs. Paths inside a config resolve against the config file, so it can be run
from anywhere.

Unknown keys are rejected, because a misspelled key that silently does nothing
is a config that looks like it is working. `$comment` is the exception: it is
allowed wherever an object is, ignored, and takes a string or an array of them.
A config you are expected to live with for years should let you write down why
it is the way it is.

```json
{
  "$comment": "Guards the ramp itself. The browser suite only covers tokens some selector reaches.",
  "contrast": {
    "pairs": [
      { "$comment": "Documented at 6.13:1 in tokens.css.", "fg": "--ink-muted", "bg": "--bg", "min": 4.5 }
    ]
  }
}
```

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
| `tokens.declaredIn` | Stylesheets declaring the tokens. Every custom property in them counts, in any scope. |
| `tokens.files` | Markup to scan for `var()` references. |
| `tokens.allow` | Names that need no declaration, for ones set from JavaScript. Must start with `--`. |
| `tokens.allowPrefixes` | Name prefixes that are always allowed, for a family a library owns. |
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
      --only <name>     Run one check: contrast, treatments or tokens
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

**stylelint for tokens in CSS specifically.** Its core
`no-unknown-custom-properties` reports a `var()` naming a custom property
nothing declares, and its `referenceFiles` option covers the case that matters,
where the tokens live in one file and the uses live in another. That is the
same check taste-check runs, done first-party, so run stylelint on your
stylesheets. taste-check only scans markup, where stylelint does not go: its
CSS-in-JS syntax is deprecated, and a `style={{ color: open ? 'var(--a)' :
'var(--b)' }}` prop is a JavaScript object literal that no CSS parser reads at
all.

**@lapidist/design-lint.** More thorough than taste-check on the token and
component side: it parses properly rather than scanning, knows about
frameworks, autofixes, and manages deprecations. If enforcing tokens in code is
the whole of your problem, it is the better fit.

**Checklist Design and similar agent skills.** They arrive with a hundred or
more published checklists and review conversationally. If you want good
opinions supplied, take theirs, and they are good. taste-check scaffolds six
lines about whether a screen is broken and expects the rest to be yours, which
is more work and a different bargain.

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

**Not every colour format parses.** What does: hex in 3, 4, 6 and 8 digits;
`rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, `oklch()`, `oklab()`, `lab()`
and `lch()`; and `white` / `black` / `transparent`. `color-mix()` and
`color()` do not. A value it cannot parse fails, so you hear about it
immediately.

An `oklch()` outside the sRGB gamut is clipped rather than gamut-mapped, which
is what a browser canvas does with it. That was checked rather than assumed:
the test corpus has fifty deliberately out-of-gamut colours painted in a real
browser and read back as pixels, and the parser agrees with all of them to
within one channel unit.

**There is no specificity resolution.** Scopes apply in the order you list
them. If your tokens rely on `.a.b` beating `.b`, list the scopes in the order
you want.

**It does not lint your stylesheets.** The tokens check reads your CSS to learn
what is declared and then never looks at it again. A `var()` in a `.css` file
naming nothing is not reported here. That is stylelint's
`no-unknown-custom-properties`, named above.

**Component indirection is invisible.** Classes applied by a helper
function, a `clsx` call importing names from elsewhere, or CSS-in-JS are
invisible to it.

## Future directions

Not built. Written down so the shape is clear.

**YAML configs**, once there is a reason to take on a parser.

**`color-mix()` and `color()`**, which are a different shape of problem: one
needs an interpolation model and the other a colour space argument, so neither
is another conversion function.

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

171 tests. Most of them plant a violation into a fixture that was passing a
moment earlier and demand it gets caught: a token darkened below its floor, an
unapproved class added to a clean file, a class buried in a template literal
hole, a fabricated token hidden in a ternary, a file pattern pointed at
nothing.

## License

MIT
