# Proving Ground stage 1: Read

## Integration requests
1. **`.gitignore`**: `data/cache/` hides the committed filing cache from `git status`. I force-added `data/cache/filings/**` (`git add -f`), so the files are tracked and a fresh clone has them. To make this explicit, replace the line `data/cache/` with:
   ```
   data/cache/*
   !data/cache/filings/
   ```
2. No change to `app/types.ts`, the graph or any agent prompt is needed. The stage keeps the stub's signature `readFilings(deps, s)`.
3. Trace names follow the shared labels: agent `FilingReader`, action `read_filings`.

## What it does, in plain words
An 8-K is the report a US-listed company must file when something material happens: a plant closure, a CEO leaving, a merger, an impairment (writing down the value of assets). Stage 1 reads each supplier's real 8-Ks rather than relying on a summary of them.

- **Offline, once** (`scripts/parse_filings.ts`, run here on Linux, with `NVIDIA_API_KEY` in the environment):
  - For each of the 20 sample suppliers, it takes up to 4 recent 8-Ks from `data/sample/supplier_events.csv`, the list built from EDGAR's submission records. Filings with a material-risk item (the same `RISK_ITEMS` behind `risk_events_12m`) come first, then other non-routine ones, newest first.
  - It fetches the real document from EDGAR (with the same User-Agent as `fetch_edgar.ts`) and prints it to PDF with headless Chrome.
  - `pdftotext` is used only to find the page where the "Item x.xx" sections start. That page and the next one go to Nemotron Parse as images.
  - **Nemotron Parse** (`nvidia/nemotron-parse`, build.nvidia.com) reads the page images into text. The text kept is Parse's.
  - **Nemotron 3.5 Lightning** (`nvidia/nemotron-3.5-lightning-30b-a3b`, same endpoint, thinking off, temperature 0) turns the parsed text into a one-sentence headline and a severity. This is a model judgment and is labelled as such.
  - Each filing is cached as `data/cache/filings/parsed/<accession>.json`, holding the parsed text and `text_hash` (the SHA-256 of that text). All events are also collected in `data/cache/filings/index.json`.
- **Every decision run** (`app/proving/filings.ts`): loads that supplier's cached events into `proving.filings`, most severe first, and writes one trace event: "N 8-K filings read by nvidia/nemotron-parse on build.nvidia.com (offline, date; served from cache)".
  - No key and no model call at run time, so offline and sample mode show the stage.
  - It does **not** add findings or touch any agent prompt, so the 107 recorded live answers still replay.
  - The pre-mortem can cite events by `id` (`8k-<accession>`).
  - If there is no cache, or nothing for a supplier, the stage writes a plain reason into `proving.skipped`.
- **Console** (`console/src/proving/ReadStage.tsx`): shows "N filings read by Nemotron Parse", plus the 3 most severe headlines with their date and a link to the EDGAR document.

## Measured results (run of 2026-10-27)
| | |
|---|---|
| Suppliers covered | 20 of 20 |
| 8-K filings read | 80 (4 per supplier), filed 2025-10-28 to 2026-10-22 |
| Nemotron Parse calls | 155 page images (1 to 2 per filing) |
| Lightning calls | 80 (one per filing) |
| Parse time | 572 s in total, about 3.7 s per page including rendering |
| Failures | 0 |
| Severity, as rated by Lightning | 1 high, 14 medium, 65 low |
| Cache size | 508 KB |

**Cross-check against EDGAR's item metadata** (the data behind `risk_events_12m`):
- Parse's reading agrees on whether a filing contains a material-risk item for **80 of 80** filings. 7 of the 80 have such an item, and Parse found all 7, with no false positives.
- Parse found **151 of 165** (92%) of the items EDGAR lists, and the exact item set for 70 of 80 filings. All 14 misses are on pages that were not read (the read is capped at 2 pages). In every case the miss is an exhibits item (9.01) or a trailing 7.01/8.01, never a risk item.

**Honest caveats:**
- Lightning's severity is a judgment, not a rule. For example, it rated a shareholder vote approving the Huntsman–Olin merger "high", but ON Semiconductor's $200–300M impairment only "medium". Treat severity as a hint for ordering.
- The items and the risk flag above come from Parse's text, not from the model.
- The filings were read once, offline, on 2026-10-27. The run-time trace says so ("served from cache"). It is never presented as a live call.

## Model-call budget for the live recording
None. Stage 1 makes no model calls at run time; Nemotron Parse and Lightning ran offline and are cached.

Re-running `scripts/parse_filings.ts --refresh` makes about 235 calls to build.nvidia.com (155 Parse + 80 Lightning) and takes about 15 minutes. Without `--refresh`, cached filings are reused and nothing is called.

## Files
`scripts/parse_filings.ts`, `app/proving/filings.ts`, `data/cache/filings/**`, `console/src/proving/ReadStage.tsx` (plus a `.pg-read-*` block at the end of `console/src/console.css`), `test/proving_read.test.ts` (9 tests).
