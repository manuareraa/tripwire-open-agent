# Proving Ground, stage 2: Imagine

## Integration requests

1. **Pass the backup's metrics to the pre-mortem.** `premortem()` now takes an optional 4th argument, `backupMetrics`. In `app/orchestration/graph.ts`, change the call to `premortem(deps, s, draft, backup?.metrics)`. Until then, Ultra never sees `backup_*` numbers, so it cannot write a story about the backup supplier failing. The current 3-argument call still compiles and works.
2. **One line changed outside this stream's files:** `test/recording.test.ts` line 75 lists every agent that makes a model call. I added `"PreMortem"` to that list, because the pre-mortem is a new model call. Nothing else in that test changed.
3. **Before the live recording:** the 81 recorded answers in `data/recordings/nightshift.jsonl` contain no PreMortem answers. Replay therefore skips Imagine with "imagine: no model answered (replay: no recorded live answer for this prompt)". To show stories in a keyless replay, record once more with a live model (budget below).

## What it does

When the Decider has drafted a decision, Nemotron Ultra is asked one question. The prompt:

> It is six months from now. We made this decision (dual-source for SUP-02) and it went badly. Write the 2-4 most likely failure stories. For each, name the earliest number from this list that would move first, the direction, and the line.

Ultra also gets:
- every metric with today's value and its meaning (`backup_*` too, once request 1 is wired);
- the Decider's reason;
- the Analyst's findings;
- the 8-K filings from stage 1, by id.

The prompt contains no decision ids, run ids or timestamps, so a recorded answer replays by prompt hash. A test checks this.

Each story becomes a candidate tripwire with `origin: "premortem"` and a `story_id`, and goes on to the crash test.

## Checks in code (the model proposes, code decides)

A story is dropped, and the reason written to the decision's limitations, when any of these holds:

| Check | Example reason |
|---|---|
| The metric is unknown | `unknown metric "cash_burn"` |
| There is no number for it today | `no data for metric "gross_margin"` |
| The direction is not `<` or `>` | `direction "rises" is not "<" or ">"` |
| The line is not a number | `spend_share: no numeric line` |
| The line is already crossed today (reuses `reviewTripwires`; `backup_*` lines are checked the same way against the backup's values) | `current_ratio < 1 is already true today (value 0.85)` |
| `grounded_in` cites something that is not a real filing id or metric | `cites "fil-99", which is not a filing or metric we have` |
| The same line is already a Decider tripwire or an earlier story | `same line as a tripwire already set` |
| More than 4 stories | `more than 4 stories` |

If no model answers, or the answer is not JSON, Imagine adds one line to `proving.skipped` (for example "imagine: no model answered (…)") and returns nothing. Code never writes a story itself.

The trace gets one `PreMortem / failure_story` event per story. A kept story's summary is the story itself plus "Watch: <metric> <op> <line>"; a dropped story's summary is "Dropped story … : <reason>".

## Console

`console/src/proving/ImagineStage.tsx` shows one short card per kept story. Each card shows:
- the story;
- the tripwire it became, in plain words (for example "watch: current ratio falls below 0.7");
- the crash-test verdict when one exists;
- what the story was based on.

Once the crash test has run, a story with no matching tripwire is marked "✕ dropped by the crash test" and its line is struck through. CSS: one `.pg-imagine-*` block at the end of `console/src/console.css`.

## Model-call budget for the live recording

- **1 Ultra call per decision**: reasoning tier, thinking on, `max_tokens` 6000. That is 20 calls for the 20-supplier portfolio, plus 1 for each reopened decision.
- **Time estimate, not measured:** the pre-mortem has not been called live yet. The closest recorded calls are the Decider's Ultra calls with thinking on (`nvidia/nemotron-3-ultra-550b-a55b`). The 16 recorded ones took 2.4 to 9.0 s, median about 6 s. A pre-mortem writes more text than a decision, so I assume 5 to 15 s per call. That adds **about 2 to 5 minutes** to a sequential 20-decision live run.

## Measured results (2026-10-27, keyless)

- Tests: `test/proving_imagine.test.ts`, 8 tests, all pass. They use the scripted fake model and cover:
  - valid stories;
  - each drop reason;
  - the 4-story cap and duplicates;
  - backup metrics;
  - no answer;
  - a non-JSON answer;
  - a deterministic prompt;
  - one full `runDecide` run where a story reaches the compiled tripwires with `origin`, `story_id` and row dependencies.
- Full suite: 18 files, 138 passed, 1 skipped. Typecheck is clean for the server and the console.
- **Replay unchanged:** I ran the 20 sample suppliers against the recorded answers, on `proving-base` and on this branch, using the recorded question "Keep, dual-source or exit this supplier?".
  - Both runs replayed 71 calls.
  - Both gave the same decision, confidence and tripwire count for all 20 suppliers.
  - On this branch, each supplier made 1 PreMortem call that found no recording, so Imagine was skipped honestly.
  - No existing agent prompt was changed.
- Not measured: live story quality and live latency, because there was no live call (no keys, and live recording was out of scope).
