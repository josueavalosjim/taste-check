/**
 * The suite is built around one idea: prove the checks can fail.
 *
 * Asserting that a clean fixture passes is cheap and nearly worthless. A
 * checker with its scanner commented out passes a clean fixture too. So most
 * of what is below either runs a deliberately dirty fixture and demands the
 * specific expected message, or plants a violation into a fixture that was
 * passing a moment earlier and demands that the plant is caught.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseColor, contrastRatio } from '../src/color.mjs';
import { parseDeclarations, resolveScopes, resolveValue } from '../src/css.mjs';
import { load, validate } from '../src/config.mjs';
import { run } from '../src/index.mjs';
import { failed } from '../src/report.mjs';
import { classesOf, openTags } from '../src/treatments.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixture');

const loadConfig = (name) => {
  const result = load(join(FIXTURE, name));
  assert.equal(result.ok, true, `fixture config ${name} should be valid: ${result.errors?.join('; ')}`);
  return result;
};

const check = (name, options = {}) => {
  const { config, dir } = loadConfig(name);
  return run(config, dir, options);
};

const byName = (results, name) => results.find((r) => r.name === name);
const sample = (result, fg, theme) => result.samples.find((s) => s.fg === fg && s.theme === theme);

/** A throwaway copy of the fixture, so a plant never touches the real one. */
const scratch = [];
function plantable() {
  const dir = mkdtempSync(join(tmpdir(), 'taste-check-'));
  cpSync(FIXTURE, dir, { recursive: true });
  scratch.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp dir is not worth failing a run over */
    }
  }
});

describe('colour maths', () => {
  test('black on white is 21:1', () => {
    assert.equal(contrastRatio(parseColor('#000').rgba, parseColor('#fff').rgba).toFixed(2), '21.00');
  });

  test('a translucent foreground is composited, not read raw', () => {
    const white = parseColor('#ffffff').rgba;
    const raw = contrastRatio(parseColor('#000000').rgba, white);
    const composited = contrastRatio(parseColor('rgb(0 0 0 / 0.58)').rgba, white);
    assert.equal(raw.toFixed(2), '21.00');
    assert.equal(composited.toFixed(2), '5.32');
  });

  test('both rgb syntaxes and every hex length agree', () => {
    const want = [255, 0, 0, 0.5];
    for (const text of ['rgba(255, 0, 0, 0.5)', 'rgb(255 0 0 / 0.5)', 'rgb(255 0 0 / 50%)', '#ff000080']) {
      const { ok, rgba } = parseColor(text);
      assert.equal(ok, true, `${text} should parse`);
      assert.deepEqual(rgba.slice(0, 3), want.slice(0, 3), text);
      assert.ok(Math.abs(rgba[3] - 0.5) < 0.01, `${text} alpha`);
    }
  });

  test('an unparseable colour is an error, never a silent pass', () => {
    for (const text of ['oklch(0.7 0.1 250)', 'color-mix(in srgb, red, blue)', 'chartreuse', '']) {
      assert.equal(parseColor(text).ok, false, `${text} should not parse`);
    }
    assert.match(parseColor('hsl(0 0% 0%)').reason, /not supported in v1/);
  });
});

describe('token resolution', () => {
  const decls = parseDeclarations(readFileSync(join(FIXTURE, 'tokens.css'), 'utf8'));

  test('an at-rule is ignored unless a scope opts into it', () => {
    // tokens.css hides a --surface: #000000 inside a prefers-color-scheme
    // block. If it leaked, every light measurement would be against black.
    const light = resolveScopes(decls, [':root']);
    assert.equal(resolveValue(light, '--surface').value, '#ffffff');

    const opted = resolveScopes(decls, [
      ':root',
      { selector: ':root', atRule: 'prefers-color-scheme: dark' },
    ]);
    assert.equal(resolveValue(opted, '--surface').value, '#000000');
  });

  test('later scopes win', () => {
    const dark = resolveScopes(decls, [':root', '[data-theme="dark"]']);
    assert.equal(resolveValue(dark, '--surface').value, '#14171c');
    // Inherited from :root, because dark does not redefine it.
    assert.equal(resolveValue(dark, '--surface-raised').value, '#1e232a');
  });

  test('var() indirection resolves through the theme', () => {
    const light = resolveScopes(decls, [':root']);
    assert.equal(resolveValue(light, '--link').value, '#2f5fd0');
    const dark = resolveScopes(decls, [':root', '[data-theme="dark"]']);
    assert.equal(resolveValue(dark, '--link').value, '#8fb0f5');
  });

  test('a circular var() is reported rather than hanging', () => {
    const table = resolveScopes(parseDeclarations(':root { --a: var(--b); --b: var(--a); }'), [':root']);
    const result = resolveValue(table, '--a');
    assert.equal(result.ok, false);
    assert.match(result.reason, /circle/);
  });

  test('a selector is matched exactly, not by substring', () => {
    const table = resolveScopes(parseDeclarations(':root .nested { --a: red; }'), [':root']);
    assert.equal(table.has('--a'), false);
  });
});

