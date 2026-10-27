# Proving Ground stage 3: Crash-test

## Integration requests

1. **`test/recording.test.ts` line 75** (needed, one line): CrashTester calls are now recorded like every other agent's, so the expected agent set gains one name:
   ```ts
   expect(new Set(recs.map((r) => r.agent_name))).toEqual(new Set(["Planner", "Analyst", "Decider", "RiskOfficer", "CrashTester"]));
   ```
   Checked on a temporary copy: with this change the whole recording test passes (4 of 4), including replaying the CrashTester answers to the same decisions.
2. **`scripts/record_live.ts`**: no change needed. The crash test runs inside the decision graph, so its Lightning calls are recorded with the rest.
3. **Optional, `app/tripwires.ts` `defaultTripwires`**: the crash test found that the rule-based spend-share line (today + 0.10) can sit past the policy's own 0.30 switch point, so for a "keep" supplier at 0.25 the line 0.35 is mis-set (the call already changes at 0.31). The crash test fixes it per decision by resetting the line; a source fix would be `threshold = v < 0.3 ? 0.3 : Math.min(1, v + 0.1)`. Not required, and it would change the rule-based examples, so it is the coordinator's call.
4. **README / video line** (measured, rules control only; see below): "On the 20 sample suppliers, 47 of 80 rule-based tripwires survived the crash test; every exit tripwire came out decorative, and 6 lines were set too far out and were moved." Replace with the Lightning numbers after the live recording.

## What it does, in plain words

A tripwire says "reopen this decision if spend share goes above 55%". It is only worth having if crossing that line would really change the decision. Nobody checks that today. The crash test does, like a car crash test: it pushes the number just past the line and asks Nemotron 3.5 Lightning (the small, fast model) to decide again; then, as a control, it sets the number just short of the line and asks again.

| Verdict | What happened | What we do |
|---|---|---|
| **verified** | Just short of the line the call holds; just past it the call changes | keep it |
| **decorative** | Even past the line the call does not change | drop it: it would reopen the decision for nothing |
| **mis-set** | The call already changes before the line is reached | move the line once, halfway towards today's value, and test again; keep it if that verifies, else drop it |
| **untested** | No model answer, no number today, or a "fires on any change" tripwire with no line to push | keep it as proposed, with the reason shown |

"Just past" and "just short" use the smallest step that means something for each unit: 0.05 for ratios, 1 percentage point for shares (0.01), 1 point for percentage changes, 1 week, 1 for counts.

Rules that keep it honest:
- Only one number moves per test; every other number stays at today's value.
- The prompt holds only the decision and the numbers (no ids, no dates), so the same test gives the same prompt and replays from the recording.
- Past the line is asked first. If the call holds there, the tripwire is decorative and the control call is skipped. Two candidates on the same number share an answer.
- A tripwire that is already true today is dropped (it can never fire).
- A decision never ends with no tripwires. If none verify, the ones the Decider (or the rule-based policy) proposed are kept, with their verdicts shown, and a line in the decision's limitations says so.
- With no model and no recording, nothing is tested: every candidate is marked untested with the reason, the stage is listed in `proving.skipped`, and the decision completes as before. A verdict is never made up.

### What "changes the call" means for each decision

The test counts a change when the re-decision names a different decision (keep, dual_source or exit).

- **keep**: the useful lines are on the way to trouble. Crossing them should move the call to dual_source or exit.
- **dual_source**: a line can change the call either way: to exit (the supplier gets much worse) or back to keep (the risk that made us add a second source goes away). Lines that only say "a bit worse again" are often decorative, because dual_source already covers them.
- **exit**: the supplier getting worse never changes an exit; it only confirms it. So lines in the "worse" direction come out decorative, and the measured result shows exactly that (0 of 12). What can change an exit is the backup supplier failing (the backup's own tripwires, added by the Backup Picker and not crash-tested here) or the supplier recovering. For an exit the stage keeps the proposed lines and says so in the limitations, rather than leaving the decision with nothing that can reopen it.

## Where it sits

`app/proving/crashtest.ts`, called from `app/orchestration/graph.ts` after the pre-mortem. Its candidates are the Decider's (or the rules') tripwires plus the pre-mortem's. Backup and stale-source tripwires are added afterwards and are not crash-tested. Each kept tripwire carries `crash_test` (verdict, values tried, the re-decisions, one sentence on why). `decision.proving.crash` holds the counts and the dropped tripwires with their reason. The trace gets one CrashTester event per test, for example:

```
spend share 0.31 (past 0.3): dual_source instead of keep; 0.29 (short of it): still keep → verified
```

The console shows "X of Y tripwires survived the crash test" and one row per tested tripwire with its badge and the one-line why (`console/src/proving/CrashStage.tsx`).

## Measured results

Script: `npx tsx scripts/eval_crash.ts --write` → `eval/CRASH.md`, `eval/crash_results.json`. All 20 sample suppliers.

**Control arm, the rule-based policy re-decides (not a model).** The decisions are made by the rule-based policy and the same policy re-decides with one number moved. It shows which proposed lines the policy itself would act on. It is partly circular (the rules' tripwire lines sit near the policy's own lines), so it is a control, not a headline.

| Decision | Proposed | Verified | Mis-set, reset, then verified | Decorative | Survived |
|---|---|---|---|---|---|
| all | 80 | 41 | 6 | 33 | 59% |
| keep | 20 | 16 | 4 | 0 | 100% |
| dual_source | 48 | 25 | 2 | 21 | 56% |
| exit | 12 | 0 | 0 | 12 | 0% |

All 80 come from the rules, because in the keyless run there is no Decider model and the pre-mortem is not built on this branch yet. The by-origin split (rules / Decider / pre-mortem) fills in once those arms have answers.

**Model arm, Nemotron Lightning re-decides: measured** from the live Nightshift recording of 2026-10-27 (316 recorded Lightning answers, replayed by `scripts/eval_crash.ts --write`):

| Who proposed it | Proposed | Tested | Verified first try | Mis-set, reset, then verified | Mis-set, dropped | Decorative | Survived |
|---|---|---|---|---|---|---|---|
| Ultra Decider | 76 | 75 | 8 | 6 | 53 | 8 | 19% |
| Ultra pre-mortem | 37 | 28 | 2 | 1 | 21 | 4 | 11% |
| rules | 4 | 4 | 1 | 0 | 3 | 0 | 25% |

10 crash-test prompts had no recorded answer (the replayed run differs slightly from the recorded one) and are counted as untested, not as passed. Most of Nemotron's own lines were mis-set: the call already changed when the number stopped just short of the line. That can mean the line is set too far out, or that Lightning's re-decision is unsteady near the line; this test cannot tell the two apart. Either way those lines are dropped before the human sees them. The control above uses a different re-decider (the rules), so its 59% is not a like-for-like comparison.

## Model-call budget for the live recording

- Per candidate tripwire: 1 Lightning call if it is decorative (the control is skipped), 2 if the call changes, plus 2 more if a mis-set line is reset. About 2 calls per candidate on average; the control arm needed 139 re-decisions for 80 candidates (1.7 each).
- Per decision: about 4 Decider tripwires plus the pre-mortem's (say 3) gives about 7 candidates, so about 12-15 Lightning calls.
- 20 suppliers: about 250-300 Lightning calls. At the measured 1.8 s average per Lightning call (55 recorded calls in `data/recordings/nightshift.jsonl`), that is about 8-9 minutes, run one after another.
- Lightning only (`tier: "small"`, JSON, max 300 tokens). No Ultra, no extra script: `scripts/record_live.ts` records these calls with the rest.
