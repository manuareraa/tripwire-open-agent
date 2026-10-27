# Backtest: Tripwire's tripwires on real SEC history

Written by `scripts/backtest.ts` from SEC EDGAR data fetched 2026-10-27. Rules: `docs/proving/BACKTEST.md` (pre-registered).
Window: 2021Q2–2026Q1. 200 decisions = 20 suppliers x 10 as-of dates, each watched for 2 quarters.

| Arm | Status | Decisions | Trouble events | Caught early (fired before the filing date) | A quarter or more early | Median quarters of warning | Firings | False alarms |
|---|---|---|---|---|---|---|---|---|
| Rule-based tripwires (no model) | measured | 200 | 67 (52 8-K, 15 covenant) | 7 | 3 | 0 | 49 | 14 |
| Ultra decider tripwires | measured | 40 | 9 (5 8-K, 4 covenant) | 0 | 0 | n/a | 1 | 1 |
| Pre-mortem + crash-tested tripwires | measured | 40 | 9 (5 8-K, 4 covenant) | 0 | 0 | n/a | 4 | 3 |
| Rule-based tripwires (no model), same 40 decisions | measured | 40 | 9 (5 8-K, 4 covenant) | 1 | 1 | 1 | 11 | 4 |

Arms marked "not run yet" have no numbers: they are never estimated.

