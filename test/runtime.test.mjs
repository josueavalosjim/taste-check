/**
 * The runtime check, in two halves.
 *
 * Most of it runs against a fake page object, because the logic worth testing
 * is what taste-check does with what a browser hands back: compositing the
 * stack, refusing a target that matched nothing, keeping one state from
 * leaking into the next. None of that needs a browser, and a suite that needs
 * one is a suite people skip.
 *
 * The last block does drive a real headless Chrome, and skips itself when
 * there is none. That one exists because everything above agrees with my idea
 * of what a browser returns, which is exactly the assumption worth checking.
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findBrowser } from '../src/cdp.mjs';
import { failed } from '../src/report.mjs';
import { runRuntime } from '../src/runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = `file://${join(HERE, 'fixture', 'runtime', 'page.html')}`;

/** A stand-in browser that replays whatever the test wants measured. */
function fakePage(measurements, log = []) {
  let index = 0;
  return {
    async goto(url) {
      log.push(`goto ${url}`);
    },
    async evaluate(expression) {
      if (expression.startsWith('(')) {
        const value = measurements[Math.min(index, measurements.length - 1)];
        index += 1;
        return value;
      }
      log.push(`evaluate ${expression}`);
      return true;
    },
    async onNewDocument(source) {
      log.push(`init ${source}`);
      return `script-${log.length}`;
    },
    async removeNewDocumentScript(id) {
      log.push(`remove ${id}`);
    },
    close() {
      log.push('close');
    },
  };
}

const target = { selector: '.x', prop: 'color', min: 4.5 };
const measure = (config, measurements, log = []) =>
  runRuntime(config, HERE, { connect: async () => fakePage(measurements, log) });

describe('runtime, against a fake page', () => {
  test('the whole background stack is composited, not just the first opaque one', async () => {
    // White on a 75% black scrim over a near-white page. Stopping at the first
    // opaque ancestor measures the white against the page and calls it 1.04,
    // a failure it has not earned.
    const result = await measure({ url: PAGE, targets: [target] }, [
      [{ fg: 'rgb(255, 255, 255)', layers: ['rgba(0, 0, 0, 0.75)', 'rgb(251, 251, 250)'], root: 'rgb(251, 251, 250)' }],
    ]);
    assert.deepEqual(result.problems, []);
    assert.equal(result.samples[0].ratio.toFixed(2), '10.57');
    assert.equal(result.samples[0].pass, true);
  });

  test('the same shortcut the other way round would be a false pass', async () => {
    const result = await measure({ url: PAGE, targets: [target] }, [
      [{ fg: 'rgba(255, 255, 255, 0.95)', layers: ['rgba(255, 255, 255, 0.92)', 'rgb(20, 23, 28)'], root: 'rgb(20, 23, 28)' }],
    ]);
    assert.equal(result.samples[0].pass, false);
    assert.ok(result.samples[0].ratio < 1.3);
  });

  test('a transparent element falls through to the root background', async () => {
    const result = await measure({ url: PAGE, targets: [target] }, [
      [{ fg: 'rgb(0, 0, 0)', layers: [], root: 'rgb(255, 255, 255)' }],
    ]);
    assert.deepEqual(result.problems, []);
    assert.equal(result.samples[0].ratio.toFixed(2), '21.00');
  });

  // Each of these is the page telling us the question was wrong, and each has
  // to fail rather than quietly produce one fewer sample.
  for (const [name, error] of [
    ['a selector matching nothing', 'matched no element'],
    ['an element that is not rendered', 'matched an element that is not rendered'],
    ['a border with no width', 'has a borderTopColor but no width, so no edge is drawn'],
  ]) {
    test(`${name} fails`, async () => {
      const result = await measure({ url: PAGE, targets: [target] }, [[{ error }]]);
      assert.equal(failed([result]), true);
      assert.match(result.problems[0], new RegExp(error.split(',')[0]));
      assert.equal(result.samples.length, 0);
    });
  }

  test('a state runs before the page and is removed after it', async () => {
    const log = [];
    await measure(
      {
        url: PAGE,
        states: [
          { name: 'light' },
          { name: 'dark', before: "localStorage.setItem('theme','dark')", after: 'document.body.click()' },
        ],
        targets: [target],
      },
      [[{ fg: 'rgb(0,0,0)', layers: ['rgb(255,255,255)'], root: 'rgb(255,255,255)' }]],
      log,
    );
    const init = log.findIndex((l) => l.startsWith('init '));
    const goto = log.findIndex((l, i) => i > init && l.startsWith('goto '));
    const remove = log.findIndex((l) => l.startsWith('remove '));
    assert.ok(init !== -1, 'before should register an init script');
    assert.ok(goto > init, 'the init script must be registered before navigating');
    assert.ok(remove > goto, 'and removed after, so it cannot leak into the next state');
    assert.ok(log.includes('evaluate document.body.click()'), 'after should run once there is a document');
  });

  test('a browser that cannot be reached is reported, not thrown', async () => {
    const result = await runRuntime({ url: PAGE, targets: [target] }, HERE, {
      connect: async () => {
        throw new Error('no CDP endpoint at http://127.0.0.1:9');
      },
    });
    assert.equal(failed([result]), true);
    assert.match(result.problems[0], /no CDP endpoint/);
    assert.equal(result.samples.length, 0);
  });
});

describe('runtime, against a real browser', { skip: findBrowser() ? false : 'no Chrome found' }, () => {
  test('it measures the fixture page and the states differ', async () => {
    const result = await runRuntime(
      {
        url: PAGE,
        timeout: 30000,
        states: [
          { name: 'light' },
          {
            name: 'dark',
            before:
              "document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-theme','dark'))",
          },
        ],
        targets: [
          { selector: '.caption', prop: 'color', min: 4.5 },
          { selector: '.on-scrim', prop: 'color', min: 4.5 },
          { selector: '.on-veil', prop: 'color', min: 4.5 },
        ],
      },
      HERE,
    );

    assert.deepEqual(result.problems, [], result.problems.join('\n'));
    assert.equal(result.samples.length, 6);

    const at = (selector, theme) => result.samples.find((s) => s.fg === selector && s.theme === theme);

    // The two that a token file, or a first-opaque-ancestor walk, gets wrong.
    assert.equal(at('.on-scrim', 'light').ratio.toFixed(2), '10.57');
    assert.equal(at('.on-veil', 'light').pass, false);

    // And proof the state actually applied, rather than dark quietly
    // reporting light's numbers.
    assert.notEqual(
      at('.caption', 'light').ratio.toFixed(2),
      at('.caption', 'dark').ratio.toFixed(2),
      'the dark state measured the same values as light, so it did not apply',
    );
  });
});
