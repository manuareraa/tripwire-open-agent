# Tripwire

**Track 01: Fragmented Intelligence** · Open Agent Hackathon 2026 · solo entry

Tripwire is a team of agents that makes a business decision, writes down exactly which data rows the decision depends on, and sets "tripwires": the conditions under which the decision should be looked at again. When a source row changes later, Tripwire does not re-run everything. It asks memory which decisions were built on that row, checks only their tripwires, and reopens only the ones that fire.

The demo domain is supplier risk: for each of 20 suppliers, should we **keep**, **dual-source** (add a second supplier) or **exit**?

**The idea in one breath: Nemotron writes the warning signs, then Nemotron tries to break them, and only the ones that survive are kept.** Ultra imagines how each decision could go wrong and turns every story into a candidate tripwire. Lightning then crash-tests each one: it pushes the numbers just past the line and checks whether the decision really changes. In the live run, 17 of the 103 tripwires Nemotron tested survived; of the rest, 74 had the line in the wrong place and 12 would not have changed the decision, and all of them are dropped before a human sees them (10 more could not be tested). Every one of these answers was recorded live through Meterless Nightshift, with receipts, so anyone can replay them with no keys and get the same numbers ([Proving Ground](#proving-ground-nemotron-attacks-its-own-call-before-you-approve-it)).

Demo video: _link added before submission_

### Nemotron at a glance: what each model does, and what we measured

| Model (how it is reached) | Job in Tripwire | Measured against | Result | Source |
|---|---|---|---|---|
| Nemotron 3.5 Lightning 30B (Nightshift) | Plans the queries, summarises the evidence | Ultra alone, Lightning alone | Agent graph: 23/23 decisions with every number grounded vs 17/23 for one Ultra call (Nightshift run) | [eval/nightshift/RESULTS.md](eval/nightshift/RESULTS.md) |
| Nemotron 3 Ultra 550B (Nightshift) | Decides keep / dual-source / exit; thinking budget set by risk grade | Thinking always on | Thinking always on took 58% more model time (662 s vs 418 s) and scored lower on labels, 7/8 vs 8/8 (direct run) | [eval/RESULTS.md](eval/RESULTS.md) |
| Nemotron 3.5 Content Safety (build.nvidia.com; Nightshift 1.2.7 does not serve it) | Final check on the recommendation | Keyword filter | 19/22 harmful caught, 0/10 safe flagged, vs 11/22 and 1/10 | [eval/SAFETY.md](eval/SAFETY.md) |
| Nemotron 3.5 Rerank 8B (build.nvidia.com, optional) | Puts the findings that answer the question first | Keyword overlap | Right first item in 34/34 rankings vs 8/34 | [eval/RERANK.md](eval/RERANK.md) |

Clear-cut labels, the same 8 cases both times (small sample): the agent graph got 8/8 called directly on build.nvidia.com and 6/8 through Nightshift, where every model set-up scored lower and leaned towards dual-sourcing; simple rules get 8/8 on these cases by construction. We report both. A live Nightshift answer, replayed offline with its receipt ids, is in [output_examples/04_decide_replayed_nemotron.trace.jsonl](output_examples/04_decide_replayed_nemotron.trace.jsonl).

### Proving Ground: Nemotron attacks its own call before you approve it

A tripwire ("reopen if spend share goes above 45%") is only worth keeping if crossing it would really change the decision. Nobody checks that today. Before a human approves, Tripwire makes Nemotron try to break its own call, in four steps shown as one strip on every decision:

| # | Step | Borrowed from | Nemotron model | Measured so far | Source |
|---|---|---|---|---|---|
| 1 | **Read**: the supplier's real 8-K filings (the forms US companies file when something material happens) | Insurance claim intake: read the document, not a summary | Nemotron Parse, then Lightning (offline, cached) | 80 real 8-Ks for all 20 suppliers, 0 failures. Agrees with SEC EDGAR on whether a filing has a material-risk item in 80 of 80, finding all 7 such filings with no false positives; 151 of 165 listed items (92%) found | [docs/proving/READ.md](docs/proving/READ.md) |
| 2 | **Imagine**: "six months on, this decision went badly: what happened?" Each story becomes a candidate tripwire | The pre-mortem used by surgeons and project teams | Nemotron 3 Ultra, thinking on | Recorded live through Nightshift on 2026-10-27: Ultra answered all 21 pre-mortems (20 suppliers and 1 reopened decision) and proposed 37 candidate tripwires. With no keys, a fresh start replays them on each supplier's first decision; deciding the same supplier again asks a question that was never recorded, so that run shows Imagine as skipped | [docs/proving/IMAGINE.md](docs/proving/IMAGINE.md) |
| 3 | **Crash-test**: push each tripwire just past its line and just short of it, then decide again. *Verified* = the call changes only past the line; *decorative* = it never changes; *mis-set* = it already changes short of the line | Car crash tests, bank stress tests | Nemotron 3.5 Lightning | Rule-based control (no model): 47 of 80 rule tripwires survived (41 verified, 6 mis-set and moved, then verified); all 12 exit tripwires were decorative. Lightning re-deciding (recorded live, 316 answers): 14 of 75 tested Decider tripwires survived (19%) and 3 of 28 pre-mortem tripwires (11%); most of the rest were mis-set (the call already changed short of the line), and they are dropped before you see them | [eval/CRASH.md](eval/CRASH.md) |
| 4 | **Backtest**: set tripwires using only what was filed by a past date, then replay real SEC history | Backtesting a trading rule; scoring a forecast | Lightning + Ultra, replayed | Rule-based tripwires (no model), 2021Q2–2026Q1, 200 decisions: fired strictly before the filing date for 7 of 67 real trouble events, 3 of them a full quarter or more ahead; 14 of 49 firings were false alarms. Model arms (recorded live, 40 of the 200 decisions): on those 40, Ultra's tripwires and the crash-tested pre-mortem tripwires caught 0 of 9 trouble events early (1 and 4 firings, 1 and 3 false alarms); the rule tripwires caught 1 of 9 (11 firings, 4 false alarms). Too few events to rank the arms | [eval/BACKTEST.md](eval/BACKTEST.md) |

Big model designs, small model tests: Ultra writes the failure stories once; Lightning runs the many cheap crash tests.

**Nemotron disagrees with itself.** If the crash test finds that none of Nemotron's own tripwires would change the call, or that the call already flips before a line is crossed, or Ultra rates one of its own failure stories as likely and it rests on a high-severity filing, the decision goes to a senior buyer with that reason in plain words ([app/proving/challenge.ts](app/proving/challenge.ts)).

**Time machine.** In the console, a slider replays one supplier's real quarters with the tripwires set at the start: lines turn red when crossed, real SEC events appear when they happened, and the end says whether the warning came early, late or not at all.

Every number above is measured, and the model numbers come only from the live Nightshift recording of 2026-10-27 (no estimates). They are not flattering: on this small backtest the model-set tripwires warned no earlier than the rules, and most of Nemotron's own tripwires failed its crash test. That second result is the point of the Proving Ground: those lines are caught and dropped before a human approves, instead of being trusted.

---

## Why this is a fragmented-data problem

A supplier decision is built from systems that have nothing to do with each other and change at different speeds:

| Fragment | System | Changes |
|---|---|---|
| Quarterly financials | SEC EDGAR XBRL company facts (real) | once a quarter |
| Material events | SEC EDGAR 8-K filings (real) | any day |
| Sanctions screen | US Treasury OFAC SDN list (real), matched by company name | any day |
| Spend, lead time, open orders | the buyer's ERP (synthetic) | every week |

They share no key: the ERP knows a supplier id, SEC knows a CIK, OFAC knows only a name. Tripwire joins them per decision, and that is where the hard part starts. A decision made today goes stale the moment *any one* of those fragments moves, and nobody re-reads four systems for every supplier every day.

So Tripwire keeps the joins it made:

- **Per-source freshness.** Every decision records how current each fragment was, against a policy line per source (`app/freshness.ts`): 151 days for SEC financials, 30 for the ERP spend row, 7 for the 8-K feed and the OFAC screen. The Evidence Critic sends a decision back for a re-read when a source is past its line, caps the confidence if it is still out of date, and names it in the decision's limitations.
- **Cross-source lineage.** Memory stores which rows of which system each decision read.
- **Selective reopen.** When a fragment changes, memory names the decisions that read that row, code checks only their tripwires (including "reopen when this source publishes a newer as-of date"), and only those that fire are re-decided.

Measured in [eval/REOPEN.md](eval/REOPEN.md): over five source changes (a real new quarter, a real 8-K, a synthetic OFAC match and two synthetic ERP shifts) on a portfolio of 20 decisions, Tripwire re-ran **4 decisions where re-deciding everything takes 100**, and missed **none** of the decisions whose outcome actually changed when all 20 were re-decided from scratch. At the live run's measured cost per decision that is about 380 model calls and 227,000 tokens not spent.

## How the agents reason

- **Agents branch on each other's output.** The Evidence Critic can send work back to the Analyst, the Memory Keeper or the Decider (`needs_revision`), and the run takes a different path because of it. Every run is capped (3 critique rounds per decision, 2 retries per query).
- **Memory is checked, not trusted.** Claims recalled from earlier decisions carry the hash of the query result they came from. If the data has changed since, the Critic rejects the claim as evidence and the Memory Keeper withholds it. Example 3 below shows this in a real trace.
- **Lineage drives reopening.** Each decision is stored with the rows it read. A data change reopens only the decisions that depend on that row and whose tripwire actually fired. The rest count as `work_saved`.
- **A human approves.** Decisions are proposed. Risky ones are escalated and need a written reason to approve. Only approval writes to the data layer.

## Agents

| Agent | Role | Model (live mode) |
|---|---|---|
| Planner | Picks which approved SQL templates to run for the question | Nemotron 3.5 Lightning 30B (`nvidia/nemotron-3.5-lightning-30b-a3b`) |
| Analyst | Runs the queries through the data gateway, computes metrics, writes a findings summary | Nemotron 3.5 Lightning 30B |
| Evidence Critic | Checks every finding against its query hash; rejects stale memory; reviews the summary and the draft decision; sends work back | Code rules (deterministic) |
| Memory Keeper | Recalls prior claims for the supplier from H-MEM; drops stale ones; records the new decision's claims with lineage | Meterless H-MEM |
| Risk Officer | Grades risk and sets the Decider's thinking budget (code rules); applies escalation rules; runs a content-safety check on the final rationale | Nemotron 3.5 Content Safety (`nvidia/nemotron-3.5-content-safety`) |
| Decider | Chooses keep / dual_source / exit, gives a confidence and drafts 2–4 tripwires | Nemotron 3 Ultra 550B with thinking on (`nvidia/nemotron-3-ultra-550b-a55b`) |
| Watcher | On a data change: finds dependent decisions, evaluates their tripwires in code, reopens only those that fire | Code (not a model) |

Flow of one decision:

```
Planner → Analyst → Evidence Critic ─(needs_revision)→ Analyst
        → Memory Keeper (recall) → Evidence Critic ─(stale claims)→ Memory Keeper (drop)
        → Analyst summary ⇄ Critic → Risk Officer → Decider ⇄ Critic (max 3 rounds)
        → Risk Officer final check → Memory Keeper (record lineage) → proposed decision
```

Tripwires are proposed by the Decider but validated and evaluated in code (`app/tripwires.ts`), so a model never decides whether its own tripwire fired.

Every model call goes through **Meterless Nightshift**, the primary provider. If Nightshift cannot answer a call, Tripwire tries build.nvidia.com directly as a backup, and the trace says which provider and which model served each request (with Nightshift's receipt id when it sends one). With no provider at all, every model step falls back to a rule-based policy. The fallback is named in the trace (`model_unavailable`) and in the rationale ("Rule-based policy: …"). It is never presented as a model answer.

## Sponsor technology

- **Zetaris** (data layer). All source data is read with Zetaris SQL through its REST API (`app/adapters/zetaris.ts`), using a fixed set of parameterised SQL templates (`app/sql/templates.ts`). Every result is hashed, and that hash is the lineage stored with each claim. Zetaris has no row-level INSERT or UPDATE, so approved decisions are appended to a Parquet ledger through Zetaris RUN EXPORT and read back with Zetaris SQL. `scripts/zetaris_setup.ts` loads the sample tables into a local Zetaris the same way.
- **Meterless H-MEM** (memory). The Meterless H-MEM reference engine is vendored in `vendor/hmem/` (Apache-2.0) and runs in-process (`app/adapters/hmem.ts`). Each claim is an H-MEM record whose `derivedFrom` field holds the source row and result hash. H-MEM provides recall, supersession (a reopened decision supersedes the old claims) and its audit ledger (`data/ledger/memory/ledger.jsonl`). It is used in every mode, including SAMPLE_MODE.
- **Meterless Nightshift** (model runtime, `app/adapters/model.ts`): an OpenAI-compatible client that follows the Meterless Runtime contract: the URL is normalised to `<host>/v1`, the bearer token is sent with the `meterless-app` and `meterless-scope` headers, `GET /v1/models` decides whether it is online, unauthorized or offline, and the timeout is 180 s. The served model and the `meterless` receipt fields go into the trace.
- **NVIDIA Nemotron**: four models, each doing a different job and each measured against a cheaper alternative ([docs/NEMOTRON.md](docs/NEMOTRON.md)). Lightning 30B plans and summarises, Ultra 550B decides with a thinking budget set by risk, and Content Safety checks the final recommendation, each call with a timeout, retry and logged fallback. Lightning and Ultra run through Nightshift (direct `build.nvidia.com` only as a labelled backup); Content Safety runs on build.nvidia.com, because Nightshift 1.2.7 does not serve it. In a recorded live comparison over 23 cases, the agent graph as shipped was the only model set-up to pass every check on every case: one Ultra call on its own wrote an ungrounded number and an invalid tripwire, Lightning alone fell back to rules on 9 cases, and thinking always on cost 58% more model time for no gain ([eval/RESULTS.md](eval/RESULTS.md)). Repeated through Nightshift with receipts, the graph again wrote no ungrounded number where Ultra alone wrote six, though every model set-up got fewer clear-cut labels right ([eval/nightshift/RESULTS.md](eval/nightshift/RESULTS.md)). Content Safety caught 19 of 22 harmful recommendations and flagged none of 10 safe ones, against 11 and 1 for a keyword filter ([eval/SAFETY.md](eval/SAFETY.md)). Nemotron 3.5 Rerank 8B (optional, `RERANK=nvidia`, called on build.nvidia.com directly because Nightshift serves chat models only) puts the findings that answer the buyer's question first: right on the first try in 34 of 34 test rankings, against 8 of 34 for keyword overlap ([eval/RERANK.md](eval/RERANK.md)).
- **Cursor.** The project was built in Cursor. `.cursor/rules/tripwire.mdc` holds the project rules, and several test files were first written by the Cursor CLI agent and then reviewed (noted in `docs/log/`).

## Quick start (no keys needed)

Requires Node 22+ or Docker.

```bash
npm install
SAMPLE_MODE=true npm start
```

Or with Docker:

```bash
docker build -t tripwire .
docker run -p 8000:8000 -e SAMPLE_MODE=true tripwire
```

Open `http://localhost:8000` for the landing page and `http://localhost:8000/console` for the console (a guided tour starts on the first visit). With no keys, the console replays the recorded live Nemotron answers (the Nemotron badge says "replay"). They match each supplier's first decision; press **Fresh start** (under the data changes) to clear earlier decisions and memory and get them again. `npm start` builds the console first; for hot reload while editing it, run `npm run dev:web` next to the server and open `http://localhost:5173/console`. Or call the API:

```bash
curl -s -X POST localhost:8000/run -H 'content-type: application/json' --data @input_examples/02_decide_risky.json
```

SAMPLE_MODE uses the bundled data in `data/sample/` and the rule-based fallback for model steps. All agent logic, the critic loop, H-MEM memory, lineage and tripwires run for real; nothing is pre-computed. It needs no network.

## Live mode

```bash
cp .env.example .env    # then fill in the keys you have
npm start               # or: docker run -p 8000:8000 --env-file .env tripwire
```

Each sponsor is used live when its credentials are present and it answers a health check. Otherwise Tripwire uses the bundled fallback and says so at startup (`GET /health` shows the active modes).

- **Nightshift (primary):** run Nightshift, add your NVIDIA key in Nightshift > Setup > Providers, then set `METERLESS_BASE_URL` and `METERLESS_RUNTIME_TOKEN` (or `METERLESS_TOKEN_FILE`) from Nightshift > Console. Model ids per tier: `METERLESS_REASONING_MODEL`, `METERLESS_SMALL_MODEL`, `METERLESS_GUARD_MODEL` (Nemotron ids by default). To record a live run for the hosted replay, see [docs/NIGHTSHIFT.md](docs/NIGHTSHIFT.md).
- **Direct NVIDIA (backup only):** `NVIDIA_API_KEY` from build.nvidia.com. `LLM_PROVIDER=nightshift` turns the backup off; `LLM_PROVIDER=nvidia` skips Nightshift.
- **Zetaris:** run the local Zetaris platform (Docker, `http://localhost:3000`), set `ZETARIS_USERNAME` and `ZETARIS_PASSWORD` (or `ZETARIS_API_KEY` and `ZETARIS_ORG_ID`), then load the tables once:

  ```bash
  npx tsx scripts/zetaris_setup.ts init --data data/sample --reset-ledger
  ```

  From inside a container on Linux, run with `--network host` or set `ZETARIS_BASE_URL=http://host.docker.internal:3000`.

## Recording the Proving Ground live (Windows PC with Nightshift)

The Imagine and Crash-test steps and the backtest's model arms need real Nemotron answers. Nightshift runs only on Windows or Mac, so this is one session on the Windows PC. Everything it records is replayed later by anyone, with no keys. This section is the whole procedure in one place; [docs/NIGHTSHIFT.md](docs/NIGHTSHIFT.md) has the Nightshift set-up in more detail.

**1. Get the code (PowerShell, in the folder where you keep the repo).**

```powershell
git fetch origin
git checkout pg-integrate
git pull
npm install
```

**2. Start Nightshift and point Tripwire at it.** Nightshift must be running, with your NVIDIA key added in Nightshift > Setup > Providers (the key stays inside Nightshift). Copy the runtime URL and token from Nightshift > Console. They last only for this PowerShell window and are never written to the repo:

```powershell
$env:METERLESS_BASE_URL = "http://127.0.0.1:8088/v1"
$env:METERLESS_RUNTIME_TOKEN = "paste-the-token-from-Nightshift-Console"
```

Instead of the token you can set `$env:METERLESS_TOKEN_FILE` to Nightshift's `proxy-token` file. If you use a `RUN-ME.bat` that reads a `.env` file, keep that file outside the repo and make sure the bat runs the command in step 3.

**3. Record (one command, about 1 to 1.5 hours).**

```powershell
npx tsx scripts/record_live.ts; if ($?) { npx tsx scripts/backtest.ts --record --max-cases 40 }
```

| Part | What it does | Model calls | Time |
|---|---|---|---|
| `record_live.ts` | The demo story live: every supplier decided, each bundled change applied, data restored. Now includes the pre-mortem (Ultra) and the crash tests (Lightning) on every decision | about 300 to 400 | about 20 to 30 min |
| `backtest.ts --record --max-cases 40` | 40 past decisions spread over suppliers and years, each set using only what was filed by its date, for the two model arms of the backtest | about 800 (`npx tsx scripts/backtest.ts --budget` prints the estimate) | about 35 to 50 min |

The second part starts only if the first one finished. Both check that Nightshift answers before making any call; if it does not, they stop and record nothing.

**4. Watch the run number and the log.** Each part prints a line like `run 3: full log in logs/runs/run-0003-record_live.log` at the start. That file holds everything the script printed with times, one line per model call (which agent asked, which model answered, how long it took, and "ok" or the error), any crash with its full details, and how the run ended. Keys and tokens are blanked out, so the file is safe to share for debugging. `logs/` is never committed.

**5. If it stops part-way, resume instead of starting over.** Run only the part that stopped, with `--resume` added:

```powershell
npx tsx scripts/record_live.ts --resume
npx tsx scripts/backtest.ts --record --resume --max-cases 40
```

`--resume` continues the newest numbered run (`--resume 3` picks run 3) and writes to the same log file. Answers that run already got are reused, so only the missing or failed calls go to Nightshift again. If `record_live.ts` stopped, finish it with `--resume`, then run the backtest command without `--resume`.

**6. Check the summary at the end of each part.** It says how many calls a model answered, how many fell back to rules, how many have a Nightshift receipt, and which models really answered. Expected, and not a problem:

- **Safety-check calls fail with 404.** Nightshift 1.2.7 does not serve the Content Safety model. Those calls fall back and leave the decision unchanged.
- **Scores through Nightshift can be lower than called directly** (6/8 vs 8/8 on the clear-cut cases). Every model set-up scored lower through Nightshift; both results are reported.
- **"Busy" replies** (HTTP 429, 502, 503, 504) are retried up to twice before a call counts as failed.
- **Backtest cases whose model call failed** are left out of that model arm, never scored as the model's. The script lists them.

**7. Commit the recordings only.** Search them for your token and for `nvapi-` first; neither should appear.

```powershell
git add data/recordings/nightshift.jsonl data/backtest/recordings.jsonl
git commit -m "Live Nightshift recording for the Proving Ground"
git push origin pg-integrate
```

Never commit `.env`, `logs/` or the token. The recordings are appended to, not replaced: for each prompt, replay uses the newest record, including a failed one, so an older answer is never mixed in.

**8. Turn the recordings into numbers (any machine, no keys).**

```powershell
npx tsx scripts/eval_crash.ts --write
npx tsx scripts/backtest.ts --replay --max-cases 40
```

These replay the recorded answers and write the measured model-arm results into `eval/` (crash test and backtest). Only then do the "not recorded yet" entries in the Proving Ground table at the top of this README get real numbers.

---

## API

| Method and path | What it does |
|---|---|
| `POST /run` | Main entry point. Body `{"mode":"decide","subject_id":"SUP-18","question":"..."}` runs a decision. `{"mode":"reopen","subject_id":"SUP-06","change_file":"02_spend_share_jump.json"}` applies a bundled change file to the active data layer and lets the Watcher decide what to reopen. With Zetaris, the change is written to the source table with RUN EXPORT. To signal a change made outside Tripwire, pass `changed: {table, key}` instead. |
| `GET /health` | Active data, model and memory modes |
| `GET /decisions`, `GET /decisions/:id` | Decision ledger |
| `POST /decisions/:id/approve` | Human approval, body `{"reason":"..."}` (required for escalated decisions). Writes to the Zetaris ledger in live mode. |
| `POST /decisions/:id/reject` | Reject a proposed decision |
| `GET /suppliers`, `GET /changes/catalog` | Supplier names and the change files with descriptions, for the UI |
| `GET /changes`, `POST /changes/:file/apply` | Demo change feed: applies a bundled change file (to the sample files, or to the Zetaris tables in live mode), then runs the Watcher |
| `GET /trace/:run_id` | Trace events of a recent run |

The server listens on `0.0.0.0:$PORT` (default 8000). Errors are JSON (`{"error","detail"}`), never stack traces.

## Examples

Inputs are in `input_examples/`, the matching outputs (from a SAMPLE_MODE run) in `output_examples/`, each with its full trace (`*.trace.jsonl`). Their questions are worded differently from the recorded live run, so no recorded Nemotron answer matches and every model step shows "rule-based path" in the trace. Leave out `question` (as the console does) to get the replayed live answers instead: `04_decide_replayed_nemotron` does exactly that, and its trace names the Nemotron model, the Nightshift receipt and the recording time of every model step.

| # | Input | Result |
|---|---|---|
| 1 | Decide on SUP-17 Amphenol | **keep**, confidence 0.9: no risk flags on the reviewed metrics. Not escalated. |
| 2 | Decide on SUP-18 Jabil | **exit**, confidence 0.9: three financial distress signals (current ratio 0.98, liabilities to equity 17, gross margin 9.5%) with 3 alternative suppliers. Escalated for human approval. |
| 3 | SUP-06's spend share jumps from 35% to 58% | A baseline decision (dual_source, 0.85) is made first. The change fires its `spend_share > 0.45` tripwire and the decision is reopened. In the trace, the Evidence Critic rejects 3 recalled claims built on the old spend row (`needs_revision` → Memory Keeper), the Memory Keeper withholds them, and the new decision (dual_source, 0.8) supersedes the old one. |

To see selective reopening across the whole portfolio, run all 20 suppliers and then apply change 02: only SUP-06 is reopened.

```bash
npx tsx scripts/smoke_hmem.mts
```

## Logs

Every agent step is one JSON line in `logs/trace-<run_id>.jsonl` and on stdout (`TRACE_STDOUT=false` turns stdout off). Fields include `timestamp`, `run_id`, `decision_id`, `agent_name`, `action`, `event` (handoff, critique, retry, sponsor_call, decision, …), `input_summary`, `output_summary`, `target_agent`, `confidence`, `retry_count`, `status` and `sponsor`.

The live-recording scripts (`record_live.ts`, `backtest.ts`) also write one numbered log per run to `logs/runs/run-000N-<script>.log`: timestamped output, one line per model call, crashes and the exit code, with keys blanked out ([recording guide](#recording-the-proving-ground-live-windows-pc-with-nightshift)).

## Data

- `data/sample/supplier_financials.csv`: **real** quarterly financials for 20 US-listed companies, from SEC EDGAR (public domain), fetched on 2026-10-22 by `scripts/fetch_edgar.ts`.
- `data/sample/supplier_events.csv`: **real** SEC 8-K filings for the same companies, and `data/sample/sanctions_screen.csv`: a **real** name screen against the US Treasury OFAC SDN list, both fetched on 2026-10-25 by `scripts/fetch_sources.ts`. When each source was fetched and how current it is: `data/sample/source_status.csv`.
- `data/sample/supplier_spend.csv` and change files 02 and 03: **synthetic**. The buyer and its spend are fictional; picking a company implies nothing about it as a supplier.
- "Liabilities to equity" is total liabilities ÷ equity, not interest-bearing debt only. Details in `data/README.md`.

## Tests

```bash
npm test          # vitest: agents, graph, watcher, tripwires, Zetaris adapter, H-MEM adapter, upstream H-MEM smoke test
npm run typecheck
```

## Limitations

- The supplier spend data is synthetic; only the financials are real.
- H-MEM's reference engine embeds text with a deterministic hash, not a semantic model. Its value here is lineage, supersession and the audit ledger, not search quality.
- Zetaris has no row-level writes, so the decision ledger is append-only Parquet; status changes are new rows, not updates.
- There is no change-data-capture feed from Zetaris. The Watcher runs when a change is applied through Tripwire or reported through `POST /run` with the changed row.
- Applying a change that replaces an existing Zetaris row rewrites that table (Parquet export, then re-register), which is fine for demo-sized tables only.
- The rule-based fallback policy is simple (fixed thresholds). It exists so the system runs without keys, not as the intended decision maker.
- This is a hackathon build. It has not been load-tested or security-reviewed for production use.

## Pre-existing components

- `vendor/hmem/`: Meterless H-MEM reference engine, Apache-2.0, upstream commit `1742dec` (see `vendor/hmem/README.md` for the one change: import extensions).
- Open-source libraries listed in `package.json` (Hono, zod, vitest, tsx, TypeScript).
- Planning notes written before the build window (product idea and research). They contain no code.

All code in this repository was written during the build window, starting 2026-10-22.

## Project layout

```
server.ts                 HTTP API and UI server
app/agents/               Planner, Analyst, Critic, Memory Keeper, Risk Officer, Decider
app/orchestration/        Decision graph and shared run state
app/watcher.ts            Selective reopen
app/tripwires.ts          Tripwire validation and evaluation
app/adapters/             Zetaris, Meterless H-MEM, Nemotron, sample data, local fallback memory
app/sql/                  Approved SQL templates and Zetaris table definitions
scripts/                  EDGAR fetch, Zetaris setup, smoke run
vendor/hmem/              Meterless H-MEM (vendored)
console/                  The console: React + Vite (src/), built into web-dist/ by `npm run build:web`
web/                      Landing page (index.html), shared theme and tour (assets/); copied into the console build
```
