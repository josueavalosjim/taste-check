#!/usr/bin/env node
// Stands in for a real model command. It reads the prompt on stdin like the
// real thing would, ignores it, and prints whatever the test asked for.
import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
const mode = process.env.STUB ?? 'clean';
const LINES = [
  'Every element on the screen is doing a job',
  'Nothing important is cut off at the edge',
  'Text is readable against what is behind it',
];
const pass = (line) => ({ line, verdict: 'pass', why: 'looks fine' });
const REPLIES = {
  clean: { findings: LINES.map(pass) },
  fail: {
    findings: [
      pass(LINES[0]),
      { line: LINES[1], verdict: 'fail', why: 'the right edge clips the last card' },
      { line: LINES[2], verdict: 'unsure', why: 'cannot tell at this size' },
    ],
  },
  // Skips the last line, which is the failure mode worth guarding: every
  // answer returned says pass, and the unanswered one is the one that mattered.
  skipped: { findings: [pass(LINES[0]), pass(LINES[1])] },
  invented: { findings: [...LINES.map(pass), pass('A line nobody wrote')] },
  garbage: null,
};
if (mode === 'garbage') {
  process.stdout.write('I had a look and everything seems good to me.\n');
} else if (mode === 'crash') {
  process.stderr.write('the model provider is unreachable\n');
  process.exit(2);
} else {
  // Fenced, because real CLIs wrap JSON in markdown constantly.
  process.stdout.write('```json\n' + JSON.stringify(REPLIES[mode]) + '\n```\n');
}
