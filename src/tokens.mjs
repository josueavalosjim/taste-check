/**
 * The undefined-token check: every `var(--x)` in markup, against the tokens
 * the system actually declares.
 *
 * ── Why markup and not stylesheets ──────────────────────────────────────
 *
 * Stylelint's core `no-unknown-custom-properties` already does this for CSS,
 * and its `referenceFiles` option covers the case that matters, where tokens
 * are declared in one file and consumed in another. Rebuilding that would be
 * a worse copy of a first-party rule.
 *
 * What nothing covers is markup. Stylelint's CSS-in-JS syntax is deprecated,
 * and `style={{ color: open ? 'var(--a)' : 'var(--b)' }}` is not CSS-in-JS
 * anyway: it is a JavaScript object literal that no CSS parser reads. That is
 * the gap, and it is the one a model writing plausible off-system code falls
 * into, reaching for `--color-primary-500` when the system says `--brand-ink`.
 *
 * ── Why a plain scan and not the tag walker ─────────────────────────────
 *
 * `treatments.mjs` walks tags because a class name is only a class name in an
 * attribute, and a bare word elsewhere is noise. `var(--` is not like that.
 * The string is unambiguous wherever it appears, so scanning the whole file
 * costs nothing in false positives and picks up references the tag walker
 * cannot see: a styled-components template, an object of styles declared above
 * the return, a constant in a helper module.
 *
 * Nesting comes free. `var(--a, var(--b))` matches twice, so both names are
 * checked rather than only the outer one.
 */
import { readFileSync } from 'node:fs';
import { lineAt, parseDeclarations } from './css.mjs';
import { expandEach, label } from './files.mjs';

/**
 * The name is `[\w-]+` for the same reason `resolveValue` in css.mjs uses it:
 * escapes and non-ASCII in a custom property name are legal and vanishingly
 * rare, and inventing a fuller grammar here would only disagree with the
 * resolver next door.
 */
const VAR_REF = /var\(\s*(--[\w-]+)\s*(,?)/g;

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Every custom property referenced through `var()`, with the offset of the
 * name and whether the reference carries a fallback.
 *
 * A bare `--x` written outside a `var()` is deliberately not a reference. That
 * is a different mistake, and stylelint's `custom-property-no-missing-var-function`
 * is the rule for it.
 */
export function varRefs(source) {
  const found = [];
  for (const m of source.matchAll(VAR_REF)) {
    found.push({ name: m[1], index: m.index + m[0].indexOf(m[1]), fallback: m[2] === ',' });
  }
  return found;
}

/** Every custom property name declared anywhere in the token files. */
function declaredNames(files) {
  const names = new Set();
  for (const file of files) {
    for (const decl of parseDeclarations(readFileSync(file, 'utf8'))) names.add(decl.prop);
  }
  return names;
}

export function runTokens(config, cwd) {
  const failures = [];
  const problems = [];
  const { declaredIn, files: patterns, allow = [], allowPrefixes = [] } = config;

  const quoted = (list) => list.map((p) => `"${p}"`).join(', ');
  const declared_ = expandEach(declaredIn, cwd);
  const scanned_ = expandEach(patterns, cwd);
  const tokenFiles = declared_.files;
  const files = scanned_.files;

  /* Per pattern, not per list. A list is a union, so one dead pattern beside
     a live one leaves the union non-empty and that tree stops being checked
     in silence. */
  for (const p of declared_.empty) problems.push(`no token files matched "${p}"`);
  for (const p of scanned_.empty) problems.push(`no markup files matched "${p}"`);
  if (!tokenFiles.length && !declared_.empty.length) problems.push(`no token files matched ${quoted(declaredIn)}`);
  const declared = declaredNames(tokenFiles);
  if (tokenFiles.length && !declared.size) {
    problems.push(
      `${count(tokenFiles.length, 'token file')} matched ${quoted(declaredIn)}, ` +
        `but none of them declares a custom property. Every reference would read as undefined.`,
    );
  }
  if (!files.length && !scanned_.empty.length) problems.push(`no markup files matched ${quoted(patterns)}`);

  // Without a trustworthy declared set there is nothing to compare against,
  // and reporting every reference in the codebase as undefined would bury the
  // one line that says why.
  if (problems.length) return { name: 'tokens', failures, problems, summary: '' };

  const allowed = new Set(allow);
  let references = 0;

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const { name, index, fallback } of varRefs(source)) {
      references += 1;
      if (declared.has(name)) continue;
      if (allowed.has(name)) continue;
      if (allowPrefixes.some((p) => name.startsWith(p))) continue;
      failures.push({
        rule: 'tokens/undefined',
        file: label(file, cwd),
        line: lineAt(source, index),
        subject: name,
        message:
          `"${name}" is referenced here but declared in no token file.` +
          (fallback ? ' It has a fallback, so it degrades rather than breaks.' : '') +
          ' Check the name, or add it to allow.',
      });
    }
  }

  // `references` is in the summary rather than a failure on purpose. A zero
  // can mean a glob pointing at the wrong tree, but it can equally mean a
  // codebase that keeps its styling in stylesheets, which is not a fault. The
  // wrong-glob case that can be told apart is the one above: no files matched.
  return {
    name: 'tokens',
    failures,
    problems,
    summary:
      `${count(tokenFiles.length, 'token file')}, ${declared.size} declared, ` +
      `${count(files.length, 'file')} scanned, ${count(references, 'reference')}`,
  };
}
