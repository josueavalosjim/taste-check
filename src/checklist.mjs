/**
 * Starting a checklist, and checking that the lines in one can be answered.
 *
 * Neither of these says what to value. The starter contains only lines about
 * whether a screen is broken, which is not taste, and the linter is about the
 * form of a line rather than its content.
 *
 * ── Why a starter at all, given this ships no design rules ──────────────
 *
 * There is a real difference between a tool that defaults to a checklist and a
 * tool that writes one into your repo once. A default arrives with the tool's
 * authority at the moment of judgment: every user who never opened the file is
 * being judged against opinions they did not choose. A scaffold is a file you
 * own, edited and committed by you, and what runs is yours. The tool never
 * reads its own copy.
 *
 * eslint is the precedent. It ships rules and no default configuration, and
 * `--init` writes you one. Nobody thinks eslint has opinions about their code
 * until they enable some.
 */

/**
 * The starter.
 *
 * Six lines, and every one of them is about whether the screen is broken
 * rather than whether it is good. That is deliberate and the header says so:
 * these are the ones that are not anybody's taste, which means the lines worth
 * having are the ones you add.
 */
export const STARTER = `# Design checklist

Lines here are judged one at a time against a screenshot, and each gets one
verdict: pass, fail, or unsure.

Everything below is about whether the screen is broken. None of it is taste,
which is the only reason it could ship inside a tool. The lines worth having
are the ones you add, and they should be the specific things your work gets
wrong, in your words.

Two things make a line answerable. It has to be settleable by looking, so
"nothing is cut off" works where "looks expensive" comes back unsure every
run. And it has to ask one thing, because a line joining two claims cannot be
answered by a single verdict.

Anything you can measure belongs in a contrast pair or a runtime target
instead, where the answer is a number rather than an opinion.

Note that only list items are judged. Everything above this is prose and is
ignored, so there is room here to write down why these lines and not others.

Run \`taste-check checklist --lint\` after editing.

- Nothing important is cut off at an edge of the frame
- Every piece of text is legible against what is directly behind it
- Nothing overlaps something it was not meant to overlap
- Nothing is obviously misaligned with the things beside it
- Nothing is still showing a loading, empty, or placeholder state
- Nothing appears twice that was meant to appear once
`;

/** Words that describe a feeling rather than something visible in an image. */
const UNFALSIFIABLE = [
  'premium', 'modern', 'clean', 'professional', 'polished', 'elegant',
  'beautiful', 'delightful', 'intuitive', 'slick', 'crisp', 'tasteful',
  'cohesive', 'harmonious', 'balanced', 'pleasing', 'appealing', 'nice',
  'good', 'bad', 'ugly', 'feel', 'feels', 'vibe', 'aesthetic',
];

/** Things a still image cannot show. */
const NOT_IN_A_STILL = [
  'animation', 'animate', 'transition', 'hover', 'scroll', 'scrolling',
  'load time', 'performance', 'sound', 'audio', 'click', 'tap', 'drag',
  'keyboard', 'focus ring', 'video plays',
];

const MEASURABLE = /\b\d+(\.\d+)?\s*(:\s*1|px|rem|em|%|pt)\b|\bcontrast ratio\b|\b\d+:\d+\b/i;
const COMPOUND = /\b(and|or)\b/i;

/**
 * Check a single line for whether a judge could answer it.
 *
 * Never about content. A line can ask for anything at all; these findings are
 * about whether asking it produces a verdict or a shrug.
 */
export function lintLine(text) {
  const findings = [];
  const lower = text.toLowerCase();
  const words = text.trim().split(/\s+/);

  const vague = UNFALSIFIABLE.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(lower));
  if (vague.length) {
    findings.push({
      kind: 'unfalsifiable',
      detail:
        `"${vague.join('", "')}" describes a feeling rather than something visible. ` +
        `A judge answers unsure, every run.`,
    });
  }

  const unseen = NOT_IN_A_STILL.filter((w) => lower.includes(w));
  if (unseen.length) {
    findings.push({
      kind: 'not-in-a-still',
      detail: `"${unseen.join('", "')}" cannot be seen in a screenshot. The judge only gets images.`,
    });
  }

  if (MEASURABLE.test(text)) {
    findings.push({
      kind: 'measurable',
      detail:
        'this asks for a number. Put it in a contrast pair or a runtime target, ' +
        'where the answer is measured rather than judged.',
    });
  }

  // Only compound when both halves look like claims, so "black and white" or
  // "cut off at the top or bottom" are left alone.
  if (COMPOUND.test(text)) {
    // Three words a side, so "black and white" and "the top or bottom" are
    // left alone while two real claims are caught.
    const halves = text.split(/\b(?:and|or)\b/i).map((h) => h.trim().split(/\s+/).filter(Boolean).length);
    if (halves.length > 1 && halves.every((n) => n >= 3)) {
      findings.push({
        kind: 'compound',
        detail: 'two claims in one line. One verdict cannot answer both, so split it.',
      });
    }
  }

  if (words.length < 4) {
    findings.push({ kind: 'too-short', detail: 'too short to say what is being asked.' });
  }

  return findings;
}

/** Lint every line of a checklist, keeping the line numbers. */
export function lintChecklist(entries) {
  const findings = [];
  for (const entry of entries) {
    for (const finding of lintLine(entry.text)) {
      findings.push({ ...finding, line: entry.line, text: entry.text });
    }
  }
  return findings;
}
