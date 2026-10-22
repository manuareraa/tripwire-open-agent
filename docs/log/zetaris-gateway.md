# zetaris-gateway stream log

## 2026-10-22: write-back spike (day-1 risk) — PROVEN

Local Zetaris bundle (2.4.3.1 driver jar), started with `ZSPARK_DRIVER_MEM=3g ZETARIS_API_MAX_HEAP=1g docker compose up -d` at MemAvailable 8.7 GB; `./verify.sh` 9/9 PASS.

**Endpoint.** `POST http://localhost:3000/api/proxy/sql-editor/sqls/run-query`, body `{"sql": "<one statement>", "limit": n}`, headers `Authorization: Bearer <idToken>`, `X-Org-ID`, UUID `X-Request-ID`. Login: `POST /api/auth/login {"username","password"}` returns `idToken` and `orgId`. Found in the public `zetaris/getting-started` repo (`scripts/query_zetaris.ts`). Unlike `/api/proxy/query/sql/start` (SELECT only), this endpoint takes DDL, SHOW and RUN EXPORT. Response: `{"headers":[...],"data":[[...]],"total":n,"timeUsed":ms}`; every value is a string. Calls back to back took ~300 ms each with no throttling, so no 15 s gap is needed against the local instance (the 15 s rule is for rate-limited REST *sources* like EDGAR).

Credentials: admin email/password read from the bundle's `.env` into the process env inside a wrapper script; never printed or copied. Below, tokens are omitted.

### Statements and responses, in order

| # | Statement | Response |
|---|---|---|
| 1 | `SELECT 1 AS one` | `headers ["one"], data [["1"]]` |
| 2 | `SHOW LIGHTNING DATABASES` | `NY_TAXI`, `TPCDS_DB` |
| 3 | `CREATE LIGHTNING DATABASE tripwire DESCRIBE BY "Tripwire supplier decisions"` | `headers ["Result"], data []` (ok) |
| 4 | `RUN EXPORT TO STORAGE (query = 'SELECT ''DEC-TEST-0001'' AS decision_id, …', …)` | **HTTP 400** `LightningCatalogParserException: mismatched input ''DEC-TEST-0001'' expecting {')', ','}`: doubled single quotes are not accepted inside `query = '…'` |
| 5 | same with `"…"` literals inside the query, `path = '/home/zetaris/customer-data/shared/tripwire/tripwire_decisions', format = 'parquet', saveMode = 'append'` | `path …, status SUCCESS`; a `part-00000-….snappy.parquet` appears in the driver's `customer-data` volume |
| 6 | `CREATE LIGHTNING FILESTORE TABLE tripwire_decisions FROM tripwire FORMAT PARQUET OPTIONS (path "/home/zetaris/customer-data/shared/tripwire/tripwire_decisions")` | ok |
| 7 | `SELECT * FROM tripwire.tripwire_decisions` | 1 row: `DEC-TEST-0001, SUP-01, keep, 0.8, approved, [], [], "", 2026-10-22T15:00:00Z, spike test` |
| 8 | second append, string values as `CAST(unbase64("<b64>") AS STRING)`, `0.55` literal | export SUCCESS, but the SELECT failed: `Parquet column cannot be converted … Column: [confidence]`: the literal `0.8` in #5 was written as DECIMAL(1,1), `0.55` as DECIMAL(2,2) |
| 9 | removed my two spike files; re-appended both rows with explicit `CAST(x AS DOUBLE)`; `DROP LIGHTNING DATABASE TABLE tripwire.tripwire_decisions`; re-`CREATE … FILESTORE TABLE` (the table keeps the schema inferred at registration) | `SELECT …` returns **2 rows**, JSON (`[{"id":"tw1","op":"<"}]`) and an apostrophe (`it's quoted`) intact |
| 10 | `SELECT COUNT(*) AS n FROM tripwire.tripwire_decisions` ×5 back to back | `2` each time, 279–724 ms |

**Conclusion.** Zetaris has no row-level INSERT/UPDATE, but **append + read-back through Zetaris SQL works**: `RUN EXPORT TO STORAGE … format 'parquet', saveMode 'append'` adds a Parquet file under the table's path, and the filestore table sees new files on the next SELECT without re-registration. Fallbacks A/B/C were not needed.

Rules learned (all built into the code):
- Every column is cast explicitly (`CAST(… AS DOUBLE)` / base64 strings) so every appended file has the same Parquet schema.
- Strings go in as `CAST(unbase64("…") AS STRING)`: avoids the quote problem and makes SQL injection through decision text impossible.
- A table's schema is fixed when it is registered; to change it, drop and re-register.
- A typed empty result (`SELECT CAST(NULL AS STRING) AS … WHERE 1 = 0`) exported with `overwrite` writes a schema-only Parquet file, so the ledger table can be registered before any decision exists.
- Editing a source row = export the table again with `overwrite` (rows as literals, so Spark never overwrites a path it is reading), then drop + re-register.

Honest claim language: "approved decisions are appended to a Parquet ledger through Zetaris `RUN EXPORT` and read back with Zetaris SQL". Not "UPDATE rows in Zetaris".

### End to end through the gateway (real EDGAR sample from the data-samples branch)

`tsx scripts/zetaris_setup.ts init --data <data-samples worktree>/data/sample --reset-ledger`:
`tripwire.supplier_financials: 119 rows`, `tripwire.supplier_spend: 20 rows`, `tripwire.tripwire_decisions: 0 rows` (all seeded through RUN EXPORT in chunks of 25 rows, then registered).

