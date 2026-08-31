/**
 * Reporting.
 *
 * Passing samples are printed too, with their ratios. Knowing a pair cleared
 * 4.52 against a floor of 4.5 is worth more than knowing it cleared, because
 * the next change to the background takes it under.
 */

const pad = (text, width) => String(text).padStart(width);

// Always show a decimal, so a floor of 3 reads as 3.0 next to a 4.5 and the
// column stays scannable. Never round: 4.55 must not print as 4.6.
const showMin = (min) => (Number.isInteger(min) ? min.toFixed(1) : String(min));

function contrastLines(result) {
  const lines = [];
  const widest = Math.max(0, ...result.samples.map((s) => s.ratio.toFixed(2).length));
  for (const s of result.samples) {
    const note = s.note ? `  ${s.note}` : '';
    lines.push({
      level: s.pass ? 'ok' : 'fail',
      text: `${pad(s.ratio.toFixed(2), widest)}:1  needs ${showMin(s.min)}  ${s.theme}  ${s.fg} on ${s.bg}${note}`,
    });
  }
  for (const p of result.problems) lines.push({ level: 'error', text: p });
  return lines;
}

function treatmentLines(result) {
  return [
    ...result.failures.map((f) => ({ level: 'fail', text: `${f.file}:${f.line} ${f.message}` })),
    ...result.problems.map((text) => ({ level: 'error', text })),
  ];
}

/**
 * The judge's verdicts are opinions, so a "fail" is a note unless the config
 * opted into blocking. Its problems are facts about whether it ran at all,
 * and those stay errors either way.
 */
function judgeLines(result) {
  const level = result.failOn === 'fail' ? 'fail' : 'note';
  return [
    ...result.findings
      .filter((f) => f.verdict !== 'pass')
      .map((f) => ({
        level: f.verdict === 'fail' ? level : 'note',
        text: `${f.verdict.padEnd(6)} ${f.line}${f.why ? `: ${f.why}` : ''}`,
      })),
    ...result.problems.map((text) => ({ level: 'error', text })),
  ];
}

export const linesFor = (result) => {
  if (result.name === 'contrast' || result.name === 'runtime') return contrastLines(result);
  if (result.name === 'judge') return judgeLines(result);
  // tokens and treatments both report {file, line, message} failures, so they
  // render the same way. Named rather than left to the fallthrough: a check
  // that renders by accident is a check that stops rendering by accident.
  if (result.name === 'tokens') return treatmentLines(result);
  return treatmentLines(result);
};

const MARK = { ok: '  ok  ', fail: 'FAIL  ', error: 'ERROR ', note: 'NOTE  ' };

export function toText(results) {
  const out = [];
  for (const result of results) {
    const lines = linesFor(result);
    const blocking = lines.filter((l) => l.level !== 'ok' && l.level !== 'note');
    const notes = lines.filter((l) => l.level === 'note');

    // Notes are worth printing and not worth failing over, so a run with only
    // notes gets its own heading. Calling it FAILED would train people to
    // ignore the word.
    if (!blocking.length && notes.length) {
      out.push(`${result.name} ok, ${result.summary}, ${notes.length} to read`);
      for (const l of notes) out.push(`  ${MARK[l.level]}${l.text}`);
      out.push('');
      continue;
    }
    if (!blocking.length) {
      out.push(`${result.name} ok, ${result.summary}`);
      // A clean contrast run still shows its margins. Nothing else in the
      // report tells you which pair is one nudge away from failing.
      if (result.name === 'contrast' || result.name === 'runtime') {
        for (const l of lines) out.push(`  ${MARK.ok}${l.text}`);
      }
      out.push('');
      continue;
    }
    out.push(`${result.name} FAILED`);
    for (const l of lines) out.push(`  ${MARK[l.level]}${l.text}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

/** A note is something to read, not something to block on. */
export const failed = (results) =>
  results.some((r) => linesFor(r).some((l) => l.level !== 'ok' && l.level !== 'note'));

export function toJson(results) {
  return JSON.stringify(
    {
      ok: !failed(results),
      checks: results.map((r) => ({
        name: r.name,
        summary: r.summary,
        ok: !linesFor(r).some((l) => l.level !== 'ok' && l.level !== 'note'),
        samples: r.samples ?? [],
        failures: r.failures ?? [],
        problems: r.problems ?? [],
      })),
    },
    null,
    2,
  );
}
