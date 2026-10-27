# Measured comparison, through Meterless Nightshift

The same 23 cases as [../RESULTS.md](../RESULTS.md), recorded live on 2026-10-27 on a Windows PC with every Lightning and
Ultra call going through Meterless Nightshift 1.2.7 (each answer carries a Nightshift receipt). Replay it with
`npx tsx scripts/eval_arms.ts --recordings eval/nightshift/recordings`. Two differences from the direct run:

- Nightshift 1.2.7 does not serve Nemotron Content Safety, so every guard call in the multi-agent arms returned HTTP 404
  and fell back (the 23 fallbacks in each of those rows). A guard fallback records the verdict "unknown" and does not
  change the decision. The guard is measured on its own, directly, in [../SAFETY.md](../SAFETY.md).
- The same Ultra prompts cost about 1,350 input tokens each through Nightshift against 554 directly, so Nightshift adds
  roughly 800 tokens of its own context to each call. Answers leaned more towards dual-sourcing: SUP-08 (expected keep)
  came back dual_source in every model arm, and SUP-17 (expected keep) in the shipped graph. That the extra context
  causes this is our reading, not something we measured.


Generated 2026-10-27 02:14 UTC by `npx tsx scripts/eval_arms.ts --write` over 23 cases from [cases.json](../cases.json).
Each arm's "Run" column says whether it ran live, was replayed from a recorded live run, or used no model; the list under the table names the models and the provider that answered (nightshift = Meterless Nightshift, nvidia = build.nvidia.com directly).

| Arm | Run | Expected label | Valid | Numbers grounded | Tripwires valid | Stale source named | Escalated when required | Rule-based decisions | Model calls (fallbacks) | Tokens in / out | Model time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | rules | 8/8 | 23/23 | 23/23 | 23/23 | 6/6 | 1/1 | 23/23 | 92 (92) | 0 / 0 | 0 s |
| ultra_alone | live | 7/8 | 23/23 | 17/23 | 21/23 | 6/6 | 0/1 | 0/23 | 23 (0) | 31,176 / 5,541 | 116 s |
| lightning_only | live | 7/8 | 23/23 | 23/23 | 23/23 | 6/6 | 1/1 | 3/23 | 98 (26) | 80,414 / 49,985 | 672 s |
| tripwire | live | 6/8 | 23/23 | 23/23 | 23/23 | 6/6 | 1/1 | 1/23 | 101 (23) | 89,384 / 10,491 | 231 s |
| thinking_always | live | 7/8 | 23/23 | 23/23 | 23/23 | 6/6 | 1/1 | 0/23 | 99 (23) | 86,784 / 10,138 | 242 s |

- **ultra_alone** was answered by: nvidia/nemotron-3-ultra-550b-a55b (provider: meterless-nightshift)
- **lightning_only** was answered by: nvidia/nemotron-3.5-lightning-30b-a3b (provider: meterless-nightshift)
- **tripwire** was answered by: nvidia/nemotron-3.5-lightning-30b-a3b, nvidia/nemotron-3-ultra-550b-a55b (provider: meterless-nightshift)
- **thinking_always** was answered by: nvidia/nemotron-3.5-lightning-30b-a3b, nvidia/nemotron-3-ultra-550b-a55b (provider: meterless-nightshift)

How to read it: expected labels exist only for clear-cut cases. The other columns are checks any good decision should pass, applied by code to every arm alike. "Rule-based decisions" counts cases where the graph fell back to the rule-based policy; those pass the checks by construction, so a model arm with many of them says little about the model.
Per-case rows are in [results.json](results.json).
