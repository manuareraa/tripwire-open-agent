# How Tripwire uses NVIDIA Nemotron

Tripwire makes supplier decisions (keep, dual-source or exit) with a team of agents, and records which data rows each
decision relied on so it can reopen the decision when one of those rows changes. Five Nemotron models do five
different jobs in that team. Each job has its own measurement against a cheaper alternative, and every number below
comes from a recorded live run that anyone can replay without a key.

| Job | Model | Where in the code | Served by |
|---|---|---|---|
| Plan the queries, summarise the findings | Nemotron 3.5 Lightning 30B (`nvidia/nemotron-3.5-lightning-30b-a3b`) | `app/agents/planner.ts`, `app/agents/analyst.ts` | Nightshift (build.nvidia.com as a labelled backup) |
| Decide, with a thinking budget set by risk | Nemotron 3 Ultra 550B (`nvidia/nemotron-3-ultra-550b-a55b`) | `app/agents/decider.ts` | Nightshift (same backup) |
| Final safety check on the recommendation | Nemotron 3.5 Content Safety (`nvidia/nemotron-3.5-content-safety`) | `app/agents/risk.ts` | build.nvidia.com directly (Nightshift 1.2.7 does not serve it; see below) |
| Put the findings that answer the buyer's question first | Nemotron 3.5 Rerank 8B (`nvidia/nemotron-3.5-rerank-8b`) | `app/adapters/rerank.ts`, `app/agents/analyst.ts` | build.nvidia.com directly (Nightshift serves chat models only) |
| Read the supplier's real 8-K filings (offline, once; output cached) | Nemotron Parse (`nvidia/nemotron-parse`) | `scripts/parse_filings.ts`, `app/proving/filings.ts` | build.nvidia.com directly (see [proving/READ.md](proving/READ.md)) |

Every call writes the model that actually answered, the provider and the latency into the decision's trace. If a
model cannot answer, the step falls back to a rule-based path and the trace and the rationale say so; a fallback is
never shown as a model answer.

## What each model is measured against

### Content Safety: 19 of 22 harmful recommendations caught, 0 of 10 safe ones flagged

[eval/SAFETY.md](../eval/SAFETY.md) · probes in [eval/safety_probes.json](../eval/safety_probes.json)

The Risk Officer sends the final recommendation to the safety model before a human sees it. To measure that check we
wrote 32 recommendations in the exact form it receives: 22 a hijacked or careless model might write (an echoed prompt
injection, tipping off a supplier under a sanctions review, leaked credentials or personal data, illegal proposals)
and 10 ordinary ones that use the same alarming words ("sanctions", "exit", "ignore", "warn", "password policy").
The labels were written before any model run. The baseline is a keyword filter written at the same time.

| | Keyword filter | Nemotron 3.5 Content Safety |
|---|---|---|
| Harmful recommendations caught | 11 / 22 | **19 / 22** |
| Safe recommendations wrongly flagged | 1 / 10 | **0 / 10** |

Recorded live on 2026-10-25 against build.nvidia.com (`scripts/safety_probes.ts --direct`); every answer came from
`nvidia/nemotron-3.5-content-safety`. The three it passed are worth knowing: a request to print the system prompt and
runtime token (inj-04), telling a supplier which sanctions-list entry matched (tip-04) and agreeing prices with other
buyers (harm-03). The guard is not the only check: in code, any decision on a supplier with a sanctions match is
graded high risk and escalated to a person whatever the guard says (`app/agents/risk.ts`).

### Rerank: the right finding first in 34 of 34 cases, against 8 of 34 for keyword overlap

[eval/RERANK.md](../eval/RERANK.md) · questions in [eval/rerank_gold.json](../eval/rerank_gold.json)

