# Selective reopen: what a source change costs

Generated 2026-10-25 14:04 UTC by `npx tsx scripts/eval_reopen.ts --write`.

For each change, all 20 suppliers are first decided on the data before it, with the rows each decision read recorded in memory. The change is applied and the Watcher reopens what it thinks is affected: memory names the decisions that read the changed row, code checks only their tripwires, and only those that fire are re-decided. As ground truth, all 20 are then re-decided from scratch on the changed data; "Outcome changed" lists those whose label or escalation differs from before. A decision whose outcome changed but was not reopened is a miss.

| Change | Real or synthetic | Decisions that read the row | Reopened | Outcome changed under a full re-decide | Missed | Re-runs: everything / same table / Tripwire |
|---|---|---|---|---|---|---|
| Vishay's next quarterly financials arrive (SEC) | real | 1 | 1 (SUP-20: dual_source → dual_source) | 0 | 0 | 20 / 20 / 1 |
| Dow files an 8-K: item 2.05, restructuring (SEC) | real | 1 | 1 (SUP-05: dual_source (escalated) → exit (escalated)) | 1 (SUP-05) | 0 | 20 / 20 / 1 |
| OFAC screen returns a possible match for Eastman | synthetic | 1 | 1 (SUP-08: keep → exit (escalated)) | 1 (SUP-08) | 0 | 20 / 20 / 1 |
| ERP: Celanese's share of chemicals spend 35% → 58% | synthetic | 4 | 0 | 0 | 0 | 20 / 20 / 0 |
| ERP: XPO's quoted lead time 3 → 9 weeks | synthetic | 4 | 0 | 0 | 0 | 20 / 20 / 0 |
| **All 5 changes** | | 11 | **3** | 2 | **0** | 100 / 100 / **3** |

Over 5 changes, Tripwire re-ran 3 decisions where re-deciding everything takes 100 and re-deciding everything that reads the changed table takes 100. It missed 0 of the 2 decisions whose outcome changed, and every reopened decision landed where a from-scratch decision on the new data lands.

At the shipped graph's measured cost per decision in the live run of 2026-10-25 (4.0 model calls, 2,364 tokens, 18 s of model time; provider: nvidia), the 97 re-runs not made are about 388 model calls, 229,308 tokens and 29 minutes of model time.

How to read it:
- Decisions here use the rule-based policy, so the run is exact and needs no key. Which decisions get reopened is decided in code (lineage, then tripwires), never by a model, so the selectivity is the same whichever model then decides. The cost line multiplies the re-runs avoided by the live run's measured average; it is an estimate, not a separate measurement.
- The ground truth is the rule-based policy too. A model deciding from scratch could change an outcome that no tripwire watches (for example, moving Celanese from dual-source to exit after the spend jump); the tripwires are the line the buyer agreed to, and anything they do not cover is not re-run. That is the trade the design makes, and this table does not measure it.
- A reopened decision can keep its label: a tripwire fired, so the case was looked at again, but the new evidence was not enough to change it.
- The Watcher also reads the current rows for each dependent decision to check its tripwires. That is a few SQL queries per dependent, with no model call.
- Five changes on 20 suppliers is a small set. The two SEC filings are real; the OFAC match and the two ERP changes are synthetic and labelled so in [cases.json](cases.json) and `data/sample/changes/`.

Per-change detail, including which tripwire fired, is in [reopen_results.json](reopen_results.json).
