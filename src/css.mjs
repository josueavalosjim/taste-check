/**
 * Custom-property extraction from a stylesheet, and theme resolution.
 *
 * This is not a CSS parser. It is a walker that tracks brace depth and quote
 * state well enough to answer one question: for a given theme, what is the
 * final value of each `--token`? The same reasoning applies here as in the
 * markup scanner: a regex over a stylesheet looks like it works right up until
 * a value contains a brace or a selector contains a quote, and a check that
 * silently stops seeing declarations is worse than no check at all.
 *
 * The cascade model is deliberately small and written down rather than
 * implied. Scopes are applied in the order the config lists them and the last
 * declaration wins. There is no specificity resolution: if your token file
 * relies on `.a.b` beating `.b`, list the scopes in the order you want them
 * applied and the result is the one you asked for.
 *
 * Declarations inside an at-rule are ignored unless a scope opts into that
 * at-rule by name. Without that rule, a `@media (prefers-color-scheme: dark)`
 * block containing `:root` would silently overwrite the light theme, and the
 * light theme would be checked against colours it never paints.
 */

/** Blank out comments, keeping every offset and newline so lines stay true. */
function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

const normalize = (selector) => selector.replace(/\s+/g, ' ').replace(/'/g, '"').trim();

/**
 * Every custom-property declaration in the source, with the selector it sits
 * under and the at-rules it is nested inside.
 */
export function parseDeclarations(css) {
  const source = blankComments(css);
  const decls = [];
  const stack = [];
  let buffer = '';
  let bufferStart = 0;
  let quote = null;

  const flush = (end) => {
    const text = buffer.trim();
    buffer = '';
    if (!text) return;
    const colon = text.indexOf(':');
    if (colon === -1) return;
    const prop = text.slice(0, colon).trim();
    if (!prop.startsWith('--')) return;
    const selector = [...stack].reverse().find((s) => !s.startsWith('@')) ?? '';
    decls.push({
      prop,
      value: text.slice(colon + 1).trim(),
      selector,
      atRules: stack.filter((s) => s.startsWith('@')),
      index: bufferStart + (source.slice(bufferStart, end).length - source.slice(bufferStart, end).trimStart().length),
    });
  };

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      buffer += c;
      if (c === '\\') {
        buffer += source[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buffer += c;
      continue;
    }
    if (c === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '));
      buffer = '';
      bufferStart = i + 1;
      continue;
    }
    if (c === '}') {
      flush(i);
      stack.pop();
      bufferStart = i + 1;
      continue;
    }
    if (c === ';') {
      flush(i);
      bufferStart = i + 1;
      continue;
    }
    if (!buffer) bufferStart = i;
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
export function resolveScopes(decls, scopes) {
  const table = new Map();
  for (const scope of scopes) {
    const selector = typeof scope === 'string' ? scope : scope.selector;
    const atRule = typeof scope === 'string' ? null : (scope.atRule ?? null);
    for (const d of decls) {
      if (!selectorMatches(d.selector, selector)) continue;
      if (atRule === null) {
        if (d.atRules.length) continue;
      } else if (!d.atRules.some((a) => a.includes(atRule))) continue;
      table.set(d.prop, d);
    }
  }
  return table;
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
