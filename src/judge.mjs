/**
 * The fresh-eyes judge.
 *
 * Everything else in this tool measures. This part asks the question a
 * measurement cannot answer: not whether the screen is correct, but whether it
 * is any good. That question cannot be put to whoever just built the thing.
 * The context that made the choices is the worst-placed context to find them
 * wanting, because the reasoning that justified each one is still sitting
 * there ready to justify it again.
 *
 * So the judge is a separate process that sees the screenshots and the
 * checklist and nothing else. No summary of what changed, no statement of
 * intent, no prior conversation. It should see what a stranger sees.
 *
 * ── What ships here and what does not ───────────────────────────────────
 *
 * This module ships the FRAMING: fresh context, do not lead the judge, answer
 * every line, prefer unsure to a guess, quote what you actually see. That part
 * is method and it is portable.
 *
 * The CHECKLIST is yours. taste-check contains no design rules and never will,
 * because a shipped checklist is just somebody else's taste wearing the
 * authority of a tool.
 *
 * ── Where the determinism line falls ────────────────────────────────────
 *
 * A model's verdict is an opinion and cannot gate a build by default, so a
 * "fail" prints as a NOTE and the command still exits 0 unless failOn says
 * otherwise.
 *
 * Whether the judge RAN is not an opinion. No screenshots, a command that
 * exited non-zero, output that was not JSON, a reply that skipped a checklist
 * line or invented one: each of those is a fact, each exits 1 regardless of
 * failOn. Without that split, "the judge did not run" and "the judge found
 * nothing" produce the same green output, which is the failure this whole
 * tool exists to prevent, one level up.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expand, label } from './files.mjs';

/**
 * The instructions wrapped around the user's checklist.
 *
 * Every line here is about how to look, never about what to value. If you find
 * yourself wanting to add a rule about spacing or colour or type, it belongs
 * in a checklist file, not in this constant.
 */
const FRAMING = `You are looking at these images for the first time.

You have not been told what changed, what it is for, or what the author was
trying to do, and none of that is coming. Judge only what is in front of you,
the way someone landing on this screen cold would see it.

Answer every line of the checklist below. For each one reply with exactly one
verdict: "pass", "fail", or "unsure".

Prefer "unsure" to a guess. An honest "I cannot tell from this image" is more
useful than a confident answer that happens to be wrong, and you are not being
asked to be agreeable. If a line does not apply to what you can see, that is
"unsure", not "pass".

For anything that is not a pass, name the specific thing you are looking at:
which element, where on the screen, and what about it. A general impression is
not enough to act on.

Reply with JSON and nothing else, in this shape:

{"findings":[{"line":"<the checklist line, copied exactly>","verdict":"pass|fail|unsure","why":"<one or two sentences>"}]}

Return exactly one finding per checklist line, with "line" copied verbatim.

CHECKLIST:
`;

/**
 * The lines a verdict is expected for: list items only.
 *
 * A checklist file is a document, not a list of strings. It will have a
 * heading, and a paragraph saying what it is for, and probably a note to
 * whoever edits it next. Treating every non-heading line as something to
 * judge turns that prose into checklist items, and the judge then dutifully
 * returns a verdict on your explanatory paragraph.
 */
export function checklistLines(text) {
  return text
    .split('\n')
    .filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l))
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim());
}

/** The prompt handed to the judge: framing, then the checklist, verbatim. */
export function buildPrompt(checklist) {
  return `${FRAMING}${checklist.map((l) => `- ${l}`).join('\n')}\n`;
}

/**
 * Run a configured command from the config file's own directory, because
 * every other path in a config resolves that way and a command that did not
 * would be a trap: `node shots.mjs` would mean something different depending
 * on where you happened to be standing.
 */
