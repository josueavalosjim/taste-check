/**
 * Config loading and validation.
 *
 * Validation is strict on purpose, including rejecting keys it does not know.
 * A misspelled key that silently does nothing is the same bug as a check that
 * cannot fail: the run goes green and the config looks like it is working.
 * The same reasoning covers a pair naming a theme that does not exist, which
 * would otherwise quietly match no themes and never be measured.
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
    errors.push(`${where} must not be empty. A check with nothing to check cannot fail.`);
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
    errors.push('contrast.pairs must be a non-empty array. A check with no pairs cannot fail.');
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

/** Validate a parsed config, returning a list of human-readable problems. */
export function validate(config) {
  const errors = [];
  if (!isPlainObject(config)) return ['the config must be a JSON object'];
  rejectUnknown(config, ['$schema', 'contrast', 'treatments'], 'the config', errors);

  if (config.contrast === undefined && config.treatments === undefined) {
    errors.push('the config must define "contrast", "treatments", or both');
  }
  if (config.contrast !== undefined) {
    if (isPlainObject(config.contrast)) validateContrast(config.contrast, errors);
    else errors.push('contrast must be an object');
  }
  if (config.treatments !== undefined) {
    if (isPlainObject(config.treatments)) validateTreatments(config.treatments, errors);
    else errors.push('treatments must be an object');
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
