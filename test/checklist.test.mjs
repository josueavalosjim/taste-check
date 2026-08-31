/**
 * The starter and the answerability linter.
 *
 * Both of these sit closest to the line this project draws, so the tests are
 * mostly about staying on the right side of it: the starter must contain
 * nothing anyone would call taste, and the linter must never object to what a
 * line asks for, only to whether asking it produces a verdict.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { STARTER, lintChecklist, lintLine } from '../src/checklist.mjs';
import { checklistEntries } from '../src/judge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'taste-check.mjs');
const scratch = () => mkdtempSync(join(tmpdir(), 'taste-check-cl-'));
const cli = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

describe('the starter', () => {
  test('it is six lines, and its own prose is not one of them', () => {
    // The header explains what makes a line answerable, which means the header
    // is full of sentences that would be terrible checklist lines. If any of
    // them were parsed as items the judge would be asked to rule on the
    // instructions.
    const entries = checklistEntries(STARTER);
    assert.equal(entries.length, 6);
    assert.ok(!entries.some((e) => e.text.includes('answerable')), entries.map((e) => e.text).join('\n'));
  });

  test('it passes its own linter', () => {
    // The one test that would catch shipping a starter this tool would tell
    // you to rewrite.
    assert.deepEqual(lintChecklist(checklistEntries(STARTER)), []);
  });

  test('every line is about the screen being broken, not about taste', () => {
    // The whole justification for shipping any lines at all. If one of these
    // ever becomes a preference, the claim in the README stops being true.
    const text = checklistEntries(STARTER).map((e) => e.text).join(' ').toLowerCase();
    for (const word of [
      'colour', 'color', 'font', 'typography', 'spacing', 'gradient', 'shadow',
      'rounded', 'padding', 'margin', 'brand', 'consistent', 'hierarchy', 'balance',
    ]) {
      assert.ok(!text.includes(word), `the starter must not have an opinion about ${word}`);
    }
  });
});

describe('the answerability linter', () => {
  const kinds = (line) => lintLine(line).map((f) => f.kind).sort();

  test('it catches the four ways a line cannot be answered', () => {
    assert.deepEqual(kinds('Does it feel premium and modern'), ['unfalsifiable']);
    assert.deepEqual(kinds('Is the hover animation smooth'), ['not-in-a-still']);
    assert.deepEqual(kinds('Body copy hits at least 4.5:1 against the page'), ['measurable']);
    assert.deepEqual(kinds('Is it legible and well spaced against the background'), ['compound']);
    assert.deepEqual(kinds('Clean'), ['too-short', 'unfalsifiable']);
  });

  test('it does not object to what a line asks for, only whether it can be answered', () => {
    // Both of these are opinions, and strong ones. Neither is the linter's
    // business: they can be settled by looking, which is the only test.
    assert.deepEqual(lintLine('The primary action reads as the primary action'), []);
    assert.deepEqual(lintLine('Nothing on the screen is centred except the logo'), []);
  });

  test('"and" is not always two claims', () => {
    // The compound rule has to survive ordinary English or it becomes noise
    // and gets ignored, which is worse than not having it.
    for (const line of [
      'The mark is black and white',
      'Nothing is cut off at the top or bottom',
      'Every piece of text is legible against what is directly behind it',
    ]) {
      assert.deepEqual(lintLine(line), [], line);
    }
  });

  test('a finding keeps the line and its number', () => {
    const found = lintChecklist([{ text: 'Does it feel premium', line: 12 }]);
    assert.equal(found[0].line, 12);
    assert.equal(found[0].text, 'Does it feel premium');
    assert.match(found[0].detail, /unsure/);
  });
});

describe('the checklist command', () => {
  test('--new works before any config exists, and will not overwrite', () => {
    const dir = scratch();
    try {
      const first = cli(['checklist', '--new'], dir);
      assert.equal(first.status, 0, first.stderr);
      assert.ok(existsSync(join(dir, 'design-checklist.md')));
      assert.equal(readFileSync(join(dir, 'design-checklist.md'), 'utf8'), STARTER);

      // The file is yours the moment it lands, so nothing may clobber it.
      const second = cli(['checklist', '--new'], dir);
      assert.equal(second.status, 1);
      assert.match(second.stderr, /already exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--new takes a path, and follows judge.checklist when there is one', () => {
    const dir = scratch();
    try {
      assert.equal(cli(['checklist', '--new', 'rules.md'], dir).status, 0);
      assert.ok(existsSync(join(dir, 'rules.md')));

      writeFileSync(
        join(dir, 'tastecheck.config.json'),
        JSON.stringify({ judge: { checklist: 'from-config.md', shots: ['s/*.png'] } }),
      );
      assert.equal(cli(['checklist', '--new'], dir).status, 0);
      assert.ok(existsSync(join(dir, 'from-config.md')), 'it should follow the configured path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--lint exits 0 on a clean checklist and 1 on one with findings', () => {
    const dir = scratch();
    try {
      writeFileSync(
        join(dir, 'tastecheck.config.json'),
        JSON.stringify({ judge: { checklist: 'c.md', shots: ['s/*.png'] } }),
      );
      writeFileSync(join(dir, 'c.md'), STARTER);
      const clean = cli(['checklist', '--lint'], dir);
      assert.equal(clean.status, 0, clean.stdout + clean.stderr);
      assert.match(clean.stdout, /a judge can answer/);

      writeFileSync(join(dir, 'c.md'), `${STARTER}- Does it feel premium\n`);
      const dirty = cli(['checklist', '--lint'], dir);
      assert.equal(dirty.status, 1);
      assert.match(dirty.stdout, /unfalsifiable/);
      assert.match(dirty.stdout, /c\.md:\d+/, 'a finding should say which line');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bad usage is refused', () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, 'tastecheck.config.json'), JSON.stringify({ judge: { checklist: 'c.md', shots: ['s/*.png'] } }));
      // Neither flag.
      assert.equal(cli(['checklist'], dir).status, 1);
      // --lint on the wrong command.
      assert.equal(cli(['runtime', '--lint'], dir).status, 1);
      // A checklist that is not there.
      assert.equal(cli(['checklist', '--lint'], dir).status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
