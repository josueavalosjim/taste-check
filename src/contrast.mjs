/**
 * WCAG contrast, measured over your own tokens.
 *
 * The technique this ports was originally a Playwright test that read colours
 * off a running page with getComputedStyle, for a good reason: a token file
 * cannot tell you what is actually painted behind an element. That check
 * existed because a comment in a stylesheet claimed a grey "clears 4.5:1 on
 * white" while the page shipped on an off-white, and nothing re-checked it.
 * The value passed by a fifth of a point, by memory, with no test to say so
 * when the background moved.
 *
 * This module is the static half of that idea: it re-derives the ratio from
 * the tokens, which is exactly what the original warned against, and is the
 * honest trade for a tool that runs anywhere with no browser. What it keeps is
 * the arithmetic, the alpha compositing, and the rule that a pair naming a
 * token which does not exist is a failure rather than a skip. See "What this
 * does not do" in the README before trusting a pass.
 */
import { readFileSync } from 'node:fs';
import { contrastRatio, isOpaque, parseColor } from './color.mjs';
import { lineAt, parseDeclarations, resolveScopes, resolveValue, unmatchedScopes } from './css.mjs';
import { expandEach, label } from './files.mjs';

/** A token name, or a literal colour, resolved to rgba for one theme. */
function side(spec, table, theme) {
  if (spec.startsWith('--')) {
    const resolved = resolveValue(table, spec);
    if (!resolved.ok) return { ok: false, reason: `theme "${theme}": ${resolved.reason}` };
    const color = parseColor(resolved.value);
    if (!color.ok) return { ok: false, reason: `theme "${theme}": ${spec} is ${color.reason}` };
    return { ok: true, rgba: color.rgba, at: resolved.decl };
  }
  const color = parseColor(spec);
  if (!color.ok) return { ok: false, reason: `theme "${theme}": ${color.reason}` };
  return { ok: true, rgba: color.rgba };
}

export function runContrast(config, cwd) {
  const samples = [];
  const problems = [];
  const { tokens, themes, pairs } = config;

  const { files, empty: deadPatterns } = expandEach(tokens, cwd);
  // Per pattern. A dead one beside a live one leaves the union non-empty, so
  // a renamed token file stops being read without anything saying so.
  for (const p of deadPatterns) problems.push(`no token files matched "${p}"`);
  if (!files.length) {
    if (!deadPatterns.length) {
      problems.push(`no token files matched ${tokens.map((t) => `"${t}"`).join(', ')}`);
    }
    return { name: 'contrast', samples, problems, summary: '' };
  }

  // One declaration list across every token file, in the order they were
  // listed, so a later file overriding an earlier one behaves like a later
  // @import would.
  // Each declaration remembers where it was written. A contrast failure is
  // otherwise a number with nowhere to go, and the line you would edit to fix
  // it is the line the token is declared on.
  const decls = files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const where = { file: label(file, cwd), };
    return parseDeclarations(source).map((d) => ({ ...d, ...where, line: lineAt(source, d.index) }));
  });

  for (const theme of themes) {
    const table = resolveScopes(decls, theme.scopes);
    if (!table.size) {
      problems.push(
        `theme "${theme.name}" resolved zero tokens. Check its scopes (${theme.scopes
          .map((s) => (typeof s === 'string' ? s : s.selector))
          .join(', ')}) against ${files.map((f) => label(f, cwd)).join(', ')}.`,
      );
      continue;
    }

    // A scope that selects nothing is not a smaller theme, it is a typo. The
    // theme above still has tokens, so nothing else here would notice.
    const dead = unmatchedScopes(decls, theme.scopes);
    if (dead.length) {
      for (const scope of dead) {
        const shown = typeof scope === 'string' ? scope : JSON.stringify(scope);
        problems.push(
          `theme "${theme.name}": the scope ${shown} matched no declaration. ` +
            `Every token it was meant to contribute is coming from another scope instead.`,
        );
      }
      continue;
    }

    for (const pair of pairs) {
      if (pair.themes && !pair.themes.includes(theme.name)) continue;
      const where = `${pair.fg} on ${pair.bg}`;

      const bg = side(pair.bg, table, theme.name);
      if (!bg.ok) {
        problems.push(`${where}: ${bg.reason}`);
        continue;
      }
      // A ground with alpha is not a ground. The original walked up the DOM to
      // the first opaque ancestor; there is no DOM here, so the config has to
      // name a surface that is actually opaque.
      if (!isOpaque(bg.rgba)) {
        problems.push(
          `${where}: theme "${theme.name}": ${pair.bg} is translucent, so there is nothing ` +
            `definite to measure against. Name the opaque surface behind it instead.`,
        );
        continue;
      }

      const fg = side(pair.fg, table, theme.name);
      if (!fg.ok) {
        problems.push(`${where}: ${fg.reason}`);
        continue;
      }

      const ratio = contrastRatio(fg.rgba, bg.rgba);
      samples.push({
        theme: theme.name,
        fg: pair.fg,
        bg: pair.bg,
        note: pair.label ?? '',
        ratio,
        min: pair.min,
        pass: ratio >= pair.min,
        // Point at the foreground: it is the half a contrast failure is
        // usually fixed by moving.
        at: fg.at ? { file: fg.at.file, line: fg.at.line } : null,
      });
    }
  }

  return {
    name: 'contrast',
    samples,
    problems,
    summary: `${samples.length} ${samples.length === 1 ? 'pair' : 'pairs'} across ${
      themes.length
    } ${themes.length === 1 ? 'theme' : 'themes'}`,
  };
}