Gateway calls (scratch script, not committed):
- `health()` → `{ok: true}`; `supplier_spend_row`, `supplier_financials_latest`, `supplier_financials_history`, `category_concentration` all return typed rows, `result_hash`, `depends_on`, `period`.
- `writeDecision(DEC-E2E-0001, approved)` → `{written: true, method: "zetaris:run_export_append_parquet", detail: "appended to …/tripwire_decisions; read back 1 row via tripwire.tripwire_decisions"}`; a second write with status `superseded` also read back. `decisions_for_supplier` shows both ledger rows; `readDecisions()` returns one decision with status `superseded`, `approved_by_reason` with quotes intact.
- `changesSince("")` → `{changes: [], marker: "2026-10-01T09:00:00Z"}`. Then `zetaris_setup.ts apply changes/02_spend_share_jump.json` (replaced SUP-06) and `apply changes/01_new_quarter.json` (appended a VSH filing). `changesSince(marker)` → `[{supplier_spend, SUP-06}, {supplier_financials, 103730}]`, marker `2026-10-23T10:00:00Z`; next call → no changes. SUP-06 `spend_share` 0.35 → 0.58; VSH latest period 2026-04-04 → 2026-07-04, with a new `result_hash`.
- One transient `fetch failed` happened on the first poll after the `apply` subprocess (no container restart, no OOM): most likely a stale keep-alive socket to the UI server. Reads (SELECT/SHOW) are now retried once on network errors; writes are never retried, so an append cannot land twice.

After the tests, the tables were re-seeded with `init --reset-ledger` (base data, empty ledger) and Zetaris was stopped.

## What the adapter does (`app/adapters/zetaris.ts`)
- `ZetarisClient`: login (password or `ZETARIS_API_KEY` + `ZETARIS_ORG_ID`), one statement per call, timeout via `AbortSignal.timeout(ZETARIS_TIMEOUT_MS)`, typed `ZetarisError` kinds `config | network | timeout | auth | http | sql`.
- `ZetarisGateway` (`name: "zetaris"`): `health`, `listTemplates`, `runTemplate` (template SQL with prefix `tripwire.`, DOUBLE columns typed back to numbers, `result_hash = canonicalHash(rows)`, `depends_on` from `ROW_KEY`), `writeDecision` (append + COUNT read-back; `written: true` only if the row reads back), `readDecisions` (latest ledger row per `decision_id` by `written_at`), `changesSince` (spend by `updated_at`, financials by per-CIK hash vs the previous call). Optional `tracer` emits a `sponsor_call` (sponsor `zetaris`) per SQL call.
- `app/sql/zetaris_tables.ts`: column types, RUN EXPORT / DDL builders, ledger and change queries.
- `scripts/zetaris_setup.ts`: `init [--data dir] [--reset-ledger]`, `apply <change.json>`, `status`. `scripts/zetaris_sql.ts`: run one statement and print the JSON.

## Contract requests (for the integrator)
1. **`canonicalHash(rows)`** is exported from `app/adapters/zetaris.ts`; please move it to a shared module (e.g. `app/hash.ts`) so `sample_data.ts` uses the identical function. Note: Zetaris returns strings, the adapter types DOUBLE columns back to numbers before hashing, so sample rows must use the same types (numbers for spend_share, lead_time_weeks, open_po_value, revenue, gross_margin, current_ratio, debt_to_equity; strings for cik, sic, dates) or hashes will differ between modes.
2. **`config.ts`**: add `ZETARIS_USERNAME` (password login; the local stack has no API key UI flow tested yet) and `ZETARIS_STORAGE_ROOT`. The adapter reads them from `process.env` directly for now. `config.sampleMode` already treats `ZETARIS_PASSWORD` as "live".
3. **Ledger schema**: `tripwire_decisions` has the BUILD-PACK columns plus `payload` (full Decision JSON, so `readDecisions` is lossless) and `written_at`. The ledger is append-only: superseding = writing the old decision again with status `superseded`. The `decisions_for_supplier` template therefore returns history (several rows per decision_id).
4. **`changesSince("")`** initialises (no changes, current marker). Financial-change detection is per gateway instance: the Watcher should keep one gateway instance alive.
5. Demo "edit a row" = `tsx scripts/zetaris_setup.ts apply data/sample/changes/<file>.json` (or import the same logic if core wants an endpoint; ask and I'll export it).

## Cursor CLI
`test/zetaris.test.ts` was written by the Cursor CLI (v2026.10.19), run non-interactively from this worktree:

```
scripts/memguard.sh -- agent -p --force --model composer-2.5 "<prompt>"
```

The prompt asked for mock-fetch vitest tests covering: login headers and request shape, runTemplate typing/evidence/result_hash, canonicalHash stability, invalid template params, writeDecision append + read-back (true and false paths), readDecisions latest-row logic, changesSince initialise + diffs, error kinds (auth, timeout), read retry vs no write retry, health; plus one live block skipped unless `ZETARIS_LIVE=1`. Cursor wrote the file and ran vitest itself (13 passed, 1 skipped). Claude then fixed two type errors that tsc reported (an invalid `Finding` literal; a handler call missing its second argument).

Final: `tsc --noEmit` clean; `vitest run` 19 passed, 1 skipped; with `ZETARIS_LIVE=1` against the local stack, the live test passed too (14/14 in the file).
