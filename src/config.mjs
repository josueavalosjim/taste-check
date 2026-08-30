/**
 * Config loading and validation.
 *
 * Validation is strict on purpose, including rejecting keys it does not know.
 * A misspelled `pairs` key leaves the contrast check with nothing to measure
 * while the run still goes green, and the config still looks correct on the
 * page. The same goes for a pair naming a theme that does not exist: it would
 * match no themes and never be measured.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function stringArray(value, where, errors, { required = true } = {}) {
  if (value === undefined) {
    if (required) errors.push(`${where} is required`);
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    errors.push(`${where} must be an array of strings`);
    return [];
  }
  if (required && !value.length) {
    errors.push(`${where} must not be empty. An empty list narrows the run to nothing.`);
  }
  return value;
}

function rejectUnknown(object, allowed, where, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      errors.push(`${where} has an unknown key "${key}". Allowed: ${allowed.join(', ')}.`);
    }
  }
}

function validateContrast(contrast, errors) {
  rejectUnknown(contrast, ['tokens', 'themes', 'pairs'], 'contrast', errors);
  stringArray(contrast.tokens, 'contrast.tokens', errors);

  const names = new Set();
  if (!Array.isArray(contrast.themes) || !contrast.themes.length) {
    errors.push('contrast.themes must be a non-empty array');
  } else {
    contrast.themes.forEach((theme, i) => {
      const where = `contrast.themes[${i}]`;
      if (!isPlainObject(theme)) {
        errors.push(`${where} must be an object`);
        return;
      }
      rejectUnknown(theme, ['name', 'scopes'], where, errors);
      if (typeof theme.name !== 'string' || !theme.name) errors.push(`${where}.name must be a string`);
      else if (names.has(theme.name)) errors.push(`${where}.name "${theme.name}" is used twice`);
      else names.add(theme.name);

      if (!Array.isArray(theme.scopes) || !theme.scopes.length) {
        errors.push(`${where}.scopes must be a non-empty array`);
        return;
      }
      theme.scopes.forEach((scope, j) => {
        if (typeof scope === 'string') return;
        if (!isPlainObject(scope)) {
          errors.push(`${where}.scopes[${j}] must be a selector string or an object`);
          return;
        }
        rejectUnknown(scope, ['selector', 'atRule'], `${where}.scopes[${j}]`, errors);
        if (typeof scope.selector !== 'string' || !scope.selector) {
          errors.push(`${where}.scopes[${j}].selector must be a string`);
        }
        if (scope.atRule !== undefined && typeof scope.atRule !== 'string') {
          errors.push(`${where}.scopes[${j}].atRule must be a string`);
        }
      });
    });
  }

  if (!Array.isArray(contrast.pairs) || !contrast.pairs.length) {
    errors.push('contrast.pairs must be a non-empty array. With no pairs there is nothing to measure.');
    return;
  }
  contrast.pairs.forEach((pair, i) => {
    const where = `contrast.pairs[${i}]`;
    if (!isPlainObject(pair)) {
      errors.push(`${where} must be an object`);
      return;
    }
    rejectUnknown(pair, ['fg', 'bg', 'min', 'label', 'themes'], where, errors);
    for (const key of ['fg', 'bg']) {
      if (typeof pair[key] !== 'string' || !pair[key]) {
        errors.push(`${where}.${key} must be a token name or a colour`);
      }
    }
    if (typeof pair.min !== 'number' || !Number.isFinite(pair.min) || pair.min <= 0) {
      errors.push(
        `${where}.min must be a positive number. There is no default: WCAG's 4.5 and 3.0 are ` +
          `documented in the README, never assumed here.`,
      );
    }
    if (pair.label !== undefined && typeof pair.label !== 'string') {
      errors.push(`${where}.label must be a string`);
    }
    if (pair.themes !== undefined) {
      const listed = stringArray(pair.themes, `${where}.themes`, errors);
      for (const name of listed) {
        if (names.size && !names.has(name)) {
          errors.push(
            `${where}.themes names "${name}", which is not a theme in contrast.themes. ` +
              `A pair scoped to a theme that does not exist is never measured.`,
          );
        }
      }
    }
  });
}

function validateTreatments(treatments, errors) {
  rejectUnknown(
    treatments,
    ['files', 'elements', 'approvedClasses', 'allowPrefixes', 'approvedValues'],
    'treatments',
    errors,
  );
  stringArray(treatments.files, 'treatments.files', errors);
  stringArray(treatments.elements, 'treatments.elements', errors, { required: false });
  stringArray(treatments.approvedClasses, 'treatments.approvedClasses', errors, { required: false });
  stringArray(treatments.allowPrefixes, 'treatments.allowPrefixes', errors, { required: false });
  stringArray(treatments.approvedValues, 'treatments.approvedValues', errors, { required: false });
  if (treatments.elements !== undefined && Array.isArray(treatments.elements) && !treatments.elements.length) {
    errors.push('treatments.elements must not be empty. Omit it to scan every element.');
  }
}

function validateJudge(judge, errors) {
  rejectUnknown(judge, ['checklist', 'shots', 'shotCommand', 'command', 'failOn'], 'judge', errors);
  if (typeof judge.checklist !== 'string' || !judge.checklist) {
    errors.push('judge.checklist must be a non-empty string');
  }
  // command is optional: an agent carrying the call with --emit and --verdict
  // never needs one, and demanding a placeholder would be theatre.
  for (const key of ['command', 'shotCommand']) {
    if (judge[key] !== undefined && (typeof judge[key] !== 'string' || !judge[key])) {
      errors.push(`judge.${key} must be a non-empty string`);
    }
  }
  stringArray(judge.shots, 'judge.shots', errors);
  if (judge.failOn !== undefined && judge.failOn !== 'never' && judge.failOn !== 'fail') {
    errors.push(
      `judge.failOn must be "never" or "fail", not ${JSON.stringify(judge.failOn)}. ` +
        `It defaults to "never": a model's verdict is an opinion, so it does not gate a build ` +
        `unless you say it should.`,
    );
  }
}

function validateRuntime(runtime, errors) {
  rejectUnknown(
    runtime,
    ['url', 'endpoint', 'browserPath', 'timeout', 'states', 'targets'],
    'runtime',
    errors,
  );
  if (typeof runtime.url !== 'string' || !runtime.url) {
    errors.push('runtime.url must be the page to measure');
  }
  for (const key of ['endpoint', 'browserPath']) {
    if (runtime[key] !== undefined && (typeof runtime[key] !== 'string' || !runtime[key])) {
      errors.push(`runtime.${key} must be a non-empty string`);
    }
  }
  if (runtime.timeout !== undefined && (typeof runtime.timeout !== 'number' || runtime.timeout <= 0)) {
    errors.push('runtime.timeout must be a positive number of milliseconds');
  }
  if (runtime.states !== undefined) {
    if (!Array.isArray(runtime.states) || !runtime.states.length) {
      errors.push('runtime.states must be a non-empty array. Omit it for a single default state.');
    } else {
      const names = new Set();
      runtime.states.forEach((state, i) => {
        const where = `runtime.states[${i}]`;
        if (!isPlainObject(state)) {
          errors.push(`${where} must be an object`);
          return;
        }
        rejectUnknown(state, ['name', 'before', 'after', 'waitFor'], where, errors);
        if (typeof state.name !== 'string' || !state.name) errors.push(`${where}.name must be a string`);
        else if (names.has(state.name)) errors.push(`${where}.name "${state.name}" is used twice`);
        else names.add(state.name);
        for (const key of ['before', 'after', 'waitFor']) {
          if (state[key] !== undefined && typeof state[key] !== 'string') {
            errors.push(`${where}.${key} must be a string`);
          }
        }
      });
    }
  }
  if (!Array.isArray(runtime.targets) || !runtime.targets.length) {
    errors.push('runtime.targets must be a non-empty array. A check with no targets cannot fail.');
    return;
  }
  runtime.targets.forEach((target, i) => {
    const where = `runtime.targets[${i}]`;
    if (!isPlainObject(target)) {
      errors.push(`${where} must be an object`);
      return;
    }
    rejectUnknown(target, ['selector', 'prop', 'min', 'label', 'againstParent'], where, errors);
    for (const key of ['selector', 'prop']) {
      if (typeof target[key] !== 'string' || !target[key]) {
        errors.push(`${where}.${key} must be a non-empty string`);
      }
    }
    if (typeof target.min !== 'number' || !Number.isFinite(target.min) || target.min <= 0) {
      errors.push(`${where}.min must be a positive number`);
    }
    if (target.label !== undefined && typeof target.label !== 'string') {
      errors.push(`${where}.label must be a string`);
    }
    if (target.againstParent !== undefined && typeof target.againstParent !== 'boolean') {
      errors.push(`${where}.againstParent must be a boolean`);
    }
  });
}

/** Validate a parsed config, returning a list of human-readable problems. */
export function validate(config) {
  const errors = [];
  if (!isPlainObject(config)) return ['the config must be a JSON object'];
  rejectUnknown(config, ['$schema', 'contrast', 'treatments', 'judge', 'runtime'], 'the config', errors);

  if (
    config.contrast === undefined &&
    config.treatments === undefined &&
    config.judge === undefined &&
    config.runtime === undefined
  ) {
    errors.push('the config must define at least one of "contrast", "treatments", "runtime" or "judge"');
  }
  if (config.contrast !== undefined) {
    if (isPlainObject(config.contrast)) validateContrast(config.contrast, errors);
    else errors.push('contrast must be an object');
  }
  if (config.treatments !== undefined) {
    if (isPlainObject(config.treatments)) validateTreatments(config.treatments, errors);
    else errors.push('treatments must be an object');
  }
  if (config.judge !== undefined) {
    if (isPlainObject(config.judge)) validateJudge(config.judge, errors);
    else errors.push('judge must be an object');
  }
  if (config.runtime !== undefined) {
    if (isPlainObject(config.runtime)) validateRuntime(config.runtime, errors);
    else errors.push('runtime must be an object');
  }
  return errors;
}

/**
 * Read and validate a config file. Paths inside it resolve against the file's
 * own directory, so a config is portable and can be run from anywhere.
 */
export function load(path) {
  const file = resolve(path);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, errors: [`cannot read ${path}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [`${path} is not valid JSON: ${error.message}`] };
  }
  const errors = validate(parsed);
  if (errors.length) return { ok: false, errors };
  return { ok: true, config: parsed, dir: dirname(file), file };
}
