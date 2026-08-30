/**
 * SARIF 2.1.0 output, so findings land in a code scanning tab instead of only
 * in a log nobody opens.
 *
 * The part worth getting right is locations. A format conversion that emits
 * every finding against the config file is technically valid SARIF and useless
 * in practice: the annotations all pile onto one line and none of them say
 * where the problem is.
 *
 * So every finding points at the line you would edit to change it. An
 * unapproved class points at the markup. A contrast failure points at the line
 * in the token file where the foreground is declared, which is the half of a
 * pair you usually end up moving. A judge verdict points at the line in your
 * checklist. Where a finding genuinely has no file behind it, it points at the
 * config, because that is where the rule was written.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { linesFor } from './report.mjs';

const HELP = 'https://github.com/josueavalosjim/taste-check#readme';

/**
 * Levels are the same judgement the exit code makes. A judge verdict is
 * advisory, so it is a note; everything that gates the build is an error.
 */
const RULES = [
  ['contrast/below-floor', 'error', 'A declared pair is under the ratio it was given.'],
  ['contrast/unmeasurable', 'error', 'A pair could not be measured: a missing token, a dead scope, a translucent background, or a colour that would not parse.'],
  ['treatments/unapproved-class', 'error', 'A class name that is not on the approved list.'],
  ['treatments/one-off-value', 'error', 'A literal colour or length hardcoded into an inline style.'],
  ['treatments/unscannable', 'error', 'No markup matched, so nothing was checked.'],
  ['runtime/below-floor', 'error', 'A target on the rendered page is under the ratio it was given.'],
  ['runtime/unmeasurable', 'error', 'A target could not be measured: no element, nothing rendered, an edge with no width, or no browser.'],
  ['judge/verdict', 'note', 'A checklist line the judge did not pass. Advisory: a model verdict is not reproducible.'],
  ['judge/did-not-run', 'error', 'The judge could not run, which is a fact rather than an opinion.'],
];

const index = new Map(RULES.map(([id], i) => [id, i]));

/**
 * SARIF URIs are relative to the run's root, which for code scanning is the
 * repository. Paths inside a config are relative to the config file, so they
 * have to be re-rooted here. Getting this wrong does not fail validation, it
 * just hangs every annotation on a path that does not exist.
 */
function uriFor(file, { configDir, root }) {
  const absolute = resolve(configDir, file);
  return relative(root, absolute).split(sep).join('/');
}

/**
 * A fingerprint keyed to the content of the line rather than to its number.
 *
 * This is what keeps an alert the same alert when the file shifts. Without it
 * every finding below an added import reads as a new problem and an old one
 * closed, which turns the code scanning tab into churn and trains people to
 * ignore it. Hashing the line's text rather than its position is what survives
 * the shift. The rule id and a key naming what the finding is about are in
 * there too, because two one-off values on the same line are two findings and
 * a fingerprint that collides makes them one. The key is an identity, not the
 * message: rewording a message must not close an alert and open a new one.
 */
function fingerprint(uri, line, ruleId, key, ctx) {
  let text = '';
  try {
    text = (readFileSync(resolve(ctx.root, uri), 'utf8').split('\n')[line - 1] ?? '').trim();
  } catch {
    /* a file we cannot read still gets a stable fingerprint from its path */
  }
  return {
    primaryLocationLineHash: createHash('sha256')
      .update(`${ruleId}\u0000${uri}\u0000${text}\u0000${key}`)
      .digest('hex')
      .slice(0, 32),
  };
}

const location = (file, ctx, line) => ({
  physicalLocation: {
    artifactLocation: { uri: uriFor(file, ctx), uriBaseId: '%SRCROOT%' },
    // A region with no line is invalid, and line 1 is the honest fallback for
    // "this file, we cannot be more specific".
    region: { startLine: Math.max(1, line ?? 1) },
  },
});

