/**
 * A small glob, so the tool keeps zero dependencies and behaves the same on
 * every Node it claims to support.
 *
 * Supports the shapes a config actually uses: a literal path, a single-star
 * pattern like `dir/*.ext`, and a double-star pattern matching any depth.
 * Brace expansion is not supported. List the patterns separately.
 *
 * A pattern that matches nothing is not this module's problem to report, but
 * it is always somebody's: every caller treats an empty match as a failure.
 * A run over zero files that prints "clean" is the exact failure mode this
 * whole tool exists to prevent.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const ESCAPE = /[.+^${}()|[\]\\]/g;

function toRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern.slice(i, i + 3) === '**/') {
        out += '(?:[^/]*/)*';
        i += 2;
      } else if (pattern.slice(i, i + 2) === '**') {
        out += '.*';
        i += 1;
      } else out += '[^/]*';
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    out += c.replace(ESCAPE, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** The longest wildcard-free directory prefix, so we only walk what we must. */
function baseOf(pattern) {
  const parts = pattern.split('/');
  const stop = parts.findIndex((p) => p.includes('*') || p.includes('?'));
  return (stop === -1 ? parts.slice(0, -1) : parts.slice(0, stop)).join('/');
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/**
 * Absolute paths matching the patterns, relative to `cwd`, sorted and
 * de-duplicated so a run is reproducible and a report is diffable.
 */
export function expand(patterns, cwd) {
  const found = new Set();
  for (const pattern of patterns) {
    const absolute = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
    if (!/[*?]/.test(pattern)) {
      if (existsSync(absolute) && statSync(absolute).isFile()) found.add(absolute);
      continue;
    }
    const base = resolve(cwd, baseOf(pattern));
    if (!existsSync(base) || !statSync(base).isDirectory()) continue;
    const test = toRegExp(isAbsolute(pattern) ? pattern : resolve(cwd, pattern).split(sep).join('/'));
    for (const file of walk(base, [])) {
      if (test.test(file.split(sep).join('/'))) found.add(file);
    }
  }
  return [...found].sort();
}

/** A path as you would paste it into an editor. */
export const label = (path, cwd) => relative(cwd, path).split(sep).join('/') || path;
