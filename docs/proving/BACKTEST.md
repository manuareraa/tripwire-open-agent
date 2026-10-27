# Proving Ground stage 4: Backtest

A time-machine test of Tripwire's tripwires on real SEC history. We go back to a past date, look only at the filings that were public then, set tripwires the way Tripwire would, then step forward through the real quarterly reports (10-Q and 10-K) and real event filings (8-K). We ask two questions: did a tripwire fire before real trouble, and how often did it fire for nothing?

Measured numbers live in [`eval/BACKTEST.md`](../../eval/BACKTEST.md) and `eval/backtest_results.json`. Both are written only by `scripts/backtest.ts`. Nothing in them is typed by hand or estimated.

**Rule arm, measured (data fetched 2026-10-27, window 2021Q2–2026Q1, 200 decisions):** 67 trouble events scored (52 from 8-Ks, 15 covenant-level breaks). 7 were caught early (the tripwire fired strictly before the filing date), and 3 of those a quarter or more early. Median warning: 0 quarters. 49 firings, of which 14 were false alarms. 23 more trouble events fell outside every watch window and are not scored. The model arms are **not run yet**.

`eval/backtest_timeline.json` is the time-lapse view: one strip per supplier, keyed by `subject_id`, in the `BacktestTimeline` shape (arm `"rules"`). Each strip covers 5 quarters from one as-of date. It holds the figures actually filed in each quarter, with `null` where none were filed, plus the quarter each tripwire fired and the trouble in plain words. Per supplier the script picks the as-of with the longest-warning catch, or else the first firing, or else the latest date. It is written from the measured rule run only. pg-integrate serves it at `GET /proving/timeline/:subject_id`.

## Integration requests (for the coordinator)

1. **Server route (optional).** `server.ts` gets a read-only route for the whole results file, so the console can show the overall score as well as each supplier's row:
   ```ts
   import { readFileSync } from "node:fs";
   app.get("/proving/backtest", (c) => {
     try { return c.json(JSON.parse(readFileSync("eval/backtest_results.json", "utf8"))); }
     catch { return c.json({ error: "no backtest results" }, 404); }
   });
   ```
   Nothing depends on it today. Each decision already carries its supplier's record in `proving.track_record` (graph.ts line 101 calls `trackRecord(subject_id)`).
2. **No type changes needed.** `TrackRecord` in `app/types.ts` and `console/src/types.ts` already fits.
3. **Model arms after Imagine and Crash-test land.** The model arms read `decision.tripwires[].origin` (`"decider"`, or `"premortem"` with `crash_test.verdict === "verified"`). Run `--record` only after those stages are merged, or the pre-mortem arm will have no tripwires to score.
4. **CSS.** One `.pg-backtest` block is appended at the end of `console/src/console.css`.

## Pre-registered rules

These were written in code (`app/proving/backtest.ts`, committed as `fbc9fdc` before any result was computed) and here, before looking at any result. They are not tuned afterwards.

**Real trouble** is any one of these, dated by the day it became public:
- An 8-K with item **1.03** (bankruptcy), **2.04** (debt acceleration: lenders can call the loan early), **2.06** (material impairment: a big write-down of assets), **4.01** (auditor change) or **4.02** (past financial statements can no longer be relied on).
- An 8-K with item **5.02** (officer change) whose Item 5.02 text has, in one sentence, a CEO/CFO role word and a leaving word (resign, retire, step down, depart, terminate, separate, will not continue). This is a plain text match, not a model.
- A **covenant-level break** in a later quarter: current ratio (current assets ÷ current liabilities) under 1.0, or liabilities over 3× equity, or equity at or below zero. It counts in the quarter the break **starts** (the previous quarter was not in break). It is dated by the filing date of the quarterly report. Loan agreements often carry limits like these ("covenants"), which is where the name comes from.

One 8-K is one event, however many trouble items it lists.

**The time machine:**
- As-of dates: 2021-03-31, then every 2 quarters. We keep only dates whose 2-quarter watch window *and* 2-quarter follow-up have fully passed by the fetch date. With data fetched on 2026-10-27 that gives 10 dates (2021-03-31 … 2025-09-30), so 20 suppliers × 10 = 200 decisions.
- On each as-of date, a metric uses only figures whose original filing was filed by that date. A quarter's numbers become known on the day its 10-Q/10-K was filed, not on the quarter end. The value used is the original filing's, not a later restatement.
- Each set of tripwires is watched for 2 quarters, until the next as-of date sets a new one. It is checked on every filing date in that window.
- **Firing.** The first tripwire to cross its line reopens the decision. A set fires at most once.

**Scoring:**
- **Caught early:** the trouble event is judged by the tripwire set in force when it became public. It counts as caught only if that set fired strictly before the event's filing date. We also report "a quarter or more early" on its own.
- **Quarters of warning:** the event's quarter minus the firing's quarter (0 = same quarter).
- **False alarm:** a firing with no trouble event for that supplier in the firing's quarter or the next 2 quarters.
- Trouble events outside every watch window are not scored. The script prints how many there are.

