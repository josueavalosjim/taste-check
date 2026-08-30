# taste-check

Two deterministic checks for a design system you already have. It computes WCAG
contrast ratios from your own custom properties, and flags class names and
literal values that are not on your own approved list.

It has no opinion about which colours you use or which classes are allowed.
You supply both.

```bash
npx @josueavalosjim/taste-check --config tastecheck.config.json
```

Installed as a dependency, the command is just `taste-check`:

```bash
npm i -D @josueavalosjim/taste-check
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

Zero runtime dependencies. Node 22 or newer.

## Why this exists

Most quality tooling checks compliance and has no point of view. axe tells you
an element fails 4.5:1. It cannot tell you that your borders answer to 3:1
while your captions answer to 4.5:1, because that distinction is yours, not the
spec's.

Design systems drift in a specific way: a value gets hardcoded because the
token did not quite fit, a class gets invented because nobody knew the approved
one existed. Written rules do not stop it. A rule in a stylesheet comment is
enforced by people re-reading stylesheets, and nobody re-reads a stylesheet
while writing markup. So the rules get a check that runs instead.

## What counts as a failure

Each of these exits 1 rather than passing quietly:

- a pair naming a token that does not exist
- a file pattern matching no files
- a theme whose scopes resolve no tokens
- a colour value the parser does not understand
- an unknown key in the config, which is usually a typo doing nothing

A check that cannot fail is worse than no check, because it goes green and gets
quoted as evidence.

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
for equal specificity. Declarations inside an at-rule are ignored unless a
scope opts in:

```json
{ "name": "dark-system", "scopes": [":root", { "selector": ":root", "atRule": "prefers-color-scheme: dark" }] }
```

Without that rule a `@media (prefers-color-scheme: dark)` block containing
`:root` would overwrite the light theme, and the light checks would silently
measure against colours the light theme never paints.

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

```
taste-check [options]

  -c, --config <path>   Config file (default: tastecheck.config.json)
      --only <name>     Run one check: contrast or treatments
      --json            Machine-readable output
      --version         Print the version
```

Exit code is 1 if any check fails, 0 if every check ran and passed.

## What this does not do

Read this before trusting a green run.

**It reads tokens, not a rendered page.** This is the real limit. The check it
was ported from ran in a browser and read colours off `getComputedStyle`,
because a token file cannot tell you what is actually painted behind an
element. An overlay, an ancestor background or a colour set inline by a
component are all invisible here. What this gives you is that the
values in your token file relate to each other the way you said they should. It
does not prove what a visitor sees.

**Only some colour formats parse.** Hex in 3, 4, 6 and 8 digits, `rgb()` and
`rgba()` in both the comma and the space syntax, and `white` / `black` /
`transparent`. `hsl()`, `oklch()` and `color-mix()` are not parsed yet, and a
value it cannot parse is a failure rather than a skip, so you will hear about
it immediately.

**There is no specificity resolution.** Scopes apply in the order you list
them. If your tokens rely on `.a.b` beating `.b`, list the scopes in the order
you want.

**Component indirection is invisible.** Classes applied by a helper
function, a `clsx` call importing names from elsewhere, or CSS-in-JS are
invisible to it.

## Future directions

Not built. Written down so the shape is clear.

**A fresh-eyes checklist hook.** The deterministic checks here cover what can
be measured. The judgment half of design review cannot be, and the useful
pattern for it is a fresh context: a separate model call that sees a screenshot
and a checklist, and nothing else. Judging in the same context that produced
the work is unreliable, because the reasoning that justified a choice is still
sitting there to justify it again. The plan is a plugin hook that takes your
screenshot command and your checklist file and reports back in the same format
as the checks above. The checklist stays yours: a shipped one would just be
somebody else's taste.

**A runtime mode**, closing the gap named above by measuring `getComputedStyle`
in a real browser, as an optional peer dependency so the core stays free of one.

**YAML configs**, once there is a reason to take on a parser.

**More colour formats**, `hsl()` first.

## Development

```bash
npm test
```

34 tests. Most of them plant a violation into a fixture that was passing a
moment earlier and demand it gets caught: a token darkened below its floor, an
unapproved class added to a clean file, a class buried in a template literal
hole, a file pattern pointed at nothing.

## License

MIT
