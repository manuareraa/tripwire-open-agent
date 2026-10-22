# data-samples stream log

## 2026-10-22
- Worktree `.claude/worktrees/data-samples-acc429`, branch `mcc/data-samples-acc429`, based on `scaffold` (b115880).
- `scripts/memguard.sh -- npm ci`.
- **`scripts/fetch_edgar.ts`** (Claude Code): resolves 20 tickers through `company_tickers.json`, then downloads companyfacts and submissions for each one. It derives quarterly revenue, gross margin, current ratio and liabilities-to-equity (method in `data/README.md`) and writes `data/sample/supplier_financials.csv`: 119 rows, 6 quarters per company, 5 for VSH. The User-Agent comes from `SEC_USER_AGENT`, defaulting to the demo contact; requests are spaced 220 ms apart (≤ 5/s); raw files go to `data/cache/` (gitignored, ~57 MB).
  - Ran `scripts/memguard.sh -- npx tsx scripts/fetch_edgar.ts` 3 times:
    - Sealed Air (SEE) is no longer in the SEC ticker list, so it was replaced with Sonoco (SON).
    - A sanity filter now drops Q4 periods where FY − YTD gave implausible numbers (SON Dec 2024 came out at $64M revenue / 441% margin).
    - Wolfspeed's fresh-start double balance date is deduplicated.
  - Vishay's latest real quarter (2026-07-04) is held back and written to `data/sample/changes/01_new_quarter.json`: a real filing to "arrive" in the demo.
- **`data/sample/supplier_spend.csv`**: synthetic, 20 rows, 5 categories. `spend_share` is the share within the category. Built so WOLF (SUP-04), JBL (SUP-18) and SON (SUP-15) stand out against their real financials.
- **Change files 02 and 03**: synthetic spend changes (SUP-06 share jump; SUP-12 lead time).
- **`app/adapters/sample_data.ts`** (Claude Code): `SampleDataGateway`.
  - Evaluates each template in JS and projects the columns parsed from the template SQL.
  - Hashes the result with SHA-256 over canonical JSON (keys sorted, rows sorted); `resultHash` and `canonicalRows` are exported.
  - Fills `depends_on` from `ROW_KEY`.
  - Keeps an append-only JSONL ledger, with `readDecisions` returning the latest entry per id.
  - `applyChange` / `changesSince` / `resetChanges` work on top of `data/ledger/applied_changes.jsonl`.
- `data/README.md` (provenance, licence, derivations) and `input_examples/` (3 `POST /run` bodies).
- **Cursor CLI** wrote the tests:
  `scripts/memguard.sh -- agent -p --force --model composer-2.5 "<write test/sample_data.test.ts covering templates, hash stability, change application, changesSince replay/reset, ledger, invalid params; use temp dirs; run vitest and fix until green>"`.
  Cursor wrote `test/sample_data.test.ts` (6 tests) and reported no adapter bugs. Claude reviewed it.
  - `scripts/memguard.sh -- npx vitest run` → 12/12 pass. `tsc --noEmit` is clean.
- Touched one shared file: `.gitignore` gets `data/ledger/` (runtime ledger must not be committed).

## Contract requests (for the integrator)
1. **Shared hash function.** Move `resultHash`/`canonicalRows` (now exported from `app/adapters/sample_data.ts`) into a shared module (e.g. `app/evidence.ts`). Then the Zetaris gateway and the Evidence Critic compute the same hash. Both gateways must also coerce values the same way: numeric columns as JSON numbers, empty cells as `null`, everything else as strings (`cik` is a string without leading zeros).
2. **`tripwire_decisions.supplier_id` = `Decision.subject_id`.** The ledger template uses `supplier_id`; `decisionToLedgerRow()` does the mapping and stores `tripwires`/`evidence` as JSON text. Worth a comment in `templates.ts`.
3. `ROW_KEY.supplier_financials = "cik"`, so a new quarter is reported as a change to key `<cik>`. That is right for reopen (the decision depends on the company), but `Evidence.depends_on` cannot point at one quarter. That is fine for now; `Evidence.period` carries the latest period.
4. `applyChange`, `listChangeFiles` and `resetChanges` are extras on `SampleDataGateway`, not part of `DataGateway`. If the demo needs a "simulate change" button in live mode too, add an optional `applyChange?` to the interface.
