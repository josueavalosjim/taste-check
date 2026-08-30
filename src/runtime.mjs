/**
 * Contrast measured off a rendered page.
 *
 * This is the check the contrast module is a static approximation of. A token
 * file says what a colour is declared to be. A rendered page says what is
 * actually painted, which is a different question the moment anything is
 * translucent, inherited, set by a component, or overridden by a state.
 *
 * Two things it does that reading tokens cannot:
 *
 *   1. It composites the whole background stack, nearest layer first, rather
 *      than measuring against the first opaque ancestor. White text on a dark
 *      scrim over a light page reads 1.04:1 if you skip the scrim and 10.57:1
 *      if you do not. One of those is a false failure, and the same shortcut
 *      produces a false pass with the colours the other way round.
 *
 *   2. It can measure a state, because it can put the page into one first.
 *      A theme, an opened panel, a focused input.
 *
 * A foreground composites over its own background. An edge measures against
 * what is outside it. Those are different questions and getting them the same
 * way round produces confident nonsense in both directions.
 *
 * A selector that matches nothing is a failure, not a skipped target. So is a
 * border with no width: you asked for the contrast of an edge that is not
 * being drawn, and the honest answer is that the question is wrong.
 */
import { contrastRatio, flatten, isOpaque, parseColor } from './color.mjs';
import { connect } from './cdp.mjs';

/**
 * Runs in the page. Returns the foreground and the stack of backgrounds behind
 * it, and leaves every judgement to the caller so that the reasoning lives in
 * one place rather than half here and half in a string.
 */
const MEASURE = `(targets) => targets.map(({ selector, prop, againstParent }) => {
  const el = document.querySelector(selector);
  if (!el) return { error: 'matched no element' };
  if (!el.getClientRects().length) return { error: 'matched an element that is not rendered' };
  const cs = getComputedStyle(el);
  const fg = cs[prop];
  if (!fg) return { error: 'has no ' + prop };
  if (prop.startsWith('border')) {
    const side = prop.replace(/^border|Color$/g, '');
    const width = parseFloat(cs['border' + (side || 'Top') + 'Width']);
    if (!width) return { error: 'has a ' + prop + ' but no width, so no edge is drawn' };
  }
  const layers = [];
  // Two reasons to start one level up.
  //
  // A fill measured against itself scores 1.00, so againstParent hands us the
  // parent instead.
  //
  // A border is the same, for a different reason. 1.4.11 asks whether the
  // boundary of a control can be told apart from what is adjacent to it, and
  // what is adjacent is the page, not the control's own fill. A solid button
  // that sets its border to its own background colour measures 1.00:1 against
  // that background: true, and an answer to a question nobody asked.
  const outside = againstParent || prop.indexOf('border') === 0;
  let node = outside ? el.parentElement : el;
  if (!node) return { error: 'has no parent to measure against' };
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    const m = bg && bg.match(/rgba?\\(([^)]+)\\)/);
    if (m) {
      const p = m[1].split(/[,\\/]/).map((v) => parseFloat(v.trim()));
      const alpha = p.length > 3 ? p[3] : 1;
      if (alpha > 0) {
        layers.push(bg);
        if (alpha > 0.999) break;
      }
    }
    node = node.parentElement;
  }
  const root = getComputedStyle(document.documentElement).backgroundColor;
  return { fg, layers, root, text: (el.textContent || '').trim().slice(0, 40) };
})`;

export async function runRuntime(config, cwd, { connect: open = connect } = {}) {
  const samples = [];
  const problems = [];
  const { url, endpoint, browserPath, timeout, states = [{ name: 'default' }], targets } = config;

  let page;
  try {
    page = await open({ endpoint, browserPath, timeout });
  } catch (error) {
    problems.push(error.message);
    return { name: 'runtime', samples, problems, summary: '' };
  }

  try {
    for (const state of states) {
      // `before` runs on every navigation ahead of the page's own scripts, so
      // a theme read at boot sees it. Running it after load and reloading
      // would undo any DOM change; running it after load without reloading is
      // too late for anything the page reads once. It is removed again after
      // the state is measured, or the next state inherits it.
      let initScript = null;
      if (state.before) initScript = await page.onNewDocument(state.before);

      await page.goto(url);
      // `after` is the other half: opening a panel, focusing a field, anything
      // that only exists once there is a document to act on.
      if (state.after) await page.evaluate(state.after);
      if (state.waitFor) {
        await page.evaluate(
          `new Promise((resolve, reject) => {
            const done = () => document.querySelector(${JSON.stringify(state.waitFor)});
            if (done()) return resolve(true);
            const t = setInterval(() => { if (done()) { clearInterval(t); resolve(true); } }, 50);
            setTimeout(() => { clearInterval(t); reject(new Error('waitFor ${state.waitFor} never appeared')); }, 10000);
          })`,
        );
      }

      const measured = await page.evaluate(`(${MEASURE})(${JSON.stringify(targets)})`);

      targets.forEach((target, i) => {
        const found = measured[i];
        const where = `${target.selector} { ${target.prop} }`;
        if (found.error) {
          problems.push(`state "${state.name}": ${where} ${found.error}`);
          return;
        }
        const fg = parseColor(found.fg);
        if (!fg.ok) {
          problems.push(`state "${state.name}": ${where} ${fg.reason}`);
          return;
        }
        const layers = [];
        for (const raw of found.layers) {
          const parsed = parseColor(raw);
          if (!parsed.ok) {
            problems.push(`state "${state.name}": ${where} background ${parsed.reason}`);
            return;
          }
          layers.push(parsed.rgba);
        }
        // Nothing opaque anywhere up the tree means the canvas is showing
        // through, and the canvas is whatever the root paints.
        if (!layers.length || !isOpaque(layers[layers.length - 1])) {
          const root = parseColor(found.root);
          layers.push(root.ok && isOpaque(root.rgba) ? root.rgba : [255, 255, 255, 1]);
        }

        const ground = flatten(layers);
        const ratio = contrastRatio(fg.rgba, ground);
        samples.push({
          theme: state.name,
          fg: target.selector,
          bg: `${target.prop}, ${layers.length} ${layers.length === 1 ? 'layer' : 'layers'}`,
          note: target.label ?? found.text ?? '',
          ratio,
          min: target.min,
          pass: ratio >= target.min,
        });
      });

      if (initScript) await page.removeNewDocumentScript(initScript);
    }
  } catch (error) {
    problems.push(`the page could not be measured: ${error.message}`);
  } finally {
    await page.close();
  }

  return {
    name: 'runtime',
    samples,
    problems,
    summary: `${samples.length} ${samples.length === 1 ? 'target' : 'targets'} across ${
      states.length
    } ${states.length === 1 ? 'state' : 'states'}`,
  };
}
