# Proving Ground

**One sentence:** before a human approves a supplier decision, Nemotron attacks its own call: it reads the real filings, imagines how the call fails, crash-tests every tripwire, and shows how tripwires like these did on real history.

Other entries use Nemotron to make a decision. Tripwire uses Nemotron to prove the decision's safety net works. A tripwire ("reopen if spend share goes above 45%") is only worth keeping if crossing it would really change the call. Nobody checks that today. Proving Ground does, with a number.

## The four stages (one strip in the console, one block on the decision)

| # | Stage | Borrowed from | Nemotron model | What it adds to `Decision.proving` |
|---|---|---|---|---|
| 1 | **Read** | Insurance claim intake: read the source document, not a summary | Nemotron Parse (build.nvidia.com) | `filings`: material events read from the supplier's real 8-K documents |
| 2 | **Imagine** | The pre-mortem used by surgeons and project teams | Nemotron 3 Ultra, thinking on | `stories`: "six months on, this went badly: what happened?", each turned into a candidate tripwire |
| 3 | **Crash-test** | Car crash tests; bank stress tests | Nemotron 3.5 Lightning | `crash`: each candidate pushed just past its line and just short of it, then re-decided. verified / decorative / mis-set |
| 4 | **Backtest** | Backtesting a trading rule; scoring a weather forecast against what happened | Lightning + Ultra, replayed | `track_record`: on real SEC history, did the tripwires fire before real trouble, and how often for nothing? |

Big model designs, small model tests: Ultra writes the failure stories (hard reasoning, done once), Lightning runs the many cheap crash tests. That split is the point and should be said plainly in the README and video.

**The headline the four stages build together** (filled in only with measured numbers, never guessed):

> Of N tripwires Nemotron proposed, X% survived the crash test. On real SEC history 20XX–2025, crash-tested pre-mortem tripwires caught A of B real trouble events a quarter or more early, with C false alarms, against A′ and C′ for rule-based tripwires.

## How a decision flows

```
gather → [1 Read: filings] → evidence check → … → Decider (unchanged) → Backup Picker
       → [2 Imagine: pre-mortem stories → candidate tripwires]
       → [3 Crash-test: decider + pre-mortem candidates → only verified ones kept]
       → [4 Backtest: attach this supplier's track record from eval/backtest_results.json]
       → final check → record
```

Wiring lives in `app/orchestration/graph.ts` (already in place on `proving-base`). Each stage is a stub until its owner replaces it.

## Ownership: one stream per stage, separate files

| Stream | Owns (only edit these) |
|---|---|
| read | `app/proving/filings.ts`, `scripts/parse_filings.ts`, `data/cache/filings/**`, `console/src/proving/ReadStage.tsx`, `test/proving_read.test.ts`, `docs/proving/READ.md` |
| imagine | `app/proving/premortem.ts`, `console/src/proving/ImagineStage.tsx`, `test/proving_imagine.test.ts`, `docs/proving/IMAGINE.md` |
| crash-test | `app/proving/crashtest.ts`, `console/src/proving/CrashStage.tsx`, `test/proving_crash.test.ts`, `eval/CRASH.md`, `eval/crash_results.json`, `scripts/eval_crash.ts`, `docs/proving/CRASH.md` |
| backtest | `app/proving/backtest.ts`, `scripts/backtest.ts`, `eval/BACKTEST.md`, `eval/backtest_results.json`, `data/backtest/**`, `console/src/proving/BacktestStage.tsx`, `test/proving_backtest.test.ts`, `docs/proving/BACKTEST.md` |
| integration (coordinator) | `app/types.ts`, `app/orchestration/*`, `app/tripwires.ts`, `console/src/types.ts`, `console/src/proving/ProvingGround.tsx`, `console/src/DecisionView.tsx`, `README.md`, `output_examples/**`, `scripts/record_live.ts` |

Need a change in an integration file (a new field, a hook)? Do not edit it. Write the exact change you need at the top of your `docs/proving/<STAGE>.md` under "Integration requests"; the coordinator applies it. CSS: append your rules at the end of `console/src/console.css`, prefixed `.pg-<stage>`, in one block with a comment line naming your stage (the coordinator resolves the merge).

## Rules every stream follows

