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
import { parseDeclarations, resolveScopes, resolveValue, unmatchedScopes } from '../src/css.mjs';
import { load, validate } from '../src/config.mjs';
import { run } from '../src/index.mjs';
import { failed, toText } from '../src/report.mjs';
import { classesOf, openTags } from '../src/treatments.mjs';
import { buildPrompt, checklistLines, extractJson, runJudge } from '../src/judge.mjs';

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

  // Every expected value below was read out of a browser with
  // getComputedStyle, not derived from the same formulas the parser uses.
  // Checking a conversion against the maths that produced it proves nothing.
  const BROWSER = {
    'hsl(210 40% 96%)': [241, 245, 249, 1],
    'hsl(0, 100%, 50%)': [255, 0, 0, 1],
    'hsla(120, 100%, 25%, 0.5)': [0, 128, 0, 0.5],
    'hsl(210deg 40% 96% / 50%)': [241, 245, 249, 0.5],
    'hsl(210 40% 96% / 0.25)': [241, 245, 249, 0.25],
    'hwb(210 40% 4%)': [102, 173, 245, 1],
    'hwb(120 0% 0%)': [0, 255, 0, 1],
    'hwb(60 30% 20%)': [204, 204, 77, 1],
    // Whiteness and blackness summing past 1 drops the hue entirely and
    // leaves the grey at w / (w + b). Every other input hides this case.
    'hwb(0 60% 60%)': [128, 128, 128, 1],
    // Hue is an angle, so it wraps in both directions.
    'hsl(480 100% 50%)': [0, 255, 0, 1],
    'hsl(-240 100% 50%)': [0, 255, 0, 1],
    // All four angle units name the same hue.
    'hsl(0.5turn 50% 50%)': [64, 191, 191, 1],
    'hsl(3.14159rad 50% 50%)': [64, 191, 191, 1],
    'hsl(200grad 50% 50%)': [64, 191, 191, 1],
  };

  for (const [text, want] of Object.entries(BROWSER)) {
    test(`${text} matches the browser`, () => {
      const got = parseColor(text);
      assert.equal(got.ok, true, got.reason);
      assert.deepEqual(got.rgba.slice(0, 3).map(Math.round), want.slice(0, 3));
      assert.ok(Math.abs(got.rgba[3] - want[3]) < 0.005, `alpha ${got.rgba[3]} != ${want[3]}`);
    });
  }

  test('an unparseable colour is an error, never a silent pass', () => {
    for (const text of ['lab(54% 81 70)', 'color-mix(in srgb, red, blue)', 'chartreuse', '']) {
      assert.equal(parseColor(text).ok, false, `${text} should not parse`);
    }
    assert.match(parseColor('oklch(0.7 0.1 250)').reason, /not supported in v1/);
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

  test('a grouping at-rule is transparent, a conditional one is not', () => {
    // @layer always applies; it only changes cascade priority. @media and
    // @supports apply conditionally. Treating them the same forced anyone
    // with a layered token file to opt in just to see their own tokens.
    const css = `
      @layer tokens, base;
      @layer tokens {
        :root { --bg: #fff; --ink: #111; }
        :root[data-theme="dark"] { --bg: #000; }
      }
      @media (prefers-color-scheme: dark) { :root { --bg: #123456; } }
      @supports (color: oklch(0 0 0)) { :root { --ink: oklch(0 0 0); } }
    `;
    const decls = parseDeclarations(css);

    const light = resolveScopes(decls, [':root']);
    assert.equal(resolveValue(light, '--bg').value, '#fff', '@layer must not hide a declaration');
    assert.equal(resolveValue(light, '--ink').value, '#111', '@supports must still be ignored');

    const dark = resolveScopes(decls, [':root', ':root[data-theme="dark"]']);
    assert.equal(resolveValue(dark, '--bg').value, '#000', 'an override inside a layer must still win');

    const system = resolveScopes(decls, [
      ':root',
      { selector: ':root', atRule: 'prefers-color-scheme: dark' },
    ]);
    assert.equal(resolveValue(system, '--bg').value, '#123456', 'opting into a media query still works');

    const narrowed = resolveScopes(decls, [{ selector: ':root', atRule: 'layer tokens' }]);
    assert.equal(resolveValue(narrowed, '--bg').value, '#fff', 'naming a layer still narrows to it');
  });

  test('a conditional at-rule nested inside a layer stays hidden', () => {
    const decls = parseDeclarations(
      '@layer tokens { @media (min-width: 60rem) { :root { --gap: 2rem; } } }',
    );
    assert.equal(resolveScopes(decls, [':root']).has('--gap'), false);
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

  test('a class hidden inside a template literal hole is caught', () => {
    // The regression this exists for: blanking a `${...}` hole instead of
    // reading into it hides any class name written there, and a class the
    // checker cannot see is a class that ships unapproved.
    const dir = plantable();
    const markup = join(dir, 'markup', 'ok.jsx');
    writeFileSync(
      markup,
      readFileSync(markup, 'utf8').replace("'card__tag--on' : ''", "'card__tag--on' : 'buried'"),
    );

    const { config } = loadConfig('pass.config.json');
    const failures = byName(run(config, dir), 'treatments').failures;
    assert.ok(
      failures.some((f) => f.includes('"buried"')),
      `a class inside a template hole was not seen: ${failures.join('\n') || '(no failures at all)'}`,
    );
  });

  test('a file pattern matching nothing fails instead of reporting clean', () => {
    const { config, dir } = loadConfig('pass.config.json');
    const results = run({ treatments: { ...config.treatments, files: ['markup/nothing-here/*.jsx'] } }, dir);
    assert.equal(failed(results), true, 'an empty glob must not read as a clean run');
    assert.match(byName(results, 'treatments').problems[0], /no markup files matched/);
  });

  test('a scope that selects nothing fails, even when the theme has tokens', () => {
    // The dangerous shape: the base scope fills the table, so the theme is not
    // empty, but the override scope is a typo and contributes nothing. Without
    // this check the dark theme silently reports the light theme's numbers.
    const decls = parseDeclarations(
      ':root { --bg: #fff; } :root[data-theme="dark"] { --bg: #000; }',
    );
    const typo = [':root', '[data-theme="dark"]'];
    assert.equal(resolveScopes(decls, typo).size, 1, 'the theme still resolves a token');
    assert.deepEqual(unmatchedScopes(decls, typo), ['[data-theme="dark"]']);
    assert.deepEqual(unmatchedScopes(decls, [':root', ':root[data-theme="dark"]']), []);

    const { config, dir } = loadConfig('pass.config.json');
    const results = run(
      {
        contrast: {
          ...config.contrast,
          // The fixture writes `[data-theme="dark"]`, so the `:root`-prefixed
          // form selects nothing. That is the real shape of the bug: a
          // selector that is plausible, close, and dead.
          themes: [{ name: 'dark', scopes: [':root', ':root[data-theme="dark"]'] }],
          pairs: config.contrast.pairs.map(({ themes, ...p }) => p),
        },
      },
      dir,
    );
    assert.equal(failed(results), true, 'a dead scope must not read as a pass');
    assert.match(byName(results, 'contrast').problems[0], /matched no declaration/);
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
    assert.match(validate(config).join('\n'), /nothing to measure/);
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

describe('the judge', () => {
  const DIR = join(FIXTURE, 'judge');
  const LAST = 'Text is readable against what is behind it';

  /** Run the judge with the stub standing in for a model command. */
  const ask = (mode, failOn = 'never') => {
    const previous = process.env.STUB;
    process.env.STUB = mode;
    try {
      return runJudge(
        { checklist: 'checklist.md', shots: ['shots/*.png'], command: 'node stub.mjs', failOn },
        DIR,
      );
    } finally {
      if (previous === undefined) delete process.env.STUB;
      else process.env.STUB = previous;
    }
  };

  test('a checklist is its list items, not its prose', () => {
    // The fixture checklist has a heading and an explanatory paragraph. If
    // those became checklist lines the judge would be asked to rule on them.
    const lines = checklistLines(readFileSync(join(DIR, 'checklist.md'), 'utf8'));
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => !l.startsWith('#')));
    assert.ok(!lines.some((l) => l.includes('deliberately generic')));
  });

  test('the prompt carries the framing and the checklist, and nothing else', () => {
    const prompt = buildPrompt(['Do the thing']);
    assert.match(prompt, /looking at these images for the first time/);
    assert.match(prompt, /Prefer "unsure" to a guess/);
    assert.match(prompt, /- Do the thing/);
    // No design opinion of ours is allowed to ride along in the framing.
    for (const word of ['contrast', 'spacing', 'colour', 'color', 'gradient', 'font']) {
      assert.ok(!prompt.toLowerCase().includes(word), `the framing must not mention ${word}`);
    }
  });

  test('JSON survives a fenced reply', () => {
    const parsed = extractJson('Sure!\n```json\n{"findings":[]}\n```\nhope that helps');
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { findings: [] });
  });

  test('a clean run passes', () => {
    const result = ask('clean');
    assert.deepEqual(result.problems, []);
    assert.equal(result.findings.length, 3);
    assert.ok(result.findings.every((f) => f.verdict === 'pass'));
    assert.equal(failed([result]), false);
  });

  test('a fail verdict is advisory by default', () => {
    const result = ask('fail');
    assert.deepEqual(result.problems, []);
    assert.equal(result.findings.find((f) => f.verdict === 'fail').line, 'Nothing important is cut off at the edge');
    assert.equal(failed([result]), false, 'an opinion must not gate a build by default');
    assert.match(toText([result]), /NOTE {2}fail/);
  });

  test('the same verdict blocks under failOn: fail', () => {
    const result = ask('fail', 'fail');
    assert.equal(failed([result]), true);
    const text = toText([result]);
    assert.match(text, /FAIL {2}fail/);
    // "unsure" is still only a note. It is not a verdict against the screen.
    assert.match(text, /NOTE {2}unsure/);
  });

  // Everything below is the judge failing to RUN, which is a fact rather than
  // an opinion, so each one blocks even in advisory mode.
  test('a skipped checklist line fails, even advisory', () => {
    const result = ask('skipped');
    assert.equal(failed([result]), true, 'an unanswered line must not read as a pass');
    assert.ok(result.problems.some((p) => p.includes(`did not answer "${LAST}"`)), result.problems.join('\n'));
  });

  test('an invented checklist line fails, even advisory', () => {
    const result = ask('invented');
    assert.equal(failed([result]), true);
    assert.ok(result.problems.some((p) => p.includes('not in the checklist')));
  });

  test('an unparseable reply fails, even advisory', () => {
    const result = ask('garbage');
    assert.equal(failed([result]), true);
    assert.ok(result.problems.some((p) => p.includes('no JSON object')));
  });

  test('a command that exits non-zero fails, even advisory', () => {
    const result = ask('crash');
    assert.equal(failed([result]), true);
    assert.ok(result.problems.some((p) => p.includes('unreachable')), result.problems.join('\n'));
  });

  test('no screenshots fails rather than passing quietly', () => {
    const result = runJudge(
      { checklist: 'checklist.md', shots: ['shots/none/*.png'], command: 'node stub.mjs' },
      DIR,
    );
    assert.equal(failed([result]), true);
    assert.match(result.problems[0], /no screenshots matched/);
  });

  test('a checklist with no list items fails', () => {
    const result = runJudge(
      { checklist: 'shots/desktop.png', shots: ['shots/*.png'], command: 'node stub.mjs' },
      DIR,
    );
    assert.equal(failed([result]), true);
    assert.match(result.problems[0], /no checklist lines/);
  });

  test('the shipped configs are valid and carry no design rules', () => {
    for (const name of ['judge.config.json', 'blocking.config.json']) {
      assert.deepEqual(validate(JSON.parse(readFileSync(join(DIR, name), 'utf8'))), [], name);
    }
  });
});
