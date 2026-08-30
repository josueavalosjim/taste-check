# Changelog

## 0.1.0

First release. Two checks, both driven entirely by config.

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
