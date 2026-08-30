/**
 * The binary, not the modules.
 *
 * Everything in the other file calls the check functions directly, which means
 * the whole suite would stay green with the CLI broken: a bad exit code, a
 * subcommand that silently does nothing, a flag that parses wrong. The exit
 * code is the entire contract for anyone wiring this into CI, so it gets
 * tested through an actual process.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'taste-check.mjs');
const FIXTURE = join(HERE, 'fixture');

const run = (args, env = {}) =>
  spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

const pass = join(FIXTURE, 'pass.config.json');
const fail = join(FIXTURE, 'fail.config.json');
const judgeCfg = join(FIXTURE, 'judge', 'judge.config.json');
const blockingCfg = join(FIXTURE, 'judge', 'blocking.config.json');

describe('the CLI', () => {
  test('a clean config exits 0', () => {
    const r = run(['-c', pass]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /contrast ok/);
    assert.match(r.stdout, /treatments ok/);
  });

  test('a dirty config exits 1 and names what failed', () => {
    const r = run(['-c', fail]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL/);
    assert.match(r.stdout, /promo-huge/);
  });

  test('--only narrows to one check', () => {
    const r = run(['--only', 'treatments', '-c', pass]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /treatments ok/);
    assert.doesNotMatch(r.stdout, /contrast/);
  });

  test('--json emits parseable JSON with a matching ok flag', () => {
    for (const [config, want] of [[pass, true], [fail, false]]) {
      const r = run(['--json', '-c', config]);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, want, config);
      assert.equal(r.status, want ? 0 : 1);
      assert.ok(Array.isArray(parsed.checks));
    }
  });

  test('--help and --version exit 0 and say something', () => {
    const help = run(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /taste-check judge/);
    const version = run(['--version']);
    assert.equal(version.status, 0);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  // Every one of these used to be reachable only by reading the source.
  test('bad usage exits 1 rather than doing something surprising', () => {
    for (const args of [
      ['--nope'],
      ['bogus'],
      ['--only', 'judge', '-c', pass],
      ['--only'],
      ['-c'],
      ['-c', join(FIXTURE, 'does-not-exist.json')],
      ['judge', '--only', 'contrast', '-c', judgeCfg],
      ['judge', '-c', pass],
    ]) {
      const r = run(args);
      assert.equal(r.status, 1, `${args.join(' ')} should exit 1, got ${r.status}`);
      assert.ok(r.stderr.trim().length, `${args.join(' ')} should explain itself`);
    }
  });

  test('a subcommand is only accepted in first position', () => {
    // `taste-check -c x judge` should not quietly run the judge.
    const r = run(['-c', judgeCfg, 'judge']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown command/);
  });

  test('judge exits 0 on an advisory fail and 1 when it blocks', () => {
    const advisory = run(['judge', '-c', judgeCfg], { STUB: 'fail' });
    assert.equal(advisory.status, 0, advisory.stderr || advisory.stdout);
    assert.match(advisory.stdout, /NOTE/);

    const blocking = run(['judge', '-c', blockingCfg], { STUB: 'fail' });
    assert.equal(blocking.status, 1);
    assert.match(blocking.stdout, /FAIL/);
  });

  test('a judge that could not run exits 1 even when advisory', () => {
    for (const mode of ['skipped', 'invented', 'garbage', 'crash']) {
      const r = run(['judge', '-c', judgeCfg], { STUB: mode });
      assert.equal(r.status, 1, `${mode} should exit 1`);
      assert.match(r.stdout, /ERROR/, mode);
    }
  });

  test('--emit prints a prompt and exits 0 without asking anything', () => {
    const r = run(['judge', '--emit', '-c', judgeCfg]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /looking at these images for the first time/);
    assert.match(r.stdout, /Every element on the screen is doing a job/);
  });

  test('--emit still refuses when there is nothing to look at', () => {
    // A prompt for zero screenshots would get a confident verdict about
    // nothing, so the preconditions are enforced before the prompt is handed
    // over rather than after the answer comes back.
    const r = run(['judge', '--emit', '-c', join(FIXTURE, 'judge', 'no-shots.config.json')]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /no screenshots matched/);
  });

  test('--verdict grades a reply from stdin, the same way a command is graded', () => {
    const reply = spawnSync(process.execPath, [join(FIXTURE, 'judge', 'stub.mjs')], {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, STUB: 'fail' },
    }).stdout;

    const advisory = spawnSync(process.execPath, [BIN, 'judge', '--verdict', '-', '-c', judgeCfg], {
      input: reply,
      encoding: 'utf8',
    });
    assert.equal(advisory.status, 0, advisory.stderr);
    assert.match(advisory.stdout, /NOTE/);

    const blocking = spawnSync(process.execPath, [BIN, 'judge', '--verdict', '-', '-c', blockingCfg], {
      input: reply,
      encoding: 'utf8',
    });
    assert.equal(blocking.status, 1);
  });

  test('--verdict catches a reply that dropped a line', () => {
    const reply = spawnSync(process.execPath, [join(FIXTURE, 'judge', 'stub.mjs')], {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, STUB: 'skipped' },
    }).stdout;
    const graded = spawnSync(process.execPath, [BIN, 'judge', '--verdict', '-', '-c', judgeCfg], {
      input: reply,
      encoding: 'utf8',
    });
    assert.equal(graded.status, 1);
    assert.match(graded.stdout, /did not answer/);
  });

  test('--skill prints a path to a file that exists', () => {
    const r = run(['judge', '--skill']);
    assert.equal(r.status, 0);
    assert.ok(existsSync(r.stdout.trim()), r.stdout);
    assert.match(readFileSync(r.stdout.trim(), 'utf8'), /name: taste-check-judge/);
  });

  test('--emit and --verdict belong to judge alone', () => {
    for (const args of [['--emit', '-c', judgeCfg], ['runtime', '--verdict', '-', '-c', judgeCfg], ['judge', '--emit', '--verdict', '-', '-c', judgeCfg]]) {
      const r = run(args);
      assert.equal(r.status, 1, args.join(' '));
      assert.ok(r.stderr.trim().length);
    }
  });

  test('an invalid config is refused before anything runs', () => {
    const r = run(['-c', join(FIXTURE, 'judge', 'checklist.md')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
  });
});
