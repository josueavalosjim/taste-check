/**
 * SARIF is easy to emit and easy to emit uselessly.
 *
 * A document can satisfy the schema completely and still be worthless in a
 * code scanning tab, because every annotation hangs off a path that does not
 * exist or off line 1 of the config. So the tests here are mostly about
 * locations: that each URI resolves to a real file from the run's root, and
 * that a finding points at the line you would edit rather than at the tool.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from '../src/config.mjs';
import { run, judge } from '../src/index.mjs';
import { ruleIds, toSarif } from '../src/sarif.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIXTURE = join(HERE, 'fixture');

function sarifFor(configName, { asJudge = false, stub } = {}) {
  const path = join(FIXTURE, configName);
  const loaded = load(path);
  assert.equal(loaded.ok, true, loaded.errors?.join('; '));
  const previous = process.env.STUB;
  if (stub) process.env.STUB = stub;
  try {
    const results = asJudge ? judge(loaded.config, loaded.dir) : run(loaded.config, loaded.dir);
    return JSON.parse(
      toSarif(results, {
        version: '0.0.0-test',
        configFile: path,
        configDir: loaded.dir,
        root: ROOT,
      }),
    );
  } finally {
    if (previous === undefined) delete process.env.STUB;
    else process.env.STUB = previous;
  }
}

const resultsOf = (doc) => doc.runs[0].results;
const rulesOf = (doc) => doc.runs[0].tool.driver.rules;
const uriOf = (r) => r.locations[0].physicalLocation.artifactLocation.uri;

describe('SARIF', () => {
  const dirty = sarifFor('fail.config.json');

  test('the envelope is what a consumer expects', () => {
    assert.equal(dirty.version, '2.1.0');
    assert.match(dirty.$schema, /sarif-2\.1\.0/);
    assert.equal(dirty.runs.length, 1);
    assert.equal(dirty.runs[0].tool.driver.name, 'taste-check');
    assert.equal(dirty.runs[0].tool.driver.version, '0.0.0-test');
    assert.match(dirty.runs[0].tool.driver.informationUri, /^https:\/\//);
  });

  test('every result is complete enough to render', () => {
    assert.ok(resultsOf(dirty).length > 0, 'the dirty fixture should produce findings');
    for (const r of resultsOf(dirty)) {
      assert.ok(r.message?.text, 'a result needs message text');
      assert.ok(['error', 'warning', 'note'].includes(r.level), r.level);
      const region = r.locations[0].physicalLocation.region;
      assert.ok(Number.isInteger(region.startLine) && region.startLine >= 1, 'startLine must be 1 or more');
    }
  });

  test('every ruleId is declared, and ruleIndex agrees with it', () => {
    const declared = rulesOf(dirty).map((r) => r.id);
    for (const r of resultsOf(dirty)) {
      assert.ok(declared.includes(r.ruleId), `${r.ruleId} is not declared`);
      assert.equal(declared[r.ruleIndex], r.ruleId, `ruleIndex is wrong for ${r.ruleId}`);
    }
    // Only what fired, so the tab is not padded with rules this run had no
    // opinion about.
    assert.ok(declared.length < ruleIds().length);
    assert.deepEqual([...new Set(resultsOf(dirty).map((r) => r.ruleId))].sort(), [...declared].sort());
  });

  // The one that decides whether any of this is worth having.
  test('every location resolves to a file that exists', () => {
    for (const r of resultsOf(dirty)) {
      const uri = uriOf(r);
      assert.ok(!uri.startsWith('/'), `${uri} should be relative to the run root`);
      assert.ok(!uri.includes('\\'), `${uri} should use posix separators`);
      assert.ok(existsSync(resolve(ROOT, uri)), `${uri} does not exist`);
    }
  });

  test('a contrast failure points at the token, not at the config', () => {
    const found = resultsOf(dirty).find((r) => r.ruleId === 'contrast/below-floor');
    assert.ok(found, 'the dirty fixture has a failing pair');
    const uri = uriOf(found);
    assert.match(uri, /tokens\.css$/);
    // And at the line the failing token is actually declared on.
    const line = readFileSync(resolve(ROOT, uri), 'utf8').split('\n')[
      found.locations[0].physicalLocation.region.startLine - 1
    ];
    assert.match(line, /--hairline/, `pointed at "${line.trim()}"`);
  });

  test('a class points at the markup, on its own line', () => {
    const found = resultsOf(dirty).find((r) => r.ruleId === 'treatments/unapproved-class');
    const uri = uriOf(found);
    assert.match(uri, /bad\.jsx$/);
    const line = readFileSync(resolve(ROOT, uri), 'utf8').split('\n')[
      found.locations[0].physicalLocation.region.startLine - 1
    ];
    assert.match(line, /promo-huge/);
  });

  test('a clean run is still valid SARIF, with nothing in it', () => {
    const clean = sarifFor('pass.config.json');
    assert.equal(clean.version, '2.1.0');
    assert.deepEqual(resultsOf(clean), []);
    assert.deepEqual(rulesOf(clean), []);
  });

  test('every finding has a distinct fingerprint', () => {
    // Two one-off values on one line are two findings. A fingerprint that
    // collides merges them into one alert and loses the other.
    const prints = resultsOf(dirty).map((r) => r.partialFingerprints?.primaryLocationLineHash);
    assert.ok(prints.every(Boolean), 'every result needs a fingerprint');
    assert.equal(new Set(prints).size, prints.length, 'fingerprints must not collide');
    assert.ok(resultsOf(dirty).every((r) => !('key' in r)), 'the internal key must not be emitted');
  });

  test('a fingerprint survives the file moving underneath it', () => {
    // The whole reason for hashing the line's content rather than its number:
    // add an import at the top of a file and every finding below it should
    // stay the same alert, not close and reopen as a new one.
    const dir = mkdtempSync(join(tmpdir(), 'taste-check-fp-'));
    try {
      cpSync(FIXTURE, dir, { recursive: true });
      const config = join(dir, 'fail.config.json');
      const prints = () => {
        const loaded = load(config);
        const doc = JSON.parse(
          toSarif(run(loaded.config, loaded.dir), {
            version: '0.0.0-test',
            configFile: config,
            configDir: loaded.dir,
            root: dir,
          }),
        );
        return Object.fromEntries(
          resultsOf(doc)
            .filter((r) => r.ruleId.startsWith('treatments'))
            .map((r) => [r.message.text, [r.partialFingerprints.primaryLocationLineHash, r.locations[0].physicalLocation.region.startLine]]),
        );
      };

      const before = prints();
      const markup = join(dir, 'markup', 'bad.jsx');
      writeFileSync(markup, `// pushed down\n// by two lines\n${readFileSync(markup, 'utf8')}`);
      const after = prints();

      assert.ok(Object.keys(before).length >= 3);
      for (const [message, [hash, line]] of Object.entries(before)) {
        assert.ok(after[message], `${message} disappeared`);
        assert.equal(after[message][0], hash, `the fingerprint for ${message} changed`);
        assert.equal(after[message][1], line + 2, 'and the line really did move');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a judge verdict is a note, and points at the checklist line', () => {
    const doc = sarifFor(join('judge', 'judge.config.json'), { asJudge: true, stub: 'fail' });
    const verdicts = resultsOf(doc).filter((r) => r.ruleId === 'judge/verdict');
    assert.ok(verdicts.length > 0);
    assert.ok(verdicts.every((r) => r.level === 'note'), 'advisory by default');
    const found = verdicts[0];
    const line = readFileSync(resolve(ROOT, uriOf(found)), 'utf8').split('\n')[
      found.locations[0].physicalLocation.region.startLine - 1
    ];
    assert.match(line, /Nothing important is cut off/);
  });

  test('failOn: fail raises the verdict but not the unsure', () => {
    const doc = sarifFor(join('judge', 'blocking.config.json'), { asJudge: true, stub: 'fail' });
    const byLevel = Object.fromEntries(
      resultsOf(doc).map((r) => [r.message.text.split(':')[0], r.level]),
    );
    assert.equal(byLevel.fail, 'warning');
    assert.equal(byLevel.unsure, 'note', 'unsure is not a verdict against the screen');
  });

  test('a judge that could not run is an error, not a note', () => {
    const doc = sarifFor(join('judge', 'judge.config.json'), { asJudge: true, stub: 'skipped' });
    const problems = resultsOf(doc).filter((r) => r.ruleId === 'judge/did-not-run');
    assert.ok(problems.length > 0);
    assert.ok(problems.every((r) => r.level === 'error'));
  });
});