function runCommand(command, args, input, cwd) {
  const [bin, ...rest] = command.split(/\s+/).filter(Boolean);
  try {
    const stdout = execFileSync(bin, [...rest, ...args], {
      cwd,
      input,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().trim().split('\n')[0];
    return { ok: false, reason: `\`${command}\` failed: ${detail}` };
  }
}

/** Pull the JSON object out of a reply that may be fenced or padded with prose. */
export function extractJson(stdout) {
  const fenced = stdout.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : stdout;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, reason: 'no JSON object in the reply' };
  try {
    return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) };
  } catch (error) {
    return { ok: false, reason: `the reply was not valid JSON: ${error.message}` };
  }
}

const VERDICTS = new Set(['pass', 'fail', 'unsure']);

export function runJudge(config, cwd) {
  const findings = [];
  const problems = [];
  const { checklist: checklistPath, shots = [], shotCommand, command, failOn = 'never' } = config;

  if (shotCommand) {
    const made = runCommand(shotCommand, [], '', cwd);
    if (!made.ok) {
      problems.push(made.reason);
      return { name: 'judge', findings, problems, failOn, summary: '' };
    }
  }

  const images = expand(shots, cwd);
  if (!images.length) {
    problems.push(
      `no screenshots matched ${shots.map((s) => `"${s}"`).join(', ')}. ` +
        `A judge with nothing to look at cannot fail, so it does not get to pass either.`,
    );
    return { name: 'judge', findings, problems, failOn, summary: '' };
  }

  let lines;
  try {
    lines = checklistLines(readFileSync(resolve(cwd, checklistPath), 'utf8'));
  } catch {
    problems.push(`cannot read the checklist at ${checklistPath}`);
    return { name: 'judge', findings, problems, failOn, summary: '' };
  }
  if (!lines.length) {
    problems.push(
      `${checklistPath} has no checklist lines in it. Lines to judge are list ` +
        `items ("- ..." or "1. ..."); everything else is treated as prose.`,
    );
    return { name: 'judge', findings, problems, failOn, summary: '' };
  }

  const reply = runCommand(command, images, buildPrompt(lines), cwd);
  if (!reply.ok) {
    problems.push(reply.reason);
    return { name: 'judge', findings, problems, failOn, summary: '' };
  }

  const parsed = extractJson(reply.stdout);
  if (!parsed.ok) {
    problems.push(`${parsed.reason}. The judge must reply with the documented JSON shape.`);
    return { name: 'judge', findings, problems, failOn, summary: '' };
  }
  if (!Array.isArray(parsed.value.findings)) {
    problems.push('the reply has no "findings" array');
    return { name: 'judge', findings, problems, failOn, summary: '' };
  }

  // Cross-check both directions. A judge that quietly drops the hardest line
  // is the failure mode to guard: the remaining verdicts all say pass, and
  // the line nobody answered is the one that mattered.
  const wanted = new Set(lines);
  const answered = new Set();
  for (const f of parsed.value.findings) {
    if (!f || typeof f.line !== 'string' || !VERDICTS.has(f.verdict)) {
      problems.push(`a finding is malformed: ${JSON.stringify(f)}`);
      continue;
    }
    if (!wanted.has(f.line)) {
      problems.push(`the judge answered a line that is not in the checklist: "${f.line}"`);
      continue;
    }
    if (answered.has(f.line)) {
      problems.push(`the judge answered "${f.line}" more than once`);
      continue;
    }
    answered.add(f.line);
    findings.push({ line: f.line, verdict: f.verdict, why: (f.why ?? '').trim() });
  }
  for (const line of lines) {
    if (!answered.has(line)) problems.push(`the judge did not answer "${line}"`);
  }

  return {
    name: 'judge',
    findings,
    problems,
    failOn,
    summary: `${lines.length} ${lines.length === 1 ? 'line' : 'lines'} against ${images.length} ${
      images.length === 1 ? 'screenshot' : 'screenshots'
    } (${images.map((i) => label(i, cwd)).join(', ')})`,
  };
}