- **Work in your own worktree**, branched from `proving-base`: `git -C <repo> worktree add ../repo-worktrees/pg-<stage> -b pg-<stage> proving-base`. Symlink `node_modules` to `../judge-fixes/node_modules`. Commit often on your branch. Do not merge to `main`, do not push `main`. Push your branch only if asked.
- **All model calls go through `callModel(deps, s, req)`** (`app/orchestration/state.ts`), so they land in `model_calls`, the trace, and the Nightshift recording. Nemotron Parse is the exception (it is called directly on build.nvidia.com by an offline script; cache its output under `data/cache/filings/`).
- **Prompts must be deterministic**: no decision ids, run ids, timestamps or random values in prompt text. Replay looks answers up by a hash of the prompt.
- **Do not change the prompts of existing agents** (Planner, Analyst, Critic, Decider, Risk Officer). The 107 recorded live answers in `data/recordings/nightshift.jsonl` must keep replaying.
- **Every stage degrades honestly**: with no model and no recording, the stage records itself in `proving.skipped` (or sets `verdict: "untested"` with a reason) and the decision still completes. Never fake a model answer, never label rule output as a model's.
- **Offline judges must see it work**: `SAMPLE_MODE=true` with replay must run end to end. After the live recording on the Windows PC, new answers replay too.
- **No invented numbers.** Results files hold only what a script measured. Stub or rule-only results are labelled as such and never presented as model results.
- **Never commit or print keys** (nvapi-, Meterless/Nightshift tokens, Zetaris). Credentials only from env vars. Never touch shared Zetaris data.
- **Memory is tight** (the app has crashed from OOM): run tests with `scripts/memguard.sh --max 1500M -- npx vitest run --pool=forks --poolOptions.forks.singleFork`, stop any server you start, no parallel agent swarms.
- **Plain English** in UI text and docs; explain jargon the first time.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Live recording (one session on the Windows PC, at the end)

Nightshift only runs on the user's Windows PC. Stages 2 and 3 run inside the decision graph, so `scripts/record_live.ts` records their calls with no extra work. The backtest's model arms run from `scripts/backtest.ts --record`, which writes to the same recordings file. Each stream states its model-call budget (calls and rough minutes) in its doc, so the coordinator can give the user one command and one time estimate.

### The one command (Windows PC, PowerShell, Nightshift running)

Set `METERLESS_BASE_URL` and `METERLESS_RUNTIME_TOKEN` first, as in [docs/NIGHTSHIFT.md](NIGHTSHIFT.md). Then, in the repo on the `pg-integrate` branch:

```powershell
npx tsx scripts/record_live.ts; if ($?) { npx tsx scripts/backtest.ts --record --max-cases 40 }
```

- **Part 1, `record_live.ts`** (about 15–25 min): the demo story live, now with the pre-mortem (about 20 Ultra calls, 5–15 s each) and the crash tests (about 250–300 Lightning calls, about 1.8 s each), on top of the existing pipeline calls. Appends to `data/recordings/nightshift.jsonl`. Replay uses the newest record for each prompt, failures included: if a call failed this time, replay shows it as failed rather than reusing an older answer. Busy or rate-limited replies (429, 502, 503, 504) are retried up to twice before counting as failed.
- **Part 2, `backtest.ts --record --max-cases 40`** (about 40 min at 3 s a call, longer if Ultra is slow; plan for 35–50): the model arms on 40 past decisions, about 800 calls (`--budget` prints this). A decision joins a model arm only if that arm's model call was answered; the script prints how many were left out. Writes `data/backtest/recordings.jsonl`.
- **Total: about 1 to 1.5 hours.**
- **Every run is numbered and logged.** Each run prints `run N: full log in logs/runs/run-000N-….log`. The log has everything the script printed with times, one line per model call (agent, model, time, ok or the error), any crash with its stack, and the exit code. Keys and tokens are blanked out. Send that file if something goes wrong.
- **If it stops part-way, resume instead of starting over.** Add `--resume` to the part that stopped: `npx tsx scripts/record_live.ts --resume`, or `npx tsx scripts/backtest.ts --record --resume --max-cases 40`. It continues the newest numbered run (or `--resume N` for run N) in the same log file. Answers that run already got are reused, so only the missing or failed calls go to Nightshift again. Read (stage 1) needs no calls; its Parse output is already cached.
- **Afterwards:** commit both recordings files only (never `.env`). The coordinator then replays them keyless (`scripts/eval_crash.ts`, `scripts/backtest.ts --replay --max-cases 40`) to write the measured model-arm numbers into `eval/` and the README.
