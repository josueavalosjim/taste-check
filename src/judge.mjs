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
const FRAMING_HEAD = `You are looking at these images for the first time.

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

`;

const FRAMING_TAIL = `Reply with JSON and nothing else, in this shape:

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
  return checklistEntries(text).map((e) => e.text);
}

/** The same, keeping the line each one was written on so a finding can point at it. */
export function checklistEntries(text) {
  const entries = [];
  text.split('\n').forEach((raw, i) => {
    if (!/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(raw)) return;
    entries.push({ text: raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim(), line: i + 1 });
  });
  return entries;
}

/**
 * The prompt handed to the judge: framing, the images, then the checklist.
 *
 * The image paths go in the prompt as well as on the command line, because
 * the two families of tool want them in different places. Some accept image
 * files as arguments; others read the prompt and open what it names. Naming
 * them both ways costs a line and means the contract does not quietly exclude
 * half the tools someone might reach for.
 */
export function buildPrompt(checklist, images = []) {
  const shots = images.length
    ? `IMAGES (open each one before answering):\n${images.map((i) => `- ${i}`).join('\n')}\n\n`
    : '';
  return `${FRAMING_HEAD}${shots}${FRAMING_TAIL}${checklist.map((l) => `- ${l}`).join('\n')}\n`;
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

const empty = (problems, failOn) => ({ name: 'judge', findings: [], problems, failOn, summary: '' });

/**
 * Everything the judge needs before a model is involved: the screenshots, the
 * checklist, and the prompt built from them.
 *
 * Split out so the model call does not have to be a subprocess. A shell
 * command is one way to reach a model and a poor one for an agent, which is
 * already a model and can spawn a genuinely fresh context of its own rather
 * than shelling out to a second copy of itself. This half prepares the call,
 * `gradeVerdict` below checks the answer, and in between the transport is
 * somebody else's problem.
 *
 * The preconditions are enforced here rather than at grading time. Handing
 * back a prompt for zero screenshots would produce a confident verdict about
 * nothing.
 */
export function prepareJudge(config, cwd) {
  const { checklist: checklistPath, shots = [], shotCommand, failOn = 'never' } = config;

  if (shotCommand) {
    const made = runCommand(shotCommand, [], '', cwd);
    if (!made.ok) return { ok: false, result: empty([made.reason], failOn) };
  }

  const images = expand(shots, cwd);
  if (!images.length) {
    return {
      ok: false,
      result: empty(
        [
          `no screenshots matched ${shots.map((s) => `"${s}"`).join(', ')}. ` +
            `A judge with nothing to look at cannot fail, so it does not get to pass either.`,
        ],
        failOn,
      ),
    };
  }

  let entries;
  try {
    entries = checklistEntries(readFileSync(resolve(cwd, checklistPath), 'utf8'));
  } catch {
    return { ok: false, result: empty([`cannot read the checklist at ${checklistPath}`], failOn) };
  }
  if (!entries.length) {
    return {
      ok: false,
      result: empty(
        [
          `${checklistPath} has no checklist lines in it. Lines to judge are list ` +
            `items ("- ..." or "1. ..."); everything else is treated as prose.`,
        ],
        failOn,
      ),
    };
  }

  const relative = images.map((i) => label(i, cwd));
  return {
    ok: true,
    entries,
    images,
    relativeImages: relative,
    prompt: buildPrompt(entries.map((e) => e.text), relative),
  };
}

/**
 * Check a reply against the checklist it was supposed to answer.
 *
 * This is the half that makes the whole thing trustworthy, and it does not
 * care where the reply came from. A judge that quietly drops the hardest line
 * is the failure mode to guard: every remaining verdict says pass, and the one
 * nobody answered is the one that mattered.
 */
export function gradeVerdict(reply, prepared, config) {
  const { checklist: checklistPath, failOn = 'never' } = config;
  const findings = [];
  const problems = [];
  const { entries, images } = prepared;
  const lines = entries.map((e) => e.text);
  const lineNumbers = new Map(entries.map((e) => [e.text, e.line]));

  const parsed = extractJson(reply);
  if (!parsed.ok) {
    return empty([`${parsed.reason}. The judge must reply with the documented JSON shape.`], failOn);
  }
  if (!Array.isArray(parsed.value.findings)) {
    return empty(['the reply has no "findings" array'], failOn);
  }

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
    findings.push({
      line: f.line,
      verdict: f.verdict,
      why: (f.why ?? '').trim(),
      at: { file: checklistPath, line: lineNumbers.get(f.line) },
    });
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
    } (${prepared.relativeImages.join(', ')})`,
  };
}

/** The whole thing, with a configured command as the transport. */
export function runJudge(config, cwd) {
  const { command, failOn = 'never' } = config;
  const prepared = prepareJudge(config, cwd);
  if (!prepared.ok) return prepared.result;

  if (!command) {
    return empty(
      [
        'judge.command is not set, so there is nothing to ask. Set it, or use ' +
          '`taste-check judge --emit` and `--verdict` to let an agent carry the call.',
      ],
      failOn,
    );
  }

  const reply = runCommand(command, prepared.images, prepared.prompt, cwd);
  if (!reply.ok) return empty([reply.reason], failOn);
  return gradeVerdict(reply.stdout, prepared, config);
}
