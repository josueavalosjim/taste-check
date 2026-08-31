/**
 * The tokens check: every var(--x) in markup, against what the system declares.
 *
 * Same rule as the rest of the suite. A clean fixture passing proves nothing,
 * because a checker with its scanner deleted passes a clean fixture too. So
 * every test here either runs the dirty fixture and demands the exact message,
 * or plants a fabricated token into a file that was passing a moment earlier.
 *
 * The guards get as much attention as the check. Three of the four ways this
 * can go quiet are blocking problems, and each has a test that would notice if
 * the guard were removed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load, validate } from '../src/config.mjs';
import { run } from '../src/index.mjs';
import { failed, toText } from '../src/report.mjs';
import { runTokens, varRefs } from '../src/tokens.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixture');
const BIN = join(HERE, '..', 'bin', 'taste-check.mjs');

const loadConfig = (name) => {
  const result = load(join(FIXTURE, name));
  assert.equal(result.ok, true, `fixture config ${name} should be valid: ${result.errors?.join('; ')}`);
  return result;
};

/** Run the check against the fixture tree with an ad-hoc config. */
const checkTokens = (config, cwd = FIXTURE) =>
  runTokens({ declaredIn: ['tokens.css'], files: ['vars/ok.jsx'], ...config }, cwd);

const subjects = (result) => result.failures.map((f) => f.subject).sort();

