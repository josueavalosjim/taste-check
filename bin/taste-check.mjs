#!/usr/bin/env node
/**
 * taste-check CLI.
 *
 * Exits 1 on any failure and 0 only when every check ran and passed. "Ran" is
 * load-bearing: a config that matches no files, names a token that does not
 * exist, or scopes a pair to a theme that is not defined is a failure here,
 * not a quiet skip.
 */
import { load } from '../src/config.mjs';
import { judge, run, runtime } from '../src/index.mjs';
import { failed, toJson, toText } from '../src/report.mjs';

const USAGE = `taste-check

  taste-check [options]         Run the deterministic checks over your files
  taste-check runtime [options] Measure contrast on a rendered page
  taste-check judge [options]   Ask a fresh-eyes judge about your screenshots

Options:
  -c, --config <path>   Config file (default: tastecheck.config.json)
      --only <name>     Run one check: contrast or treatments
      --json            Machine-readable output
  -h, --help            This
      --version         Print the version

Exit code is 1 if any check fails, 0 if every check ran and passed.

runtime is a separate command because it needs a browser and a server that
is already up. It measures what is actually painted, compositing every
background layer behind an element rather than stopping at the first opaque
one, and it can put the page into a state first.

The judge is a separate command because it runs a model, and a model's
verdict is not reproducible. Its verdicts print as notes and do not affect
the exit code unless judge.failOn is set to "fail". Whether the judge ran
at all is a different question: no screenshots, a command that failed, or
a reply that skipped a checklist line all exit 1 either way.`;

function parseArgs(argv) {
  const options = { config: 'tastecheck.config.json', only: null, json: false, command: 'check' };
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
      if (value === undefined || value.startsWith('-')) throw new Error(`${arg} needs a value`);
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
    } else if (arg === '--json') options.json = true;
    else if (!arg.startsWith('-')) throw new Error(`unknown command "${arg}"`);
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
  const { version } = JSON.parse(
    await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ),
  );
  console.log(version);
  process.exit(0);
}

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

let results;
if (options.command === 'judge') results = judge(loaded.config, loaded.dir);
else if (options.command === 'runtime') results = await runtime(loaded.config, loaded.dir);
else results = run(loaded.config, loaded.dir, { only: options.only });

if (!results.length) {
  die(`nothing to run. ${options.config} defines no ${options.only ?? 'contrast or treatments'} check.`);
}

console.log(options.json ? toJson(results) : toText(results));
process.exit(failed(results) ? 1 : 0);