describe('the markup scanner', () => {
  const source = readFileSync(join(FIXTURE, 'markup', 'ok.jsx'), 'utf8');

  test('a ">" inside braces or quotes does not end the tag', () => {
    // The point of the walker. A regex implementation finds fewer tags here
    // and reports the file clean, which is the failure mode the scanner
    // exists to prevent.
    const tags = [...openTags(source, ['button'])];
    assert.equal(tags.length, 1);
    assert.deepEqual(
      classesOf(tags[0].attrs).map((c) => c.name),
      ['button'],
    );
    assert.match(tags[0].attrs, /title="a > b"/);
  });

  test('a ternary contributes both of its branches', () => {
    const [tag] = [...openTags(source, ['a'])];
    const names = classesOf(tag.attrs).map((c) => c.name);
    assert.deepEqual(names.sort(), ['card__link', 'card__link', 'card__link--featured']);
  });

  test('a template literal hole is dropped, the text around it is kept', () => {
    const [tag] = [...openTags(source, ['span'])];
    const names = classesOf(tag.attrs).map((c) => c.name);
    assert.ok(names.includes('card__tag'));
    assert.ok(names.includes('card__tag--on'));
    assert.ok(!names.some((n) => n.includes('$')), 'a ${} hole must not become a class name');
  });
});

describe('the known-good fixture', () => {
  const results = check('pass.config.json');

  test('every check passes', () => {
    assert.equal(failed(results), false);
  });

  test('the translucent token is measured composited, at 5.32 not 21', () => {
    // If this ever reads 21.00, alpha has stopped being composited and every
    // translucent token in every config is being scored as if it were solid.
    assert.equal(sample(byName(results, 'contrast'), '--text-quiet', 'light').ratio.toFixed(2), '5.32');
  });

  test('a pair scoped to one theme is measured only there', () => {
    const contrast = byName(results, 'contrast');
    assert.ok(sample(contrast, '--hairline', 'light'));
    assert.equal(sample(contrast, '--hairline', 'dark'), undefined);
  });

  test('the clean file was actually scanned, not skipped', () => {
    // "0 failures" from a file that was never opened is the lie this suite is
    // built to catch, so assert the count as well as the silence.
    assert.equal(byName(results, 'treatments').summary, '1 file scanned');
    assert.deepEqual(byName(results, 'treatments').failures, []);
  });
});

describe('the known-bad fixture', () => {
  const results = check('fail.config.json');
  const contrast = byName(results, 'contrast');
  const treatments = byName(results, 'treatments');

  test('the run fails', () => {
    assert.equal(failed(results), true);
  });

  test('a pair below its floor is reported with its ratio and theme', () => {
    const bad = sample(contrast, '--hairline', 'dark');
    assert.equal(bad.pass, false);
    assert.equal(bad.ratio.toFixed(2), '1.52');
    assert.equal(bad.min, 3.0);
    // And it passes in light, so the failure is the value, not the pair.
    assert.equal(sample(contrast, '--hairline', 'light').pass, true);
  });

  test('a token that does not exist fails rather than being skipped', () => {
    const missing = contrast.problems.filter((p) => p.includes('--nonexistent'));
    assert.equal(missing.length, 2, 'once per theme');
    assert.match(missing[0], /is not defined in this theme/);
  });

  test('a translucent background is refused, not measured', () => {
    assert.ok(contrast.problems.some((p) => p.includes('--veil') && p.includes('translucent')));
  });

  test('an unapproved class inside a ternary is caught', () => {
    assert.ok(
      treatments.failures.some((f) => f.includes('bad.jsx:7') && f.includes('"promo-huge"')),
      treatments.failures.join('\n'),
    );
  });

  test('one-off values are caught in both style syntaxes', () => {
    const text = treatments.failures.join('\n');
    for (const value of ['#ff0055', '13px', '7px']) {
      assert.ok(text.includes(`"${value}"`), `${value} should be reported`);
    }
  });

  test('the clean file in the same glob produces nothing', () => {
    assert.equal(
      treatments.failures.filter((f) => f.includes('ok.jsx')).length,
      0,
      'ok.jsx must not produce false positives',
    );
  });
});