**Held at today's sample values.** We have no past record of these, so they stay at today's values: spend share, lead time, number of alternative suppliers, and sanctions matches. Tripwires on them can never fire in the backtest.

## Arms

| Arm | What sets the tripwires | Status |
|---|---|---|
| Rule-based | `defaultTripwires()` from `app/tripwires.ts`, the code fallback, run on the as-of metrics | measured (see `eval/BACKTEST.md`) |
| Ultra decider | the Decider's own tripwires (`origin: "decider"`) from `runDecide` on an as-of copy of the sample data | **not run yet** |
| Pre-mortem + crash-tested | pre-mortem tripwires that passed the crash test (`origin: "premortem"`, `verdict: "verified"`) | **not run yet** |

The model arms are never estimated. Until a live recording exists they show "not run yet" in the results file and in the UI. The UI shows the best *measured* arm and names it.

## How to run

```bash
npx tsx scripts/backtest.ts             # rule arm; uses data/backtest/history.json if present
npx tsx scripts/backtest.ts --rebuild   # rebuild history.json from cached raw downloads (data/backtest/raw/, gitignored)
npx tsx scripts/backtest.ts --refresh   # re-download from SEC EDGAR (SEC_USER_AGENT; at most 5 requests a second)
npx tsx scripts/backtest.ts --budget    # model arms' call budget and minutes estimate; runs nothing
```

`data/backtest/history.json` is committed. It holds the derived quarterly ratios and the 8-K list with filing URLs, so a fresh clone runs the rule arm with no network and no keys.

### Live-recording budget (model arms, Windows PC with Nightshift only)

- **Per decision:** about 20 model calls: about 5 from the current pipeline, 1 Ultra pre-mortem and about 14 Lightning crash tests.
- **All 200 decisions:** about 4,000 calls, roughly 200 minutes at 3 s a call. Ultra calls run longer, so treat that as a floor.
- **Suggested run:** `npx tsx scripts/backtest.ts --record --max-cases 40`, an even spread of 40 decisions across suppliers and years. That is about 800 calls and about 40 minutes (`--budget` prints the current estimate). A decision is scored in a model arm only if that arm's model call was answered. The rule arm is also scored on the same 40 decisions, so the comparison is fair.
- **If it stops part-way:** `npx tsx scripts/backtest.ts --record --resume --max-cases 40` continues the same numbered run, reusing every answer it already got. Each run's log is in `logs/runs/`.
- **Afterwards:** commit `data/backtest/recordings.jsonl`. Anyone can then run `--replay --max-cases 40` with no keys.

These are cost estimates, not results.

How the model run stays honest:
- Each decision gets its own throwaway data folder (only filings public on the as-of date), its own clock (`SAMPLE_CLOCK` = as-of date) and fresh memory. Nothing from a later quarter leaks in.
- Prompts are built from the as-of data, so they are deterministic and replay by hash.
- Recordings go to `data/backtest/recordings.jsonl`, apart from the demo's `data/recordings/nightshift.jsonl`, so the demo's 107 replays are untouched.

## Limits (read before quoting a number)

- **One 8-K, one event.** A company can file two 8-Ks on the same day (IP filed two with item 2.06 on 2025-08-21), and that counts as two events.
- **Few trouble events.** These are 20 large, mostly healthy public companies over about 5 years, so real trouble is rare and the counts are small. One event more or less moves the rate a lot. Treat the counts as the result, not the percentages.
- **Partly circular by design.** The rule arm's current-ratio line is often exactly 1.0, the same line as the covenant-break definition. Its "8-K risk count" tripwire counts most of the same 8-K items that define trouble. So many rule-arm firings land on the same filing that defines the trouble: the tripwire reopens the decision the day the trouble becomes public. That is useful (the decision does not sit stale), but it is not foresight, so those do **not** count as caught. The "a quarter or more early" column is the strongest early-warning number.
- **Large companies with high leverage.** Some suppliers carry liabilities above 3× equity for the whole period. A break that starts before 2020 is never an event here. A company that hovers around the line can start a new break several times.
- **The CEO/CFO text match can miss successions** worded without a leaving word (for example "will succeed"). It can also count a sentence that mentions a CEO near a leaving word for someone else. The 5.02 filings it flagged are listed with their URLs in `data/backtest/history.json` (`ceo_cfo_departure: true`).
- **Missing data.** Gross margin is not reported for the logistics companies and BALL, so those metrics are absent there. That does not affect the rule arm, which always picks the current ratio as its one financial line.
- **Held values** (spend share, lead time, alternatives, sanctions) never move, so those tripwires never fire. In real use they could, and they could add both catches and false alarms.
- **Rule changed after the first run (stated openly).** The first draft counted a firing in the same calendar quarter as caught, even on or after the filing date. An adversarial review found that let a tripwire "catch" the very filing that defined the trouble (31 of 67). The rule is now strictly before the filing date (7 of 67). Each event's exact firing date is in the results file.
