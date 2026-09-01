/**
 * A small glob, so the tool keeps zero dependencies and behaves the same on
 * every Node it claims to support.
 *
 * Supports the shapes a config actually uses: a literal path, a single-star
 * pattern like `dir/*.ext`, and a double-star pattern matching any depth.
 * Brace expansion is not supported. List the patterns separately.
 *
 * A pattern that matches nothing returns an empty list. Every caller treats
 * that as a failure rather than a clean run, so a typo in a path is reported
 * where it happened instead of showing up as zero findings.
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
 * Absolute paths matching the patterns, plus the patterns that matched
 * nothing.
 *
 * The misses are returned rather than inferred from an empty result, because
 * a list is checked as a union. Two patterns, one naming src and one naming
 * components, with components renamed: the src half still returns every file
 * it matched, so the union is not empty and that whole second tree silently
 * stops being checked. This file's own header promises a typo is reported
 * where it happened, and only a per-pattern answer keeps that promise.
 */
export function expandEach(patterns, cwd) {
  const found = new Set();
  const empty = [];
  for (const pattern of patterns) {
    const before = found.size;
    const absolute = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
    if (!/[*?]/.test(pattern)) {
      if (existsSync(absolute) && statSync(absolute).isFile()) found.add(absolute);
      else empty.push(pattern);
      continue;
    }
    const base = resolve(cwd, baseOf(pattern));
    if (!existsSync(base) || !statSync(base).isDirectory()) {
      empty.push(pattern);
      continue;
    }
    const test = toRegExp(isAbsolute(pattern) ? pattern : resolve(cwd, pattern).split(sep).join('/'));
    for (const file of walk(base, [])) {
      if (test.test(file.split(sep).join('/'))) found.add(file);
    }
    if (found.size === before) empty.push(pattern);
  }
  return { files: [...found].sort(), empty };
}

/** Just the paths, for callers with nothing useful to say about a miss. */
export function expand(patterns, cwd) {
  return expandEach(patterns, cwd).files;
}

/** A path as you would paste it into an editor. */
export const label = (path, cwd) => relative(cwd, path).split(sep).join('/') || path;
