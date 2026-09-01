/**
 * The failure this project exists to prevent, turned on itself.
 *
 * Every test here is for a path where a check printed ok and exited 0 having
 * checked nothing, or where a real declaration was erased before anyone looked
 * at it. A checker that is wrong gets fixed. A checker that is quietly absent
 * teaches a team to stop reading it, so these are the ones that matter most.
 *
 * Each was confirmed to fail against the code as it stood before the fix.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseDeclarations, lineAt } from '../src/css.mjs';
import { expandEach } from '../src/files.mjs';
import { classesOf, runTreatments } from '../src/treatments.mjs';
import { runTokens } from '../src/tokens.mjs';
import { runContrast } from '../src/contrast.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixture');

const scratch = [];
function plantable() {
  const dir = mkdtempSync(join(tmpdir(), 'taste-check-silent-'));
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

describe('a single-quoted attribute is not invisible', () => {
  test('classes in single quotes are read', () => {
    assert.deepEqual(
      classesOf(" class='promo sneaky' ").map((c) => c.name),
      ['promo', 'sneaky'],
    );
  });

  test('double quotes still work', () => {
    assert.deepEqual(classesOf(' className="card" ').map((c) => c.name), ['card']);
  });

  test('a single-quoted file reports the same failures a double-quoted one would', () => {
    // Before the fix this file reported "1 file scanned" and exited 0 while
    // carrying an unapproved class and two one-off values.
    const result = runTreatments(
      {
        files: ['markup/single-quoted.html'],
        elements: ['a', 'div', 'section'],
        approvedClasses: ['card', 'card__link'],
        approvedValues: [],
      },
      FIXTURE,
    );
    const subjects = result.failures.map((f) => f.subject).sort();
    assert.deepEqual(subjects, ['#ff0055', '13px', 'promo-huge']);
  });
});

describe('a dead pattern beside a live one is reported', () => {
  test('expandEach names the patterns that matched nothing', () => {
    // Three different ways to match nothing, because they are three
    // different code paths: a literal path that is not a file, a wildcard
    // whose base directory is gone, and a wildcard whose base exists and
    // whose extension matches none of it. The last one is the one a real
    // config hits, and the one a union can hide.
    const { files, empty } = expandEach(
      ['markup/*.jsx', 'gone.css', 'nowhere/**/*.tsx', 'markup/*.vue'],
      FIXTURE,
    );
    assert.ok(files.length > 0, 'the live pattern still resolves');
    assert.deepEqual(empty, ['gone.css', 'nowhere/**/*.tsx', 'markup/*.vue']);
  });

  test('a renamed directory does not silently stop being checked', () => {
    // The union of two patterns is non-empty, so nothing was wrong at the
    // list level and the second tree just stopped being scanned.
    const result = runTokens(
      { declaredIn: ['tokens.css'], files: ['vars/ok.jsx', 'renamed/**/*.jsx'], allow: ['--set-from-js'], allowPrefixes: ['--lib-'] },
      FIXTURE,
    );
    assert.match(result.problems.join('\n'), /no markup files matched "renamed\/\*\*\/\*\.jsx"/);
  });

  test('the same holds for a token file', () => {
    const result = runContrast(
      { tokens: ['tokens.css', 'moved/theme.css'], themes: [{ name: 'light', scopes: [':root'] }], pairs: [] },
      FIXTURE,
    );
    assert.match(result.problems.join('\n'), /no token files matched "moved\/theme\.css"/);
  });
});

describe('a comment cannot erase a declaration', () => {
  test('a /* inside one string and a */ inside another blank nothing', () => {
    // Blanking comments before the walk cannot see quotes, so everything
    // between these two string values was erased, --ink included.
    const css = ':root { --open: "/*"; --ink: #123456; --close: "*/"; --fg: #abcdef; }';
    assert.deepEqual(
      parseDeclarations(css).map((d) => d.prop),
      ['--open', '--ink', '--close', '--fg'],
    );
  });

  test('a real comment is still not read as a declaration', () => {
    const css = ':root { /* --fake: #000; */ --real: #fff; }';
    assert.deepEqual(parseDeclarations(css).map((d) => d.prop), ['--real']);
  });

  test('a declaration under a comment reports its own line, not the comment', () => {
    // The regression the first fix introduced: with comments stepped over
    // rather than blanked, deriving the offset by trimming stopped at the "/".
    const css = ':root {\n  /* a note\n     over two lines */\n  --ink: #123456;\n}';
    const [decl] = parseDeclarations(css);
    assert.equal(decl.prop, '--ink');
    assert.equal(lineAt(css, decl.index), 4);
  });
});

describe('the mutations that survived', () => {
  test('a pair sitting exactly on its floor passes', () => {
    // ratio >= min, not >. Black on white is 21 by construction, so this
    // pins the boundary that every real fixture pair sits clear of.
    const result = runContrast(
      {
        tokens: ['tokens.css'],
        themes: [{ name: 'light', scopes: [':root'] }],
        pairs: [{ fg: '#000000', bg: '#ffffff', min: 21, label: 'exactly on the floor' }],
      },
      FIXTURE,
    );
    const [sample] = result.samples;
    assert.equal(sample.ratio.toFixed(2), '21.00');
    assert.equal(sample.pass, true, 'a ratio equal to its floor clears it');
  });

  test('allowPrefixes is a prefix, not a substring', () => {
    const dir = plantable();
    // The name has to contain the prefix without starting with it, or a
    // substring match and a prefix match agree and the test proves nothing.
    writeFileSync(join(dir, 'vars', 'ok.jsx'), "const a = { width: 'var(--wrapper--lib-gap)' };\n");
    const result = runTokens(
      { declaredIn: ['tokens.css'], files: ['vars/ok.jsx'], allowPrefixes: ['--lib-'] },
      dir,
    );
    assert.deepEqual(
      result.failures.map((f) => f.subject),
      ['--wrapper--lib-gap'],
      'a name containing the prefix but not starting with it is not allowed',
    );
  });

  test('a double-star pattern matches at depth', () => {
    // The glob the README's own examples use, which no test exercised.
    const { files, empty } = expandEach(['**/*.jsx'], FIXTURE);
    assert.deepEqual(empty, []);
    const names = files.map((f) => f.slice(FIXTURE.length + 1)).sort();
    assert.ok(names.includes('markup/ok.jsx'), `** did not reach markup/: ${names.join(', ')}`);
    // The one a nested fixture cannot prove: "**/" is zero or more
    // directories, so it has to match at the root too.
    assert.ok(names.includes('root.jsx'), `** did not match at depth zero: ${names.join(', ')}`);
  });
});
