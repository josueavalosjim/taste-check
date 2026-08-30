/**
 * The one-off value linter: class names and literal values, against a list you
 * supply.
 *
 * ── Why the parsing is a scanner and not one regex ──────────────────────
 *
 * The obvious implementation is `/<a\b[^>]*?className="([^"]*)"[^>]*?>/`, and
 * it catches almost nothing while looking like a pass:
 *
 *   - `[^>]*` cannot cross an `onClick={() => x}`. It terminates on the
 *     arrow's own ">", and the tag is silently skipped.
 *   - A className built as an expression is not a quoted string at all, so
 *     half the components in a typical codebase are invisible to it.
 *   - `title="a > b"` ends the tag early for the same reason as the arrow.
 *
 * So the tag span is found by walking the source with quote and brace depth
 * tracked, and class names are collected from every string literal inside a
 * className expression. A ternary contributes both of its branches on
 * purpose: the question is whether a class can appear at all, and a false
 * positive is a conversation while a false negative is the bug shipping.
 */
import { readFileSync } from 'node:fs';
import { expand, label } from './files.mjs';

/** Literal value shapes worth flagging when they are not on the list. */
const VALUE_SHAPES = [
  /#[0-9a-fA-F]{3,8}\b/g,
  /\b(?:rgba?|hsla?)\([^)]*\)/g,
  /(?<![\w-])\d*\.?\d+(?:px|rem|em|vh|vw|vmin|vmax|pt|ch|ex)\b/g,
];

const ANY_ELEMENT = '[A-Za-z][A-Za-z0-9.:_-]*';

/**
 * Every opening tag for the named elements, with its attribute text and the
 * offset that text starts at. Walks rather than matches so quotes and braces
 * nest correctly.
 */
export function* openTags(source, names) {
  const pattern = names.includes('*') ? ANY_ELEMENT : `(?:${names.join('|')})`;
  const opener = new RegExp(`<(${pattern})(?=[\\s/>])`, 'g');
  for (const m of source.matchAll(opener)) {
    const start = m.index + m[0].length;
    let i = start;
    let depth = 0;
    let quote = null;
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (quote) {
        if (c === '\\') i += 1;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    yield { name: m[1], attrs: source.slice(start, i), start, index: m.index };
  }
}

/** The value of `attr` when it is a plain string literal, else null. */
export function literalAttr(attrs, attr) {
  const m = attrs.match(new RegExp(`(?:^|\\s)${attr}\\s*=\\s*"([^"]*)"`));
  return m ? { text: m[1], at: m.index + m[0].indexOf('"') + 1 } : null;
}

/** The braced expression for `attr`, brace-balanced, or null. */
export function expressionAttr(attrs, attr) {
  const at = attrs.search(new RegExp(`(?:^|\\s)${attr}\\s*=\\s*\\{`));
  if (at === -1) return null;
  let i = attrs.indexOf('{', at);
  const start = i;
  let depth = 0;
  let quote = null;
  for (; i < attrs.length; i += 1) {
    const c = attrs[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth += 1;
    else if (c === '}' && --depth === 0) return { text: attrs.slice(start + 1, i), at: start + 1 };
  }
  return null;
}

/**
 * Every string literal inside an expression, with its offset in the source.
 *
 * A walker rather than a regex, for the same reason the tag scanner is one.
 * The interesting case is a template literal: the text around a `${...}` hole
 * is literal class names, the hole itself is not, but the hole very often
 * *contains* more literals. Blanking the hole loses them, and a class name
 * that the checker cannot see is a class name that ships unapproved. So the
 * hole is recursed into instead, with brace depth tracked so a nested object
 * or a nested template does not end it early.
 */
function scanLiterals(text, base, out) {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out.push({ raw: text.slice(i + 1, j), at: base + i + 1 });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let segment = j;
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '$' && text[j + 1] === '{') {
          out.push({ raw: text.slice(segment, j), at: base + segment });
          let depth = 1;
          let k = j + 2;
          for (; k < text.length && depth > 0; k += 1) {
            if (text[k] === '{') depth += 1;
            else if (text[k] === '}') depth -= 1;
          }
          scanLiterals(text.slice(j + 2, k - 1), base + j + 2, out);
          j = k;
          segment = j;
          continue;
        }
        j += 1;
      }
      out.push({ raw: text.slice(segment, j), at: base + segment });
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Every class name the element can possibly carry.
 *
 * For an expression we take the union of every string literal inside it
 * rather than trying to evaluate it. A ternary contributes both of its
 * branches on purpose: the question is whether a class can appear at all.
 */
export function classesOf(attrs) {
  const found = [];
  const collect = (text, base) => {
    for (const m of text.matchAll(/\S+/g)) found.push({ name: m[0], at: base + m.index });
  };

  const literal = literalAttr(attrs, 'className') ?? literalAttr(attrs, 'class');
  if (literal) {
    collect(literal.text, literal.at);
    return found;
  }

  const expr = expressionAttr(attrs, 'className') ?? expressionAttr(attrs, 'class');
  if (!expr) return found;
  for (const { raw, at } of scanLiterals(expr.text, expr.at, [])) collect(raw, at);
  return found;
}

/** Literal colours and lengths inside a style attribute. */
function inlineValues(attrs) {
  const style = literalAttr(attrs, 'style') ?? expressionAttr(attrs, 'style');
  if (!style) return [];
  const found = [];
  for (const shape of VALUE_SHAPES) {
    for (const m of style.text.matchAll(shape)) found.push({ text: m[0], at: style.at + m.index });
  }
  return found;
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

export function runTreatments(config, cwd) {
  const failures = [];
  const problems = [];
  const {
    files: patterns,
    elements = ['*'],
    approvedClasses = [],
    allowPrefixes = [],
    approvedValues = [],
  } = config;

  const files = expand(patterns, cwd);
  if (!files.length) {
    problems.push(`no markup files matched ${patterns.map((p) => `"${p}"`).join(', ')}`);
    return { name: 'treatments', failures, problems, summary: '' };
  }

  const approved = new Set(approvedClasses);
  const allowedValues = new Set(approvedValues.map((v) => v.toLowerCase()));

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const where = (at) => ({ file: label(file, cwd), line: lineOf(source, at) });

    for (const tag of openTags(source, elements)) {
      for (const { name, at } of classesOf(tag.attrs)) {
        if (approved.has(name)) continue;
        if (allowPrefixes.some((p) => name.startsWith(p))) continue;
        failures.push({
          rule: 'treatments/unapproved-class',
          ...where(tag.start + at),
          subject: name,
          message: `class "${name}" on <${tag.name}> is not approved`,
        });
      }
      for (const { text, at } of inlineValues(tag.attrs)) {
        if (allowedValues.has(text.toLowerCase())) continue;
        failures.push({
          rule: 'treatments/one-off-value',
          ...where(tag.start + at),
          subject: text,
          message:
            `inline value "${text}" on <${tag.name}> is a one-off. ` +
            `Use a token, or add it to approvedValues.`,
        });
      }
    }
  }

  return {
    name: 'treatments',
    failures,
    problems,
    summary: `${files.length} ${files.length === 1 ? 'file' : 'files'} scanned`,
  };
}