- **Ultra decider tripwires:** replay: 40 of 200 decisions (an even spread), 40 with the Decider answered by the model (cases where an arm's own call failed are left out of that arm), 0.0 minutes.
- **Pre-mortem + crash-tested tripwires:** replay: 40 of 200 decisions (an even spread), 40 with the Decider answered by the model (cases where an arm's own call failed are left out of that arm), 0.0 minutes.

## Per supplier (rule arm)

| Supplier | Ticker | Trouble events | Caught early | Firings | False alarms |
|---|---|---|---|---|---|
| SUP-01 | TXN | 0 | 0 | 0 | 0 |
| SUP-02 | MCHP | 4 | 1 | 2 | 0 |
| SUP-03 | ON | 4 | 2 | 4 | 0 |
| SUP-04 | WOLF | 6 | 3 | 5 | 0 |
| SUP-05 | DOW | 1 | 0 | 4 | 2 |
| SUP-06 | CE | 4 | 1 | 4 | 2 |
| SUP-07 | HUN | 1 | 0 | 2 | 2 |
| SUP-08 | EMN | 1 | 0 | 0 | 0 |
| SUP-09 | UPS | 5 | 0 | 0 | 0 |
| SUP-10 | CHRW | 4 | 0 | 0 | 0 |
| SUP-11 | JBHT | 4 | 0 | 5 | 2 |
| SUP-12 | XPO | 5 | 0 | 3 | 1 |
| SUP-13 | IP | 4 | 0 | 3 | 0 |
| SUP-14 | BALL | 5 | 0 | 4 | 2 |
| SUP-15 | SON | 7 | 0 | 3 | 0 |
| SUP-16 | PKG | 1 | 0 | 2 | 0 |
| SUP-17 | APH | 0 | 0 | 0 | 0 |
| SUP-18 | JBL | 3 | 0 | 3 | 2 |
| SUP-19 | SANM | 4 | 0 | 2 | 1 |
| SUP-20 | VSH | 4 | 0 | 3 | 0 |

## Every trouble event (rule arm)

| Supplier | Became public | Quarter | What | Tripwire set from | Caught early | Fired on |
|---|---|---|---|---|---|---|
| SUP-02 | 2023-05-25 | 2023Q2 | covenant-level break for period 2023-03-31: current ratio 0.9842 | 2023-03-31 | no |  |
| SUP-02 | 2024-02-01 | 2024Q1 | covenant-level break for period 2023-12-31: current ratio 0.9777 | 2023-09-30 | no |  |
| SUP-02 | 2024-11-05 | 2024Q4 | covenant-level break for period 2024-09-30: current ratio 0.8843 | 2024-09-30 | no |  |
| SUP-02 | 2024-11-20 | 2024Q4 | 8-K item 5.02 (CEO/CFO leaving) | 2024-09-30 | yes (0 q) | current_ratio 0.884 vs 1 on 2024-11-05 |
| SUP-03 | 2022-09-19 | 2022Q3 | 8-K item 2.06 | 2022-03-31 | no |  |
| SUP-03 | 2023-09-14 | 2023Q3 | 8-K item 5.02 (CEO/CFO leaving) | 2023-03-31 | yes (1 q) | risk_events_12m 2 vs 1 on 2023-06-26 |
| SUP-03 | 2025-03-18 | 2025Q1 | 8-K item 2.06 | 2024-09-30 | yes (0 q) | risk_events_12m 1 vs 0 on 2025-02-25 |
| SUP-03 | 2025-11-17 | 2025Q4 | 8-K item 2.06 | 2025-09-30 | no |  |
| SUP-04 | 2021-12-08 | 2021Q4 | 8-K item 2.04 | 2021-09-30 | no |  |
| SUP-04 | 2023-08-23 | 2023Q3 | covenant-level break for period 2023-06-25: liabilities to equity 3.0611 | 2023-03-31 | yes (1 q) | risk_events_12m 1 vs 0 on 2023-06-26 |
| SUP-04 | 2025-05-28 | 2025Q2 | 8-K item 5.02 (CEO/CFO leaving) | 2025-03-31 | no |  |
| SUP-04 | 2025-07-01 | 2025Q3 | 8-K item 1.03, 2.04 | 2025-03-31 | no |  |
| SUP-04 | 2025-09-10 | 2025Q3 | 8-K item 1.03 | 2025-03-31 | yes (0 q) | risk_events_12m 2 vs 1 on 2025-07-01 |
| SUP-04 | 2025-09-30 | 2025Q3 | 8-K item 1.03 | 2025-03-31 | yes (0 q) | risk_events_12m 2 vs 1 on 2025-07-01 |
| SUP-05 | 2025-07-07 | 2025Q3 | 8-K item 2.06 | 2025-03-31 | no |  |
| SUP-06 | 2022-11-04 | 2022Q4 | covenant-level break for period 2022-09-30: liabilities to equity 3.3105 | 2022-09-30 | no |  |
| SUP-06 | 2024-12-09 | 2024Q4 | 8-K item 5.02 (CEO/CFO leaving) | 2024-09-30 | no |  |
| SUP-06 | 2025-02-21 | 2025Q1 | covenant-level break for period 2024-12-31: liabilities to equity 3.4168 | 2024-09-30 | no |  |
| SUP-06 | 2026-01-06 | 2026Q1 | 8-K item 5.02 (CEO/CFO leaving) | 2025-09-30 | yes (1 q) | risk_events_12m 2 vs 1 on 2025-10-28 |
| SUP-07 | 2021-04-05 | 2021Q2 | 8-K item 5.02 (CEO/CFO leaving) | 2021-03-31 | no |  |
| SUP-08 | 2021-12-07 | 2021Q4 | 8-K item 5.02 (CEO/CFO leaving) | 2021-09-30 | no |  |
| SUP-09 | 2022-05-10 | 2022Q2 | 8-K item 5.02 (CEO/CFO leaving) | 2022-03-31 | no |  |
| SUP-09 | 2024-02-20 | 2024Q1 | covenant-level break for period 2023-12-31: liabilities to equity 3.0944 | 2023-09-30 | no |  |
| SUP-09 | 2024-05-06 | 2024Q2 | 8-K item 5.02 (CEO/CFO leaving) | 2024-03-31 | no |  |
| SUP-09 | 2024-08-07 | 2024Q3 | covenant-level break for period 2024-06-30: liabilities to equity 3.0762 | 2024-03-31 | no |  |
| SUP-09 | 2025-06-02 | 2025Q2 | 8-K item 5.02 (CEO/CFO leaving) | 2025-03-31 | no |  |
| SUP-10 | 2022-11-04 | 2022Q4 | covenant-level break for period 2022-09-30: liabilities to equity 3.0508 | 2022-09-30 | no |  |
| SUP-10 | 2023-01-03 | 2023Q1 | 8-K item 5.02 (CEO/CFO leaving) | 2022-09-30 | no |  |
| SUP-10 | 2023-12-21 | 2023Q4 | 8-K item 5.02 (CEO/CFO leaving) | 2023-09-30 | no |  |
| SUP-10 | 2024-05-13 | 2024Q2 | 8-K item 5.02 (CEO/CFO leaving) | 2024-03-31 | no |  |
| SUP-11 | 2021-06-28 | 2021Q2 | 8-K item 4.01 | 2021-03-31 | no |  |
| SUP-11 | 2024-02-29 | 2024Q1 | 8-K item 5.02 (CEO/CFO leaving) | 2023-09-30 | no |  |
| SUP-11 | 2024-10-25 | 2024Q4 | covenant-level break for period 2024-09-30: current ratio 0.9436 | 2024-09-30 | no |  |
| SUP-11 | 2025-04-25 | 2025Q2 | covenant-level break for period 2025-03-31: current ratio 0.8913 | 2025-03-31 | no |  |
| SUP-12 | 2021-07-28 | 2021Q3 | 8-K item 5.02 (CEO/CFO leaving) | 2021-03-31 | no |  |
| SUP-12 | 2022-04-11 | 2022Q2 | 8-K item 2.04 | 2022-03-31 | no |  |
| SUP-12 | 2023-01-25 | 2023Q1 | 8-K item 5.02 (CEO/CFO leaving) | 2022-09-30 | no |  |
| SUP-12 | 2023-03-09 | 2023Q1 | 8-K item 5.02 (CEO/CFO leaving) | 2022-09-30 | no |  |
| SUP-12 | 2023-07-19 | 2023Q3 | 8-K item 5.02 (CEO/CFO leaving) | 2023-03-31 | no |  |
| SUP-13 | 2023-10-18 | 2023Q4 | 8-K item 2.06 | 2023-09-30 | no |  |
| SUP-13 | 2025-02-13 | 2025Q1 | 8-K item 2.06 | 2024-09-30 | no |  |
| SUP-13 | 2025-08-21 | 2025Q3 | 8-K item 2.06 | 2025-03-31 | no |  |
| SUP-13 | 2025-08-21 | 2025Q3 | 8-K item 2.06 | 2025-03-31 | no |  |
| SUP-14 | 2022-01-27 | 2022Q1 | 8-K item 5.02 (CEO/CFO leaving) | 2021-09-30 | no |  |
| SUP-14 | 2023-09-11 | 2023Q3 | 8-K item 5.02 (CEO/CFO leaving) | 2023-03-31 | no |  |
| SUP-14 | 2025-02-20 | 2025Q1 | covenant-level break for period 2024-12-31: current ratio 0.9988 | 2024-09-30 | no |  |
| SUP-14 | 2025-05-22 | 2025Q2 | 8-K item 5.02 (CEO/CFO leaving) | 2025-03-31 | no |  |
| SUP-14 | 2025-08-05 | 2025Q3 | covenant-level break for period 2025-06-30: current ratio 0.9987 | 2025-03-31 | no |  |
| SUP-15 | 2022-02-11 | 2022Q1 | 8-K item 5.02 (CEO/CFO leaving) | 2021-09-30 | no |  |
| SUP-15 | 2022-05-25 | 2022Q2 | 8-K item 5.02 (CEO/CFO leaving) | 2022-03-31 | no |  |
| SUP-15 | 2022-06-16 | 2022Q2 | 8-K item 5.02 (CEO/CFO leaving) | 2022-03-31 | no |  |
| SUP-15 | 2022-10-24 | 2022Q4 | 8-K item 5.02 (CEO/CFO leaving) | 2022-09-30 | no |  |
| SUP-15 | 2025-01-06 | 2025Q1 | 8-K item 5.02 (CEO/CFO leaving) | 2024-09-30 | no |  |
| SUP-15 | 2025-02-28 | 2025Q1 | covenant-level break for period 2024-12-31: current ratio 0.7871 | 2024-09-30 | no |  |
| SUP-15 | 2025-10-29 | 2025Q4 | covenant-level break for period 2025-09-28: current ratio 0.9229 | 2025-09-30 | no |  |
| SUP-16 | 2025-12-04 | 2025Q4 | 8-K item 2.06 | 2025-09-30 | no |  |
| SUP-18 | 2022-11-09 | 2022Q4 | 8-K item 5.02 (CEO/CFO leaving) | 2022-09-30 | no |  |
| SUP-18 | 2023-08-15 | 2023Q3 | 8-K item 5.02 (CEO/CFO leaving) | 2023-03-31 | no |  |
| SUP-18 | 2024-05-20 | 2024Q2 | 8-K item 5.02 (CEO/CFO leaving) | 2024-03-31 | no |  |
| SUP-19 | 2021-12-10 | 2021Q4 | 8-K item 5.02 (CEO/CFO leaving) | 2021-09-30 | no |  |
| SUP-19 | 2023-05-11 | 2023Q2 | 8-K item 4.02 | 2023-03-31 | no |  |
| SUP-19 | 2023-12-07 | 2023Q4 | 8-K item 5.02 (CEO/CFO leaving) | 2023-09-30 | no |  |
| SUP-19 | 2023-12-19 | 2023Q4 | 8-K item 5.02 (CEO/CFO leaving) | 2023-09-30 | no |  |
| SUP-20 | 2022-02-22 | 2022Q1 | 8-K item 5.02 (CEO/CFO leaving) | 2021-09-30 | no |  |
| SUP-20 | 2024-02-29 | 2024Q1 | 8-K item 5.02 (CEO/CFO leaving) | 2023-09-30 | no |  |
| SUP-20 | 2025-02-05 | 2025Q1 | 8-K item 2.06 | 2024-09-30 | no |  |
| SUP-20 | 2026-01-09 | 2026Q1 | 8-K item 4.01 | 2025-09-30 | no |  |

## Model arms: live-recording budget

All 200 decisions: about 4000 model calls (20 per decision), roughly 200 minutes at the recorded mean latency. This is a cost estimate, not a result.
Run on the Windows PC with Nightshift: `npx tsx scripts/backtest.ts --record --max-cases 40`, then commit `data/backtest/recordings.jsonl`; anyone can then run `--replay`.
