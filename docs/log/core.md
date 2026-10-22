# Core stream log (agents, orchestration, watcher)

## 2026-10-22

- Built the model client (`app/adapters/model.ts`) for Nemotron on build.nvidia.com. Probed which models this account can call:
  `nemotron-3-ultra-550b-a55b` (reasoning), `nemotron-3.5-lightning-30b-a3b` (small), `nemotron-3.5-content-safety` (guard).
  Super, Nano and the llama-3.1-nemotron models returned 404 for this key. The client never throws; on any failure it reports `fallback` and the agents use rules.
- Built the agents (Planner, Analyst, Evidence Critic, Memory Keeper, Risk Officer, Decider), the decision graph and the Watcher.
- Critic number check: a number in model prose is accepted only if it matches evidence at the precision written
  ("0.9" may stand for 0.85, "0.55" may not). The first version used a flat ±0.05 and let an invented 0.55 pass because a 0.6 threshold was close; the graph test caught it.
- Tests: `test/fakes.ts` (in-memory gateway, memory with lineage, scripted model) and `test/graph.test.ts`:
  rule path, critic rejection then fix, round-limit fallback, and selective reopen (1 of 5 decisions re-run, 4 untouched).

### Cursor use
- `agent -p --model composer-2.5` (Cursor CLI, run under `scripts/memguard.sh`) wrote `test/model.test.ts`: 6 cases against a mocked `fetch`
  (no key, thinking flag + reasoning excerpt, guard sends user-only, 400 retry without `response_format`, 500 fallback, JSON extraction).
  Reviewed and kept as written; all pass.
