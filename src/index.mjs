/**
 * The programmatic entry point, for wiring the checks into a test runner or a
 * CI script without going through the CLI.
 */
export { runContrast } from './contrast.mjs';
export { runTreatments } from './treatments.mjs';
export { runTokens, varRefs } from './tokens.mjs';
export { runJudge, prepareJudge, gradeVerdict, buildPrompt, checklistLines, checklistEntries, extractJson } from './judge.mjs';
export { runRuntime } from './runtime.mjs';
export { connect, findBrowser } from './cdp.mjs';
export { load, validate } from './config.mjs';
export { toText, toJson, failed } from './report.mjs';
export { parseColor, contrastRatio, composite, luminance } from './color.mjs';
export { parseDeclarations, resolveScopes, resolveValue } from './css.mjs';
export { openTags, classesOf } from './treatments.mjs';

import { runContrast } from './contrast.mjs';
import { runTreatments } from './treatments.mjs';
import { runTokens } from './tokens.mjs';
import { runJudge } from './judge.mjs';
import { runRuntime } from './runtime.mjs';

/**
 * Run the deterministic checks a config asks for. `only` narrows to one by
 * name. Returns the raw results; formatting and exit codes are the caller's.
 *
 * The judge is deliberately not here. It runs a model, so it belongs behind
 * its own subcommand rather than inside the run whose exit code people wire
 * into CI.
 */
export function run(config, cwd, { only = null } = {}) {
  const results = [];
  if (config.contrast && (!only || only === 'contrast')) {
    results.push(runContrast(config.contrast, cwd));
  }
  if (config.treatments && (!only || only === 'treatments')) {
    results.push(runTreatments(config.treatments, cwd));
  }
  if (config.tokens && (!only || only === 'tokens')) {
    results.push(runTokens(config.tokens, cwd));
  }
  return results;
}

/** Run the judge. Separate from `run` on purpose: see the note above. */
export function judge(config, cwd) {
  return [runJudge(config.judge, cwd)];
}

/**
 * Measure a rendered page. Separate from `run` because it needs a browser and
 * a server that is already up, which is a heavier precondition than reading
 * files off disk, and not one to impose on the check people put in a hook.
 */
export async function runtime(config, cwd) {
  return [await runRuntime(config.runtime, cwd)];
}
