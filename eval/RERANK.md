# Rerank: does the evidence the question is about come first?

Generated 2026-10-25 12:51 UTC by `npx tsx scripts/eval_rerank.ts --write`: 17 questions from [rerank_gold.json](rerank_gold.json) x 2 suppliers (34 rankings of the Analyst's findings).
Rerank: replay of a live run of nvidia/nemotron-3.5-rerank-8b recorded 2026-10-25.

| Ranking | hit@1 | recall@3 | MRR | n |
|---|---|---|---|---|
| Keyword overlap (baseline) | 0.23 | 0.35 | 0.44 | 34 |
| Nemotron rerank | 1.00 | 0.97 | 1.00 | 34 |

hit@1: the top finding answers the question. recall@3: share of the relevant findings in the top three. MRR: 1 / rank of the first relevant finding, averaged.

## Per question

| Question | Supplier | Relevant | Keyword top 3 | Rerank top 3 |
|---|---|---|---|---|
| q01 | SUP-05 | current_ratio | risk_events_12m, spend_share, lead_time_weeks | current_ratio, debt_to_equity, revenue_change_pct |
| q01 | SUP-08 | current_ratio | risk_events_12m, spend_share, lead_time_weeks | current_ratio, debt_to_equity, gross_margin |
| q02 | SUP-05 | debt_to_equity | spend_share, lead_time_weeks, current_ratio | debt_to_equity, current_ratio, gross_margin |
| q02 | SUP-08 | debt_to_equity | spend_share, lead_time_weeks, current_ratio | debt_to_equity, current_ratio, gross_margin |
| q03 | SUP-05 | gross_margin | spend_share, lead_time_weeks, current_ratio | gross_margin, revenue_change_pct, category_alternatives |
| q03 | SUP-08 | gross_margin | spend_share, lead_time_weeks, current_ratio | gross_margin, revenue_change_pct, category_alternatives |
| q04 | SUP-05 | revenue_change_pct | spend_share, lead_time_weeks, current_ratio | revenue_change_pct, gross_margin, debt_to_equity |
| q04 | SUP-08 | revenue_change_pct | spend_share, lead_time_weeks, current_ratio | revenue_change_pct, gross_margin, debt_to_equity |
| q05 | SUP-05 | spend_share, category_alternatives | spend_share, lead_time_weeks, current_ratio | spend_share, category_alternatives, lead_time_weeks |
| q05 | SUP-08 | spend_share, category_alternatives | spend_share, lead_time_weeks, current_ratio | spend_share, category_alternatives, lead_time_weeks |
| q06 | SUP-05 | category_alternatives, lead_time_weeks | spend_share, lead_time_weeks, current_ratio | category_alternatives, lead_time_weeks, spend_share |
| q06 | SUP-08 | category_alternatives, lead_time_weeks | spend_share, lead_time_weeks, current_ratio | category_alternatives, lead_time_weeks, spend_share |
| q07 | SUP-05 | lead_time_weeks | spend_share, lead_time_weeks, current_ratio | lead_time_weeks, category_alternatives, spend_share |
| q07 | SUP-08 | lead_time_weeks | spend_share, lead_time_weeks, current_ratio | lead_time_weeks, category_alternatives, spend_share |
| q08 | SUP-05 | sanctions_matches, risk_events_12m | spend_share, lead_time_weeks, current_ratio | sanctions_matches, risk_events_12m, revenue_change_pct |
| q08 | SUP-08 | sanctions_matches, risk_events_12m | spend_share, lead_time_weeks, current_ratio | sanctions_matches, risk_events_12m, revenue_change_pct |
| q09 | SUP-05 | risk_events_12m | risk_events_12m, spend_share, lead_time_weeks | risk_events_12m, revenue_change_pct, lead_time_weeks |
| q09 | SUP-08 | risk_events_12m | risk_events_12m, spend_share, lead_time_weeks | risk_events_12m, revenue_change_pct, lead_time_weeks |
| q10 | SUP-05 | sanctions_matches | spend_share, lead_time_weeks, current_ratio | sanctions_matches, category_alternatives, debt_to_equity |
| q10 | SUP-08 | sanctions_matches | spend_share, lead_time_weeks, current_ratio | sanctions_matches, category_alternatives, debt_to_equity |
| q11 | SUP-05 | current_ratio, debt_to_equity, gross_margin, revenue_change_pct | category_alternatives, spend_share, lead_time_weeks | current_ratio, category_alternatives, debt_to_equity |
| q11 | SUP-08 | current_ratio, debt_to_equity, gross_margin, revenue_change_pct | category_alternatives, spend_share, lead_time_weeks | current_ratio, category_alternatives, debt_to_equity |
| q12 | SUP-05 | revenue_change_pct | revenue_change_pct, spend_share, lead_time_weeks | revenue_change_pct, gross_margin, spend_share |
| q12 | SUP-08 | revenue_change_pct | revenue_change_pct, spend_share, lead_time_weeks | revenue_change_pct, gross_margin, spend_share |
| q13 | SUP-05 | category_alternatives | spend_share, lead_time_weeks, current_ratio | category_alternatives, spend_share, lead_time_weeks |
| q13 | SUP-08 | category_alternatives | spend_share, lead_time_weeks, current_ratio | category_alternatives, spend_share, lead_time_weeks |
| q14 | SUP-05 | spend_share | spend_share, category_alternatives, lead_time_weeks | spend_share, category_alternatives, gross_margin |
| q14 | SUP-08 | spend_share | spend_share, category_alternatives, lead_time_weeks | spend_share, category_alternatives, gross_margin |
| q15 | SUP-05 | current_ratio, debt_to_equity, risk_events_12m | spend_share, lead_time_weeks, current_ratio | debt_to_equity, current_ratio, revenue_change_pct |
| q15 | SUP-08 | current_ratio, debt_to_equity, risk_events_12m | spend_share, lead_time_weeks, current_ratio | debt_to_equity, current_ratio, risk_events_12m |
| q16 | SUP-05 | sanctions_matches | spend_share, lead_time_weeks, current_ratio | sanctions_matches, category_alternatives, lead_time_weeks |
| q16 | SUP-08 | sanctions_matches | spend_share, lead_time_weeks, current_ratio | sanctions_matches, category_alternatives, lead_time_weeks |
| q17 | SUP-05 | lead_time_weeks, category_alternatives, spend_share | risk_events_12m, category_alternatives, spend_share | lead_time_weeks, category_alternatives, spend_share |
| q17 | SUP-08 | lead_time_weeks, category_alternatives, spend_share | risk_events_12m, category_alternatives, spend_share | category_alternatives, lead_time_weeks, spend_share |
