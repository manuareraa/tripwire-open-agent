# Crash test: do the tripwires really change the call?

Generated 2026-10-27 09:48 UTC by `npx tsx scripts/eval_crash.ts --write` on the 20 sample suppliers.

Each proposed tripwire is pushed just past its line and just short of it, and the decision is made again with only that number moved.
**Verified**: holds short of the line, changes past it. **Decorative**: still holds past the line. **Mis-set**: already changes short of the line.
Survived = tripwires kept as verified (first try, or after one reset of a mis-set line) ÷ tested. Plain-language explanation: `docs/proving/CRASH.md`.

## Control: the rule-based policy re-decides (not a model)

The decisions here are made by the rule-based policy, and the same policy re-decides. This is a control, not a model result: it shows which proposed lines the policy itself would act on.

| Group | Proposed | Tested | Verified | Mis-set, reset, then verified | Mis-set, dropped | Decorative | Untested | Already true today | Survived |
|---|---|---|---|---|---|---|---|---|---|
| all | 80 | 80 | 41 | 6 | 0 | 33 | 0 | 0 | 59% |

By who proposed the tripwire:

| Group | Proposed | Tested | Verified | Mis-set, reset, then verified | Mis-set, dropped | Decorative | Untested | Already true today | Survived |
|---|---|---|---|---|---|---|---|---|---|
| rules | 80 | 80 | 41 | 6 | 0 | 33 | 0 | 0 | 59% |

By decision:

| Group | Proposed | Tested | Verified | Mis-set, reset, then verified | Mis-set, dropped | Decorative | Untested | Already true today | Survived |
|---|---|---|---|---|---|---|---|---|---|
| dual_source | 48 | 48 | 25 | 2 | 0 | 21 | 0 | 0 | 56% |
| keep | 20 | 20 | 16 | 4 | 0 | 0 | 0 | 0 | 100% |
| exit | 12 | 12 | 0 | 0 | 0 | 12 | 0 | 0 | 0% |

## Nemotron Lightning re-decides

Not run yet: there are no recorded live CrashTester answers. It runs inside the decision graph during the live recording, and this script then replays it.
