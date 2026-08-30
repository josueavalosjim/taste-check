#!/usr/bin/env node
/**
 * taste-check CLI.
 *
 * Exits 1 on any failure and 0 only when every check ran and passed. "Ran" is
 * load-bearing: a config that matches no files, names a token that does not
 * exist, or scopes a pair to a theme that is not defined is a failure here,
 * not a quiet skip.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { load } from '../src/config.mjs';
import { gradeVerdict, judge, prepareJudge, run, runtime } from '../src/index.mjs';
import { failed, toJson, toText } from '../src/report.mjs';
import { toSarif } from '../src/sarif.mjs';

const USAGE = `taste-check

  taste-check [options]         Run the deterministic checks over your files
  taste-check runtime [options] Measure contrast on a rendered page
  taste-check judge [options]   Ask a fresh-eyes judge about your screenshots

Options:
  -c, --config <path>   Config file (default: tastecheck.config.json)
      --only <name>     Run one check: contrast or treatments
      --emit            judge only: print the prompt and stop, for an agent
                        to carry to a model itself
      --verdict <path>  judge only: grade a reply from a file, or - for stdin
      --skill           Print the path to the bundled agent skill
      --format <kind>   text (default), json, or sarif
      --json            Alias for --format json
  -h, --help            This
      --version         Print the version

Exit code is 1 if any check fails, 0 if every check ran and passed.

--format sarif writes SARIF 2.1.0 on stdout, for a code scanning tab:

  taste-check --format sarif > taste-check.sarif

Every finding points at the line you would edit to change it. A class points
at the markup, a contrast failure at the line in your token file where the
foreground is declared, a judge verdict at the line in your checklist.

runtime is a separate command because it needs a browser and a server that
is already up. It measures what is actually painted, compositing every
background layer behind an element rather than stopping at the first opaque
one, and it can put the page into a state first.

An agent can carry the model call instead of a shell command. --emit prints
the prompt and the images; the agent asks a fresh context and pipes the JSON
back to --verdict -, which checks it against the checklist the same way. Run
taste-check judge --skill for the bundled skill that wires this up.

The judge is a separate command because it runs a model, and a model's
verdict is not reproducible. Its verdicts print as notes and do not affect
the exit code unless judge.failOn is set to "fail". Whether the judge ran
at all is a different question: no screenshots, a command that failed, or
a reply that skipped a checklist line all exit 1 either way.`;

function parseArgs(argv) {
  const options = {
    config: 'tastecheck.config.json',
    only: null,
    format: 'text',
    command: 'check',
    emit: false,
    verdict: null,
    skill: false,
  };
  // One positional, and only in first position, so a stray argument is an
  // error rather than something silently ignored.
  if (argv[0] === 'judge' || argv[0] === 'runtime') {
    options.command = argv[0];
    argv = argv.slice(1);
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      // A bare "-" is a value, not a flag: it is the conventional name for
      // stdin and --verdict takes it.
      if (value === undefined || (value !== '-' && value.startsWith('-'))) {
        throw new Error(`${arg} needs a value`);
      }
      i += 1;
      return value;
    };
    if (arg === '-h' || arg === '--help') return { help: true };
    else if (arg === '--version') return { version: true };
    else if (arg === '-c' || arg === '--config') options.config = next();
    else if (arg === '--only') {
      options.only = next();
      if (options.only !== 'contrast' && options.only !== 'treatments') {
        throw new Error(`--only takes "contrast" or "treatments", not "${options.only}"`);
      }
    } else if (arg === '--json') options.format = 'json';
    else if (arg === '--emit') options.emit = true;
    else if (arg === '--skill') options.skill = true;
    else if (arg === '--verdict') options.verdict = next();
    else if (arg === '--format') {
      options.format = next();
      if (!['text', 'json', 'sarif'].includes(options.format)) {
        throw new Error(`--format takes text, json or sarif, not "${options.format}"`);
      }
    } else if (!arg.startsWith('-')) throw new Error(`unknown command "${arg}"`);
    else throw new Error(`unknown option "${arg}"`);
  }
  return options;
}

const die = (message) => {
  console.error(`taste-check: ${message}`);
  process.exit(1);
};

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  die(`${error.message}\n\n${USAGE}`);
}

if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
if (options.version) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(version);
  process.exit(0);
}

// Printing the bundled skill needs no config: it is the same file every time.
if (options.skill) {
  console.log(fileURLToPath(new URL('../skills/taste-check-judge/SKILL.md', import.meta.url)));
  process.exit(0);
}

for (const flag of ['emit', 'verdict']) {
  if (options[flag] && options.command !== 'judge') {
    die(`--${flag} applies to \`taste-check judge\`, not to ${options.command}`);
  }
}
if (options.emit && options.verdict) die('--emit prints a prompt and --verdict grades a reply, so not both');

const loaded = load(options.config);
if (!loaded.ok) {
  console.error(`taste-check: ${options.config} could not be used:\n`);
  for (const error of loaded.errors) console.error(`  ${error}`);
  process.exit(1);
}

if (options.command !== 'check' && options.only) {
  die(`--only applies to the deterministic checks, not to ${options.command}`);
}

if (options.command !== 'check' && !loaded.config[options.command]) {
  die(`${options.config} defines no "${options.command}" block.`);
}

// --emit stops before any model is involved, so it has no findings to report
// and no exit code to earn. It still refuses to hand back a prompt when the
// screenshots or the checklist are missing.
if (options.emit) {
  const prepared = prepareJudge(loaded.config.judge, loaded.dir);
  if (!prepared.ok) {
    console.log(toText([prepared.result]));
    process.exit(1);
  }
  console.log(prepared.prompt);
  process.exit(0);
}

let results;
if (options.verdict) {
  const prepared = prepareJudge(loaded.config.judge, loaded.dir);
  if (!prepared.ok) {
    console.log(toText([prepared.result]));
    process.exit(1);
  }
  let reply;
  try {
    reply = readFileSync(options.verdict === '-' ? 0 : options.verdict, 'utf8');
  } catch {
    die(`cannot read the verdict from ${options.verdict === '-' ? 'stdin' : options.verdict}`);
  }
  results = [gradeVerdict(reply, prepared, loaded.config.judge)];
} else if (options.command === 'judge') results = judge(loaded.config, loaded.dir);
else if (options.command === 'runtime') results = await runtime(loaded.config, loaded.dir);
else results = run(loaded.config, loaded.dir, { only: options.only });

if (!results.length) {
  die(`nothing to run. ${options.config} defines no ${options.only ?? 'contrast or treatments'} check.`);
}

if (options.format === 'sarif') {
  const { version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  console.log(toSarif(results, { version, configFile: options.config, configDir: loaded.dir }));
} else {
  console.log(options.format === 'json' ? toJson(results) : toText(results));
}
process.exit(failed(results) ? 1 : 0);
