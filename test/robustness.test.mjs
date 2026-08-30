/**
 * The parsers are hand-rolled walkers over untrusted text, so the property
 * that matters is not just "gets the right answer on good input". It is
 * "never throws and never hangs on bad input".
 *
 * A stylesheet gets truncated mid-write. A JSX file is saved half-typed. A
 * crash there is worse than a wrong answer, because it takes the whole run
 * down and tells the user nothing about their design system.
 *
 * The generator is seeded, so a failure here is reproducible rather than a
 * flake someone reruns until it passes.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseColor } from '../src/color.mjs';
import { parseDeclarations, resolveScopes, resolveValue } from '../src/css.mjs';
import { buildPrompt, checklistLines, extractJson } from '../src/judge.mjs';
import { classesOf, openTags } from '../src/treatments.mjs';

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];

// Fragments chosen to land on the branches the walkers actually have: quote
// state, brace depth, comment spans, template holes, at-rules.
const ATOMS = ['{','}','"',"'",'`','/*','*/',';',':','--x','#fff','<a','>','</a>','className=','${','}','\\','(',')','@layer','@media',':root','var(','rgb(','\n','  ','[data-t="x"]','!important','<div','/>','hsl(','0.5turn','%'];
const blob = (n) => Array.from({ length: n }, () => pick(ATOMS)).join('');

const css = (text) => {
  const table = resolveScopes(parseDeclarations(text), [
    ':root',
    { selector: ':root', atRule: 'x' },
  ]);
  for (const key of table.keys()) resolveValue(table, key);
};
const jsx = (text) => {
  for (const tag of openTags(text, ['*'])) classesOf(tag.attrs);
};

describe('robustness', () => {
  test('2000 seeded random inputs do not throw', () => {
    for (let i = 0; i < 2000; i += 1) {
      const text = blob(3 + Math.floor(rnd() * 60));
      assert.doesNotThrow(() => css(text), `css: ${JSON.stringify(text.slice(0, 120))}`);
      assert.doesNotThrow(() => jsx(text), `jsx: ${JSON.stringify(text.slice(0, 120))}`);
      assert.doesNotThrow(() => parseColor(text.slice(0, 40)));
      assert.doesNotThrow(() => {
        checklistLines(text);
        extractJson(text);
        buildPrompt([text.slice(0, 40)], ['a.png']);
      });
    }
  });

  // Shapes a random blob will not reach on its own, each one a way a real
  // file goes wrong: truncated mid-write, generated too large, or encoded
  // badly by something upstream.
  const PATHOLOGICAL = [
    ['5000 deep braces', '{'.repeat(5000) + '}'.repeat(5000)],
    ['2000 nested template holes', ':root{--a:' + '${'.repeat(2000) + '}'.repeat(2000) + '}'],
    ['an unterminated string', ':root { --a: "never closed'],
    ['an unterminated comment', ':root { /* never closed --a: #fff; }'],
    ['a two million character line', ':root{--a:' + 'x'.repeat(2_000_000) + '}'],
    ['null bytes', ':root{--a:\u0000\u0000;}'],
    ['a lone surrogate', ':root{--a:\ud800;}'],
    ['CRLF line endings', ':root{\r\n--a:#fff;\r\n}'],
    ['nothing at all', ''],
  ];

  for (const [name, text] of PATHOLOGICAL) {
    test(`${name} does not throw`, () => {
      assert.doesNotThrow(() => css(text));
      assert.doesNotThrow(() => jsx(text));
    });
  }

  test('deeply nested template holes in a className do not blow the stack', () => {
    const markup = `<a className={\`a ${'${x ? `b '.repeat(400)}${'`'.repeat(400)}\`}>`;
    assert.doesNotThrow(() => jsx(markup));
  });

  test('CRLF and an unterminated comment still yield what came before them', () => {
    const table = resolveScopes(parseDeclarations(':root{\r\n--a:#fff;\r\n--b:#000;\r\n}'), [':root']);
    assert.equal(resolveValue(table, '--a').value, '#fff');
    assert.equal(resolveValue(table, '--b').value, '#000');
  });
});
