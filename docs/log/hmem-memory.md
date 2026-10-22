# hmem-memory stream log

## 2026-10-22

### Vendored engine
- Shallow-cloned `https://github.com/Meterless/Meterless` (HEAD `1742dec56a66e58eef9dda2d2b865823758ca8cd`, committed 2026-10-19) into the session scratch area, not the repo.
- Licence: **Apache-2.0** (repo `LICENSE`; the reference's `package.json` says the same). Vendoring is allowed with the licence and a change notice, so it is committed in `vendor/hmem/` (no git/npm dependency needed).
- Copied `engines/hmem/reference/src/*.ts` (10 files), its `test/smoke.test.ts`, its README (as `UPSTREAM-README.md`) and `LICENSE`. Details and the one modification are in `vendor/hmem/README.md`.
- Modification: relative imports `./x.ts` → `./x.js` (one `sed`), so it compiles under our NodeNext + emit `tsconfig.json`. No logic changed.
- This mirrors Meterless's own `templates/agentathon-starter`, whose `npm run setup` degits the same folder into `vendor/hmem`; we commit it so a fresh clone works keyless and offline.
- Upstream smoke test runs inside our suite: 10/10 pass.
- Embeddings: the reference only has a deterministic 64-dim FNV-1a hash embedder. No model download, nothing heavy. Do not claim semantic retrieval quality.

### Adapter `app/adapters/hmem.ts`
Real H-MEM API used: `new HMEM({clock, persistDir, actor})`, `hmem.add`, `hmem.query`, `hmem.feedback`, `store.get/all/update`, `ledger.history/stats`.

- **remember** → one `hmem.add` record. Lineage goes into H-MEM's own `derivedFrom` field as `row:<table>/<key>#<result_hash>` (URI-encoded parts), also in `provenance.refs`. `chatId = subject_id`; tags `subject:`, `decision:`, `metric:`, `value:<json>`. H-MEM's `state.json` is the only store, so no side files can drift.
- **recall(subject, query, limit)** → `hmem.query(query, {chatId: subject})` (H-MEM hybrid ranking; each hit gets a `read` ledger entry). Superseded claims are filtered out. Threshold 0.05 instead of H-MEM's 0.35 (hash embedder scores short numeric claims low; configurable via `recallThreshold`).
- **dependentsOf(row)** → exact scan of `store.all()` over parsed `derivedFrom` refs (H-MEM has no reverse index). Skips superseded claims. Returns sorted unique decision ids. Fine at portfolio scale (20 decisions).
- **supersede(old, new)** → new record with `supersedes: old`, then `store.update(old, {supersededBy: new})` (H-MEM only sets `supersededBy` via conflict resolution, so we do it; it is logged as an `update` in the ledger). Throws on unknown or already-superseded ids.
- H-MEM auto-sets `supersedes` when text contains words like "actually"/"instead" and is similar to any record (even another subject's). Tripwire supersession must be explicit, so the adapter undoes an automatic link right after `add` (visible as an `update` ledger entry). Verified it fires and is undone.
- Extras: `get`, `supersededBy`, `chain`, `claimsForDecision`, `flagWrong` (= `hmem.feedback(id,"wrong")`: confidence -0.20, "review" tag), `history`, `ledgerStats`.
- **checkStale(claim, current)** → `{stale, changed[], unverified[]}`. `current` is a function, `Map`, or object keyed by `rowKey(row)`. Rows with no current hash are `unverified`, not stale.
- **callHmem(agent, action, fn)** → never throws; returns `{ok, value|error, latency_ms, event}` where `event` is a ready `sponsor_call` trace event with `sponsor: "meterless-hmem"` and status `success`/`failed`. The caller does `tracer.emit(r.event)` and picks the fallback.
- Persistence: `persistDir` defaults to `process.env.HMEM_DIR ?? "data/memory"` (H-MEM writes `state.json` + `ledger.jsonl` there). `persistDir: null` = in-memory (tests). Added `data/memory/` to `.gitignore`.

### Tests `test/hmem.test.ts` (19, all pass)
- Lineage round-trip; 20-decision portfolio where one shared `supplier_financials/parent-acme` row → exactly `dec-03, dec-11, dec-17`; single-row and unknown-row cases; supersede chain and errors; stale detection (3 lookup forms); subject-scoped recall; persistence round-trip on a temp dir (claims, dependents, supersededBy, ledger history); `callHmem` success/failure events; `flagWrong` feedback.
- Hand-written edge cases: superseded decision id leaves `dependentsOf`; keys with `/`, `#`, spaces; auto-supersede undo.

### Cursor CLI
- `scripts/memguard.sh -- agent -p --force --model composer-2.5 "Write test/hmem.test.ts (vitest ...) for app/adapters/hmem.ts ... Cover: (1) lineage ... (2) 20-decision portfolio, shared row -> exactly dec-03/dec-11/dec-17 ... (8) flagWrong ..."` (Cursor Agent 2026.10.19).
- Cursor wrote the first 16 tests in `test/hmem.test.ts` and ran them (16/16). Claude reviewed them, then added 3 edge-case tests. Commit `2f94801`.

### Commands run
- `scripts/memguard.sh -- npm ci`
- `scripts/memguard.sh -- npm test` → 4 files, 35 tests pass (scaffold 6, vendor smoke 10, hmem 19)
- `scripts/memguard.sh -- npm run typecheck` → clean

## Contract requests (for the integrator; `app/types.ts` not edited)
1. Add `superseded_by?: string` to `MemoryClaim`, so callers can see supersession without the adapter's `supersededBy()` extra.
2. Consider `MemoryStore.claimsForDecision(decision_id)` in the interface: the reopen flow needs a decision's claims to supersede them; today it is an adapter extra.
3. Optional: `confidence?: number` on `MemoryClaim` (H-MEM tracks it; `flagWrong` lowers it).

## Notes for the integrator
- Wiring: `const memory = createMemoryStore()` once per server process (it loads `data/memory/` on start). Wrap calls: `const r = await callHmem("memory_keeper", "remember", () => memory.remember(c)); tracer.emit(r.event); if (!r.ok) { /* fallback */ }`.
- `dependentsOf` matches on row only (table + key), ignoring the hash: any change to a row reopens every current decision that used it. Use `checkStale` with the new hash to explain *what* changed.
- The adapter is synchronous inside (H-MEM is in-process, file writes are sync). One `HmemMemoryStore` per directory; two processes on the same `data/memory/` would overwrite each other's `state.json`.