describe('planted violations', () => {
  test('darkening a passing token is caught', () => {
    const dir = plantable();
    const tokens = join(dir, 'tokens.css');
    // --text-quiet clears 4.5 in light at 5.32. Drop its alpha and it should
    // not. If this still passes, the checker is not reading the file it says
    // it is reading.
    writeFileSync(tokens, readFileSync(tokens, 'utf8').replace('rgb(0 0 0 / 0.58)', 'rgb(0 0 0 / 0.28)'));

    const { config } = loadConfig('pass.config.json');
    const results = run(config, dir);
    const planted = sample(byName(results, 'contrast'), '--text-quiet', 'light');
    assert.equal(planted.pass, false, 'the planted contrast violation was not caught');
    assert.ok(planted.ratio < 4.5);
    assert.equal(failed(results), true);
  });

  test('adding an unapproved class to the clean file is caught', () => {
    const dir = plantable();
    const markup = join(dir, 'markup', 'ok.jsx');
    writeFileSync(markup, readFileSync(markup, 'utf8').replace('className="card"', 'className="card sneaky"'));

    const { config } = loadConfig('pass.config.json');
    const results = run(config, dir);
    const failures = byName(results, 'treatments').failures;
    assert.ok(
      failures.some((f) => f.includes('"sneaky"')),
      `the planted class was not caught: ${failures.join('\n') || '(no failures at all)'}`,
    );
  });

  test('a file pattern matching nothing fails instead of reporting clean', () => {
    const { config, dir } = loadConfig('pass.config.json');
    const results = run({ treatments: { ...config.treatments, files: ['markup/nothing-here/*.jsx'] } }, dir);
    assert.equal(failed(results), true, 'an empty glob must not read as a clean run');
    assert.match(byName(results, 'treatments').problems[0], /no markup files matched/);
  });

  test('a token file matching nothing fails instead of reporting clean', () => {
    const { config, dir } = loadConfig('pass.config.json');
    const results = run({ contrast: { ...config.contrast, tokens: ['no-such-file.css'] } }, dir);
    assert.equal(failed(results), true);
    assert.match(byName(results, 'contrast').problems[0], /no token files matched/);
  });

  test('a theme whose scopes resolve nothing fails', () => {
    const { config, dir } = loadConfig('pass.config.json');
    const results = run(
      { contrast: { ...config.contrast, themes: [{ name: 'typo', scopes: ['.root'] }], pairs: config.contrast.pairs.map(({ themes, ...p }) => p) } },
      dir,
    );
    assert.equal(failed(results), true);
    assert.match(byName(results, 'contrast').problems[0], /resolved zero tokens/);
  });
});

describe('config validation', () => {
  const base = () => JSON.parse(readFileSync(join(FIXTURE, 'pass.config.json'), 'utf8'));

  test('an unknown key is rejected, not ignored', () => {
    const config = base();
    config.contrast.paris = config.contrast.pairs;
    assert.match(validate(config).join('\n'), /unknown key "paris"/);
  });

  test('a pair scoped to a theme that does not exist is rejected', () => {
    const config = base();
    config.contrast.pairs[0].themes = ['lite'];
    assert.match(validate(config).join('\n'), /is not a theme in contrast\.themes/);
  });

  test('an empty pair list is rejected', () => {
    const config = base();
    config.contrast.pairs = [];
    assert.match(validate(config).join('\n'), /cannot fail/);
  });

  test('a missing min is rejected rather than defaulted to a WCAG number', () => {
    const config = base();
    delete config.contrast.pairs[0].min;
    assert.match(validate(config).join('\n'), /must be a positive number/);
  });

  test('the shipped fixture configs are valid', () => {
    for (const name of ['pass.config.json', 'fail.config.json']) {
      assert.deepEqual(validate(JSON.parse(readFileSync(join(FIXTURE, name), 'utf8'))), [], name);
    }
  });
});
