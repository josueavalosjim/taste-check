---
name: taste-check-judge
description: Run the taste-check fresh-eyes judge on a design, using a fresh subagent as the judge rather than a shell command. Use after building or changing a screen, when asked to review or critique a design, or on any request to run the taste gate. Requires a tastecheck.config.json with a judge block.
---

# taste-check judge

You are the transport, not the judge.

`taste-check` builds the prompt and checks the answer. You carry the prompt to a
model and carry the reply back. The model you carry it to must not be you.

## Why not you

You are reading this inside a session that has context: what was built, what it
was for, which tradeoffs were made and why. That context is exactly what
disqualifies you from judging the result. The reasoning that justified each
choice is still sitting here ready to justify it again, and a review that
reaches for it is not a review.

So the judge is a separate agent with none of it. That is the whole mechanism,
and skipping it turns this into self-assessment with extra steps.

## Steps

**1. Produce the screenshots.** However this project does it. If the config has
a `shotCommand`, the next step runs it for you.

**2. Get the prompt.**

```
npx taste-check judge --emit
```

It prints the prompt, which already contains the framing and the user's
checklist. It exits 1 and prints nothing usable if there are no screenshots or
no checklist, which is deliberate: a judge with nothing to look at must not
produce a verdict.

**3. Ask a fresh agent.** Spawn a new general-purpose agent on the strongest
reasoning tier available. Give it:

- the prompt from step 2, verbatim
- the screenshot files it names

Give it nothing else. No summary of what changed. No statement of intent. No
prior conversation. Do not mention which lines you expect to fail, do not say
what you already fixed, and do not add a checklist item of your own. Every one
of those turns the verdict into your opinion with a second signature on it.

Ask it to reply with the JSON the prompt specifies and nothing else.

**4. Grade the reply.**

```
npx taste-check judge --verdict reply.json
```

or pipe it on stdin with `-`. This checks the reply against the checklist:
every line answered exactly once, no invented lines, valid verdicts. A judge
that quietly drops the hardest line is the failure this catches.

Exit code 1 means the judge could not run, or a verdict blocked under
`failOn: "fail"`. Verdicts are otherwise advisory and print as notes.

## Reporting back

Report what the judge said, including the passes. Do not soften a `fail` and do
not quietly drop an `unsure`.

If you disagree with a verdict, say so as a disagreement and leave the verdict
standing. "The judge flagged X, I think it is wrong because Y" is useful. Not
mentioning X is not.

Fix what you can, then run the whole thing again from step 1. A verdict on the
old screenshots is not a verdict on the new ones.

## What this skill does not contain

Any design rules. The checklist is the user's file, named in their config, and
if it is empty then this reports nothing and that is correct. A checklist that
arrived with a tool is somebody else's taste wearing the tool's authority.
