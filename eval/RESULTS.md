# Measured comparison

Generated 2026-10-25 13:47 UTC by `npx tsx scripts/eval_arms.ts --write` over 23 cases from [cases.json](cases.json).
Each arm's "Run" column says whether it ran live, was replayed from a recorded live run, or used no model; the list under the table names the models and the provider that answered (nightshift = Meterless Nightshift, nvidia = build.nvidia.com directly).

| Arm | Run | Expected label | Valid | Numbers grounded | Tripwires valid | Stale source named | Escalated when required | Rule-based decisions | Model calls (fallbacks) | Tokens in / out | Model time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | rules | 8/8 | 23/23 | 23/23 | 23/23 | 6/6 | 1/1 | 23/23 | 92 (92) | 0 / 0 | 0 s |
| ultra_alone | live | 8/8 | 23/23 | 22/23 | 22/23 | 6/6 | 1/1 | 0/23 | 23 (0) | 12,711 / 5,733 | 185 s |
| lightning_only | live | 7/8 | 23/23 | 23/23 | 23/23 | 6/6 | 1/1 | 9/23 | 100 (6) | 37,625 / 34,892 | 420 s |
| tripwire | live | 8/8 | 23/23 | 23/23 | 23/23 | 6/6 | 1/1 | 1/23 | 92 (1) | 36,033 / 18,339 | 418 s |
| thinking_always | live | 7/8 | 23/23 | 23/23 | 23/23 | 6/6 | 1/1 | 1/23 | 92 (2) | 35,416 / 27,487 | 662 s |

- **ultra_alone** was answered by: nvidia/nemotron-3-ultra-550b-a55b (provider: nvidia)
- **lightning_only** was answered by: nvidia/nemotron-3.5-lightning-30b-a3b, nvidia/nemotron-3.5-content-safety (provider: nvidia)
- **tripwire** was answered by: nvidia/nemotron-3.5-lightning-30b-a3b, nvidia/nemotron-3-ultra-550b-a55b, nvidia/nemotron-3.5-content-safety (provider: nvidia)
- **thinking_always** was answered by: nvidia/nemotron-3.5-lightning-30b-a3b, nvidia/nemotron-3-ultra-550b-a55b, nvidia/nemotron-3.5-content-safety (provider: nvidia)

How to read it: expected labels exist only for clear-cut cases. The other columns are checks any good decision should pass, applied by code to every arm alike. "Rule-based decisions" counts cases where the graph fell back to the rule-based policy; those pass the checks by construction, so a model arm with many of them says little about the model.
Per-case rows are in [results.json](results.json).
