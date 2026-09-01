/**
 * Custom-property extraction from a stylesheet, and theme resolution.
 *
 * This is not a CSS parser. It is a walker that tracks brace depth and quote
 * state well enough to answer one question: for a given theme, what is the
 * final value of each `--token`? A regex over a stylesheet works right up
 * until a value contains a brace or a selector contains a quote, at which
 * point it stops seeing declarations and reports the file as fine.
 *
 * The cascade model is deliberately small and written down rather than
 * implied. Scopes are applied in the order the config lists them and the last
 * declaration wins. There is no specificity resolution: if your token file
 * relies on `.a.b` beating `.b`, list the scopes in the order you want them
 * applied and the result is the one you asked for.
 *
 * At-rules split into two kinds, and they are treated differently because
 * they mean different things.
 *
 * A CONDITIONAL at-rule (`@media`, `@supports`, `@container`, `@scope`) only
 * applies when its condition holds, so its declarations are ignored unless a
 * scope opts into it by name. Without that, a
 * `@media (prefers-color-scheme: dark)` block containing `:root` would
 * overwrite the light theme, and light would be checked against colours it
 * never paints.
 *
 * A GROUPING at-rule, `@layer` above all, always applies. It changes cascade
 * priority, not whether the declarations exist. So it is transparent here: a
 * `:root` inside `@layer tokens` resolves exactly as a top-level `:root`
 * would. A scope can still name a layer to narrow to it, but nobody should
 * have to write that just to see their own tokens.
 *
 * Layer order is not modelled. Within the scopes a theme lists, the last
 * declaration still wins, same as everywhere else here.
 */

/**
 * At-rules whose contents are conditional, and so must be opted into.
 * Anything else wrapping a rule is grouping, and is looked straight through.
 */
const CONDITIONAL = /^@(media|supports|container|scope|document)\b/;

const normalize = (selector) => selector.replace(/\s+/g, ' ').replace(/'/g, '"').trim();

/**
 * Every custom-property declaration in the source, with the selector it sits
 * under and the at-rules it is nested inside.
 */
export function parseDeclarations(css) {
  const source = css;
  const decls = [];
  const stack = [];
  let buffer = '';
  let bufferStart = 0;
  /* Offset of the first non-whitespace character in the buffer, recorded as
     it is read rather than derived afterwards by trimming. Deriving it worked
     only while comments were blanked to spaces up front: once they are stepped
     over instead, the source still holds the comment text, so trimming stops
     at the "/" and every declaration under a comment reported the comment's
     line as its own. */
  let ink = -1;
  let quote = null;

  const flush = () => {
    const text = buffer.trim();
    buffer = '';
    const at = ink;
    ink = -1;
    if (!text) return;
    const colon = text.indexOf(':');
    if (colon === -1) return;
    const prop = text.slice(0, colon).trim();
    if (!prop.startsWith('--')) return;
    // !important is cascade information, not part of the value. A browser
    // strips it before anyone reads the property back, and leaving it on
    // would hand "#111 !important" to the colour parser as if it were a
    // colour. Found by diffing this parser against a real CSSOM.
    const value = text.slice(colon + 1).trim().replace(/\s*!\s*important\s*$/i, '').trim();
    const selector = [...stack].reverse().find((s) => !s.startsWith('@')) ?? '';
    decls.push({
      prop,
      value,
      selector,
      atRules: stack.filter((s) => s.startsWith('@')),
      index: at === -1 ? bufferStart : at,
    });
  };

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (ink === -1) ink = i;
      buffer += c;
      if (c === '\\') {
        buffer += source[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    /* Comments are skipped here rather than blanked before the walk.
       Blanking first cannot see quotes, so a "/*" inside one string value and
       a "*\/" inside another erased every declaration between them. A theme
       override lost that way does not fail: resolveScopes falls back to the
       base value and the dark theme gets measured against light numbers, which
       is the exact miss this file exists to catch. Offsets stay true because
       nothing is rewritten, only stepped over. */
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*\/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      if (ink === -1) ink = i;
      buffer += c;
      continue;
    }
    if (c === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '));
      buffer = '';
      ink = -1;
      bufferStart = i + 1;
      continue;
    }
    if (c === '}') {
      flush();
      stack.pop();
      bufferStart = i + 1;
      continue;
    }
    if (c === ';') {
      flush();
      bufferStart = i + 1;
      continue;
    }
    if (!buffer) bufferStart = i;
    if (ink === -1 && c.trim()) ink = i;
    buffer += c;
  }
  return decls;
}

/** Does a declaration's selector list contain this exact scope selector? */
function selectorMatches(list, scope) {
  const want = normalize(scope);
  return list.split(',').some((part) => normalize(part) === want);
}

/**
 * The token table for one theme: a Map of `--name` to { value, selector }.
 * Scopes are applied in order, later winning.
 */
/** The declarations one scope selects, in source order. */
function declsForScope(decls, scope) {
  const selector = typeof scope === 'string' ? scope : scope.selector;
  const atRule = typeof scope === 'string' ? null : (scope.atRule ?? null);
  return decls.filter((d) => {
    if (!selectorMatches(d.selector, selector)) return false;
    if (atRule === null) {
      // Only a conditional wrapper hides a declaration by default. A grouping
      // one like @layer does not.
      return !d.atRules.some((a) => CONDITIONAL.test(a));
    }
    return d.atRules.some((a) => a.includes(atRule));
  });
}

export function resolveScopes(decls, scopes) {
  const table = new Map();
  for (const scope of scopes) {
    for (const d of declsForScope(decls, scope)) table.set(d.prop, d);
  }
  return table;
}

/**
 * The scopes in a theme that selected nothing at all.
 *
 * A theme can resolve plenty of tokens while one of its scopes is quietly
 * dead: write `[data-theme="dark"]` when the stylesheet says
 * `:root[data-theme="dark"]` and the base scope still fills the table, so the
 * dark theme gets measured against the light values and reports a pass. The
 * numbers look right, they are just the wrong theme's numbers.
 */
export function unmatchedScopes(decls, scopes) {
  return scopes.filter((scope) => declsForScope(decls, scope).length === 0);
}

/**
 * Follow `var(--other)` indirection to a concrete value.
 *
 * A cycle, or a var() pointing at a token this theme does not define, returns
 * an error rather than the unresolved text: an unresolved value would reach
 * the colour parser and fail there with a worse message.
 */
export function resolveValue(table, name, seen = new Set()) {
  if (seen.has(name)) {
    return { ok: false, reason: `${name} resolves in a circle (${[...seen, name].join(' -> ')})` };
  }
  const decl = table.get(name);
  if (!decl) return { ok: false, reason: `${name} is not defined in this theme` };

  const match = decl.value.match(/^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/);
  if (!match) return { ok: true, value: decl.value, decl };

  const target = match[1];
  const fallback = match[2]?.trim();
  const next = resolveValue(table, target, new Set([...seen, name]));
  if (next.ok) return next;
  if (fallback) return { ok: true, value: fallback, decl };
  return { ok: false, reason: `${name} points at ${target}, which ${next.reason.replace(/^.*? /, '')}` };
}

/** 1-indexed line of a source offset, for error messages. */
export const lineAt = (source, index) => source.slice(0, index).split('\n').length;
