# Vendored: Meterless H-MEM reference implementation

- **Source:** https://github.com/Meterless/Meterless, path `engines/hmem/reference`
- **Commit:** `1742dec56a66e58eef9dda2d2b865823758ca8cd` (committed 2026-10-19T10:55:26-07:00)
- **Copied:** 2026-10-22 (UTC), from a shallow clone of the default branch
- **Licence:** Apache-2.0 (the Meterless repo's `LICENSE`, copied here as `LICENSE`). The upstream `package.json` also declares `"license": "Apache-2.0"`.

This is the same copy that Meterless's own `templates/agentathon-starter` makes with `npm run setup` (degit into `vendor/hmem`). We commit it instead of fetching it at setup time, so a fresh clone runs keyless and offline.

## What was copied

| Here | Upstream |
|---|---|
| `src/*.ts` | `engines/hmem/reference/src/*.ts` (all 10 files) |
| `test/smoke.test.ts` | `engines/hmem/reference/test/smoke.test.ts` |
| `UPSTREAM-README.md` | `engines/hmem/reference/README.md` |
| `LICENSE` | repo root `LICENSE` |

## Modifications (Apache-2.0 §4b notice)

One mechanical change only: relative imports were rewritten from `./x.ts` to `./x.js`, so the code compiles under Tripwire's `tsconfig.json` (NodeNext, emitting) without `allowImportingTsExtensions`. Command used:

```bash
sed -i -E 's/(from "\.\.?\/[^"]+)\.ts"/\1.js"/g' vendor/hmem/src/*.ts vendor/hmem/test/*.ts
```

No logic was changed. Tripwire's integration lives in `app/adapters/hmem.ts`, outside this folder.

## Upstream's own caveats (kept honest)

Upstream says this is "NOT a production library": the embedder is a deterministic hash mock (64-dim FNV-1a, no model download), and persistence is a JSON file plus an append-only `ledger.jsonl`. Tripwire relies on it for lineage (`derivedFrom`), supersession, retrieval ranking and the audit ledger, not for semantic search quality.
