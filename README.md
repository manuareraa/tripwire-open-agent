# Tripwire

**Track 01: Fragmented Intelligence** · Open Agent Hackathon 2026 · solo entry

Tripwire is a team of agents that makes a business decision, writes down exactly which data rows the decision depends on, and sets "tripwires": the conditions under which the decision should be looked at again. When a source row changes later, Tripwire does not re-run everything. It asks memory which decisions were built on that row, checks only their tripwires, and reopens only the ones that fire.

The demo domain is supplier risk: for each of 20 suppliers, should we **keep**, **dual-source** (add a second supplier) or **exit**?

Demo video: _link added before submission_

### Nemotron at a glance: what each model does, and what we measured

| Model (how it is reached) | Job in Tripwire | Measured against | Result | Source |
|---|---|---|---|---|
| Nemotron 3.5 Lightning 30B (Nightshift) | Plans the queries, summarises the evidence | Ultra alone, Lightning alone | Agent graph: 23/23 decisions with every number grounded vs 17/23 for one Ultra call (Nightshift run) | [eval/nightshift/RESULTS.md](eval/nightshift/RESULTS.md) |
| Nemotron 3 Ultra 550B (Nightshift) | Decides keep / dual-source / exit; thinking budget set by risk grade | Thinking always on | Thinking always on took 58% more model time (662 s vs 418 s) and scored lower on labels, 7/8 vs 8/8 (direct run) | [eval/RESULTS.md](eval/RESULTS.md) |
| Nemotron 3.5 Content Safety (build.nvidia.com; Nightshift 1.2.7 does not serve it) | Final check on the recommendation | Keyword filter | 19/22 harmful caught, 0/10 safe flagged, vs 11/22 and 1/10 | [eval/SAFETY.md](eval/SAFETY.md) |
| Nemotron 3.5 Rerank 8B (build.nvidia.com, optional) | Puts the findings that answer the question first | Keyword overlap | Right first item in 34/34 rankings vs 8/34 | [eval/RERANK.md](eval/RERANK.md) |

Clear-cut labels, the same 8 cases both times (small sample): the agent graph got 8/8 called directly on build.nvidia.com and 6/8 through Nightshift, where every model set-up scored lower and leaned towards dual-sourcing; simple rules get 8/8 on these cases by construction. We report both. A live Nightshift answer, replayed offline with its receipt ids, is in [output_examples/04_decide_replayed_nemotron.trace.jsonl](output_examples/04_decide_replayed_nemotron.trace.jsonl).

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

Open `http://localhost:8000` for the landing page and `http://localhost:8000/console` for the console (a guided tour starts on the first visit). `npm start` builds the console first; for hot reload while editing it, run `npm run dev:web` next to the server and open `http://localhost:5173/console`. Or call the API:

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