The Analyst produces nine findings per supplier (current ratio, liabilities to equity, margin, sanctions matches and
so on). Rerank orders them by the buyer's question so the summary, and the Decider reading it, start with the evidence
the question is about. We wrote 17 buyer questions, mostly in a buyer's words rather than the metric's label ("Can
they pay their bills over the next few months?" rather than "current ratio"), and marked which findings answer each.

| Ranking | hit@1 | recall@3 | MRR |
|---|---|---|---|
| Keyword overlap | 0.24 | 0.35 | 0.44 |
| Nemotron 3.5 Rerank 8B | **1.00** | **0.97** | **1.00** |

34 rankings (17 questions x 2 suppliers), recorded live on 2026-10-25. hit@1 is the share of rankings whose top
finding answers the question; recall@3 the share of answering findings in the top three; MRR the average of 1 / the
rank of the first answering finding. Each ranking has only nine short candidates, so this is an easy retrieval task:
it shows the model understands a buyer's wording where keyword matching does not, not how it would do on a large
corpus. Rerank is off by default in the app and turned on with `RERANK=nvidia`; it reorders findings and never drops
one.

### Lightning and Ultra: the agent graph against one big model call

[eval/RESULTS.md](../eval/RESULTS.md) · cases in [eval/cases.json](../eval/cases.json)

`scripts/eval_arms.ts` runs 23 decision cases (the 20 suppliers plus three data changes: a sanctions hit, a new 8-K
filing and a spend shift) through five set-ups and scores every answer in code on the same checks: the expected label
where the case is clear-cut (8 of 23), a valid answer, every number traceable to the data, valid tripwires, stale
sources named, and escalation when the policy requires it.

| Set-up | Right label | Numbers grounded | Tripwires valid | Fell back to rules | Model calls | Output tokens | Model time |
|---|---|---|---|---|---|---|---|
| Rules only (no model) | 8/8 | 23/23 | 23/23 | 23/23 | 0 | 0 | 0 s |
| One Ultra call, no agents | 8/8 | 22/23 | 22/23 | 0/23 | 23 | 5,733 | 185 s |
| Agent graph, Lightning only | 7/8 | 23/23 | 23/23 | 9/23 | 100 | 34,892 | 420 s |
| **Agent graph as shipped** | **8/8** | **23/23** | **23/23** | **1/23** | 92 | 18,339 | 418 s |
| Agent graph, thinking always on | 7/8 | 23/23 | 23/23 | 1/23 | 92 | 27,487 | 662 s |

Recorded live on 2026-10-25 against build.nvidia.com (`--direct`), because the Nightshift machine was not set up yet;
every answer came from the three Nemotron models named above. What it shows:

- **The graph as shipped is the only model set-up that passed every check on every case.** Ultra on its own got every
  clear-cut label right and is cheaper, but on SUP-07 it wrote a number that is not in the data, and on the sanctions
  case it wrote a tripwire that cannot be evaluated. Nothing in a single call checks for either; in the graph, the
  Evidence Critic sends such drafts back.
- **Ultra is needed for the decision.** With Lightning deciding, 9 of 23 cases ended on the rule-based path: 6 because
  a call timed out or came back empty, 3 because its drafts were never accepted (not valid JSON, or rejected by the
  critic three times). It also missed one label.
- **Thinking only when the case is risky beats thinking always.** Thinking on every step used 50% more output tokens
  and 58% more model time, and missed a label (SUP-17) that the shipped graph got right.

Limits: 23 cases is a small set, and most checks pass for most set-ups, so the differences are a handful of cases.
The rules-only row passes by construction (the expected labels were written from the same policy); it is there as the
floor, not as a competitor. The one rule-based case in the shipped graph was a 60-second timeout, not a bad answer;
the direct client's timeout is 60 s, Nightshift's 180 s.

**The same comparison through Nightshift** ([eval/nightshift/RESULTS.md](../eval/nightshift/RESULTS.md)), recorded on
2026-10-27 with every Lightning and Ultra call answered through Meterless Nightshift and carrying its receipt:

| Set-up | Right label | Numbers grounded | Tripwires valid | Fell back to rules | Model calls (fallbacks) | Output tokens | Model time |
|---|---|---|---|---|---|---|---|
| One Ultra call, no agents | 7/8 | 17/23 | 21/23 | 0/23 | 23 (0) | 5,541 | 116 s |
| Agent graph, Lightning only | 7/8 | 23/23 | 23/23 | 3/23 | 98 (26) | 49,985 | 672 s |
| **Agent graph as shipped** | 6/8 | **23/23** | **23/23** | 1/23 | 101 (23) | 10,491 | 231 s |
| Agent graph, thinking always on | 7/8 | 23/23 | 23/23 | 0/23 | 99 (23) | 10,138 | 242 s |

The pattern from the direct run holds where it matters most: Ultra on its own wrote numbers that are not in the data
on 6 of 23 cases and 2 invalid tripwires, and the graph wrote none. The label scores are lower for every model arm.
SUP-08 (expected keep) came back dual_source everywhere, and the shipped graph also chose dual_source for SUP-17. The
same Ultra prompts cost about 1,350 input tokens through Nightshift against 554 directly, so Nightshift adds its own
context to each call; we think that is what moves the answers, but have not proved it. Two more things to know:

- Nightshift 1.2.7 does not serve Content Safety (`nvidia/nemotron-3.5-content-safety` returns 404). In a Nightshift
  run the guard step records "unknown" and the decision goes ahead unchanged; that is the 23 fallbacks in each graph
  row. The guard's own numbers above come from build.nvidia.com.
- The 3 extra fallbacks in the Lightning-only row are HTTP 502 errors from Nightshift on the deciding step.

## Run it yourself

With no key, every script replays the committed recordings and says "replay of a live run recorded …":

```bash
npx tsx scripts/eval_arms.ts
npx tsx scripts/safety_probes.ts
SAMPLE_MODE=true npx tsx scripts/eval_rerank.ts
```

To record new live runs, set `NVIDIA_API_KEY` in the terminal (never in a file) and pass `--direct --overwrite` to
the comparison or the safety script, or remove `eval/recordings/rerank.jsonl` before the rerank one. Add `--write` to regenerate the
reports. The scripts refuse `--write` when no model answered, so a report can only come from real model output.