function resultsFor(check, ctx) {
  const here = location(ctx.configFile, { ...ctx, configDir: ctx.root }, 1);
  const out = [];

  if (check.name === 'contrast' || check.name === 'runtime') {
    for (const sample of check.samples ?? []) {
      if (sample.pass) continue;
      out.push({
        ruleId: `${check.name}/below-floor`,
        key: `${sample.fg}|${sample.bg}|${sample.theme}`,
        level: 'error',
        message: {
          text:
            `${sample.ratio.toFixed(2)}:1 against a floor of ${sample.min} for ${sample.fg} on ` +
            `${sample.bg} in ${sample.theme}${sample.note ? `. ${sample.note}` : ''}`,
        },
        locations: [sample.at ? location(sample.at.file, ctx, sample.at.line) : here],
      });
    }
    for (const problem of check.problems ?? []) {
      out.push({
        ruleId: `${check.name}/unmeasurable`,
        key: problem,
        level: 'error',
        message: { text: problem },
        locations: [here],
      });
    }
    return out;
  }

  if (check.name === 'treatments') {
    for (const failure of check.failures ?? []) {
      out.push({
        ruleId: failure.rule,
        key: `${failure.subject ?? failure.message}`,
        level: 'error',
        message: { text: failure.message },
        locations: [location(failure.file, ctx, failure.line)],
      });
    }
    for (const problem of check.problems ?? []) {
      out.push({
        ruleId: 'treatments/unscannable',
        key: problem,
        level: 'error',
        message: { text: problem },
        locations: [here],
      });
    }
    return out;
  }

  if (check.name === 'judge') {
    for (const finding of check.findings ?? []) {
      if (finding.verdict === 'pass') continue;
      out.push({
        ruleId: 'judge/verdict',
        key: finding.line,
        // Mirrors the exit code: advisory unless the config opted into blocking.
        level: check.failOn === 'fail' && finding.verdict === 'fail' ? 'warning' : 'note',
        message: { text: `${finding.verdict}: ${finding.line}${finding.why ? `. ${finding.why}` : ''}` },
        locations: [finding.at ? location(finding.at.file, ctx, finding.at.line) : here],
      });
    }
    for (const problem of check.problems ?? []) {
      out.push({
        ruleId: 'judge/did-not-run',
        key: problem,
        level: 'error',
        message: { text: problem },
        locations: [here],
      });
    }
  }
  return out;
}

/** Attach a fingerprint to each result, derived from where it points. */
function withFingerprints(found, ctx) {
  return found.map((r) => {
    const place = r.locations[0].physicalLocation;
    const { key, ...rest } = r;
    return {
      ...rest,
      partialFingerprints: fingerprint(
        place.artifactLocation.uri,
        place.region.startLine,
        r.ruleId,
        r.key ?? r.message.text,
        ctx,
      ),
    };
  });
}

export function toSarif(results, { version, configFile, configDir, root = process.cwd() }) {
  const ctx = {
    configFile: configFile ?? 'tastecheck.config.json',
    configDir: configDir ?? root,
    root,
  };
  const found = results.flatMap((check) => resultsFor(check, ctx));
  // Only the rules that actually fired, so the tab is not padded with rules
  // this run had no opinion about.
  const fired = [...new Set(found.map((r) => r.ruleId))];

  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'taste-check',
              version,
              informationUri: HELP,
              rules: fired.map((id) => {
                const [, level, description] = RULES[index.get(id)];
                return {
                  id,
                  name: id.replace(/[/-](.)/g, (_, c) => c.toUpperCase()),
                  shortDescription: { text: description },
                  helpUri: HELP,
                  defaultConfiguration: { level },
                };
              }),
            },
          },
          results: withFingerprints(found, ctx).map((r) => ({
            ...r,
            ruleIndex: fired.indexOf(r.ruleId),
          })),
        },
      ],
    },
    null,
    2,
  );
}

/** Every rule this tool can emit, for the docs and for the tests to check. */
export const ruleIds = () => RULES.map(([id]) => id);

// Re-exported so a caller does not have to know that a note is not a failure.
export { linesFor };