const scratch = [];
function plantable() {
  const dir = mkdtempSync(join(tmpdir(), 'taste-check-tokens-'));
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

describe('the var() extractor', () => {
  test('a nested reference yields both names, not just the outer one', () => {
    // var(--a, var(--b)) is how a fallback chain is written, and --b is just
    // as capable of being fabricated as --a. A pattern anchored on the closing
    // paren finds only one of them.
    assert.deepEqual(
      varRefs('color: var(--a, var(--b));').map((r) => r.name),
      ['--a', '--b'],
    );
  });

  test('a fallback is recorded, because it changes what the failure means', () => {
    const [withFallback] = varRefs('var(--a, 12px)');
    const [without] = varRefs('var(--b)');
    assert.equal(withFallback.fallback, true);
    assert.equal(without.fallback, false);
  });

  test('a bare custom property outside var() is not a reference', () => {
    // Declaring --x is not referencing it, and stylelint's
    // custom-property-no-missing-var-function owns the mistake of writing one
    // where you meant the other. Flagging it here would report every token
    // file as full of undefined tokens.
    assert.deepEqual(varRefs("{ '--card-span': span, width: '--not-a-ref' }"), []);
  });

  test('whitespace inside var() does not hide the name', () => {
    assert.deepEqual(
      varRefs('var(  --a  )\nvar(\n  --b\n)').map((r) => r.name),
      ['--a', '--b'],
    );
  });

  test('the offset points at the name, so the line number is the reference', () => {
    const source = 'a\nb\ncolor: var(--late);\n';
    const [ref] = varRefs(source);
    assert.equal(source.slice(ref.index, ref.index + 6), '--late');
  });
});

describe('the tokens check', () => {
  test('the dirty fixture names both fabricated tokens', () => {
    const result = checkTokens({ files: ['vars/bad.jsx'] });
    assert.deepEqual(subjects(result), ['--color-primary-500', '--text-secondary']);
    assert.equal(result.problems.length, 0);
  });

  test('a fabricated token points at the line it is written on', () => {
    const result = checkTokens({ files: ['vars/bad.jsx'] });
    const found = result.failures.find((f) => f.subject === '--color-primary-500');
    const source = readFileSync(join(FIXTURE, 'vars', 'bad.jsx'), 'utf8').split('\n');
    assert.match(source[found.line - 1], /--color-primary-500/);
    assert.equal(found.file, 'vars/bad.jsx');
  });

  test('a reference with a fallback says so, because it degrades rather than breaks', () => {
    const found = checkTokens({ files: ['vars/bad.jsx'] }).failures.find(
      (f) => f.subject === '--text-secondary',
    );
    assert.match(found.message, /fallback/);
    const other = checkTokens({ files: ['vars/bad.jsx'] }).failures.find(
      (f) => f.subject === '--color-primary-500',
    );
    assert.doesNotMatch(other.message, /fallback/);
  });

  test('a token declared only in a theme scope still counts as declared', () => {
    // resolveScopes is theme-scoped and drops anything no theme selects. That
    // is right for measuring contrast and wrong here: a token that exists only
    // under [data-theme="dark"] is a real token, and reporting it as undefined
    // would make the check unusable on any themed system. Nothing in the
    // fixture is dark-only, so the case has to be planted to exist at all.
    const dir = plantable();
    const tokens = join(dir, 'tokens.css');
    writeFileSync(
      tokens,
      readFileSync(tokens, 'utf8').replace('[data-theme="dark"] {', '[data-theme="dark"] {\n  --dark-only: #445;'),
    );
    writeFileSync(join(dir, 'vars', 'ok.jsx'), "const a = { color: 'var(--dark-only)' };\n");

    const result = checkTokens({}, dir);
    assert.deepEqual(subjects(result), [], 'a token declared only in the dark scope must still count');
  });

  test('allow covers a property that is set from JavaScript', () => {
    const declared = checkTokens({ allow: ['--set-from-js'], allowPrefixes: ['--lib-'] });
    assert.deepEqual(subjects(declared), []);

    // And prove the allow list is what is doing it, not a scanner that missed
    // the reference entirely.
    const without = checkTokens({});
    assert.deepEqual(subjects(without), ['--lib-gap', '--set-from-js']);
  });

  test('allowPrefixes covers a family a library owns', () => {
    const result = checkTokens({ allow: ['--set-from-js'] });
    assert.deepEqual(subjects(result), ['--lib-gap']);
  });

  test('references outside a JSX tag are found', () => {
    // The object declared above the return in vars/ok.jsx. A tag walker never
    // sees it, and no CSS parser reads a JavaScript object literal, which is
    // the whole reason this check scans the file rather than the markup.
    const source = readFileSync(join(FIXTURE, 'vars', 'ok.jsx'), 'utf8');
    const beforeReturn = source.slice(0, source.indexOf('export function'));
    assert.deepEqual(
      varRefs(beforeReturn).map((r) => r.name),
      ['--surface-raised', '--text-strong'],
    );
  });

  test('the summary carries the counts, so a run that checked nothing shows it', () => {
    const result = checkTokens({ allow: ['--set-from-js'], allowPrefixes: ['--lib-'] });
    assert.equal(result.summary, '1 token file, 8 declared, 1 file scanned, 9 references');
  });

  test('a file with no references reports zero rather than reading as clean', () => {
    // Deliberately not a failure: a codebase that keeps its styling in
    // stylesheets has no var() in markup and is not broken. The number has to
    // be on the page though, because the alternative is a silent pass.
    const result = checkTokens({ files: ['markup/bad.jsx'] });
    assert.deepEqual(subjects(result), []);
    assert.match(result.summary, /0 references$/);
  });
});

describe('the guards', () => {
  test('a token pattern matching nothing is a problem, not a clean run', () => {
    const result = checkTokens({ declaredIn: ['does-not-exist.css'] });
    assert.match(result.problems.join('\n'), /no token files matched "does-not-exist\.css"/);
    assert.equal(result.failures.length, 0, 'every reference must not be reported as undefined');
  });

  test('a markup pattern matching nothing is a problem, not a clean run', () => {
    const result = checkTokens({ files: ['vars/*.tsx'] });
    assert.match(result.problems.join('\n'), /no markup files matched "vars\/\*\.tsx"/);
  });

  test('a token file that declares nothing is a problem', () => {
    // The loudest possible failure mode dressed as a quiet one: point
    // declaredIn at the wrong stylesheet and every reference in the codebase
    // reads as undefined. One line saying why beats a thousand saying what.
    const result = checkTokens({ declaredIn: ['vars/no-tokens.css'] });
    assert.match(result.problems.join('\n'), /none of them declares a custom property/);
    assert.equal(result.failures.length, 0);
  });

  test('a problem blocks the run', () => {
    const result = checkTokens({ declaredIn: ['does-not-exist.css'] });
    assert.equal(failed([result]), true);
    assert.match(toText([result]), /tokens FAILED/);
  });
});

describe('planted violations', () => {
  test('a fabricated token planted in the clean file is caught', () => {
    const dir = plantable();
    const markup = join(dir, 'vars', 'ok.jsx');
    writeFileSync(
      markup,
      readFileSync(markup, 'utf8').replace("var(--link)", "var(--color-primary-500)"),
    );

    const { config } = loadConfig('pass.config.json');
    const results = run(config, dir);
    const failures = results.find((r) => r.name === 'tokens').failures;
    assert.ok(
      failures.some((f) => f.subject === '--color-primary-500'),
      `the planted token was not caught: ${JSON.stringify(failures)}`,
    );
    assert.equal(failed(results), true);
  });

  test('a fabricated token inside a ternary is caught', () => {
    // The case no CSS tooling reaches. Both branches of the ternary are live
    // code, so a checker that reads only the first one ships the second.
    const dir = plantable();
    const markup = join(dir, 'vars', 'ok.jsx');
    writeFileSync(
      markup,
      readFileSync(markup, 'utf8').replace("dim ? 'var(--text-quiet)'", "dim ? 'var(--text-tertiary)'"),
    );

    const { config } = loadConfig('pass.config.json');
    const failures = run(config, dir).find((r) => r.name === 'tokens').failures;
    assert.ok(
      failures.some((f) => f.subject === '--text-tertiary'),
      `a token inside a ternary was not seen: ${JSON.stringify(failures)}`,
    );
  });

  test('renaming a token in the stylesheet turns its every use into a failure', () => {
    // The drift this exists to catch, from the other end: the token file moves
    // and the markup does not.
    const dir = plantable();
    const tokens = join(dir, 'tokens.css');
    // replaceAll, not replace: the token is declared in both the light and
    // the dark scope, and renaming one leaves it declared, which is the union
    // behaviour the test above pins down.
    writeFileSync(tokens, readFileSync(tokens, 'utf8').replaceAll('--surface-raised:', '--surface-elevated:'));

    const { config } = loadConfig('pass.config.json');
    const failures = run(config, dir).find((r) => r.name === 'tokens').failures;
    assert.deepEqual(
      failures.map((f) => f.subject),
      ['--surface-raised'],
    );
  });
});

describe('config validation', () => {
  test('an unknown key is rejected rather than quietly ignored', () => {
    const errors = validate({ tokens: { declaredIn: ['a.css'], files: ['b.jsx'], allowed: [] } });
    assert.match(errors.join('\n'), /tokens has an unknown key "allowed"/);
  });

  test('declaredIn and files are both required', () => {
    const errors = validate({ tokens: {} });
    assert.match(errors.join('\n'), /tokens\.declaredIn is required/);
    assert.match(errors.join('\n'), /tokens\.files is required/);
  });

  test('an allow entry that is not a custom property name is rejected', () => {
    // "brand-ink" allows nothing, because no reference is ever spelled that
    // way, and an allow list that silently allows nothing is the same bug as
    // a check that cannot fail.
    const errors = validate({ tokens: { declaredIn: ['a.css'], files: ['b.jsx'], allow: ['brand-ink'] } });
    assert.match(errors.join('\n'), /not a custom property name/);
  });

  test('a config with only a tokens block is valid', () => {
    assert.deepEqual(validate({ tokens: { declaredIn: ['a.css'], files: ['b.jsx'] } }), []);
  });
});

describe('the command line', () => {
  test('--only tokens runs the tokens check and nothing else', () => {
    const out = execFileSync(
      process.execPath,
      [BIN, '-c', join(FIXTURE, 'pass.config.json'), '--only', 'tokens'],
      { encoding: 'utf8' },
    );
    assert.match(out, /^tokens ok/m);
    assert.doesNotMatch(out, /^contrast/m);
    assert.doesNotMatch(out, /^treatments/m);
  });

  test('--only rejects a name it does not have', () => {
    assert.throws(
      () =>
        execFileSync(process.execPath, [BIN, '-c', join(FIXTURE, 'pass.config.json'), '--only', 'tokns'], {
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      /"contrast", "treatments" or "tokens"/,
    );
  });
});
