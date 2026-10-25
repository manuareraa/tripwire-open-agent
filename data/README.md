# Tripwire sample data

SAMPLE_MODE (no keys) reads these files through `app/adapters/sample_data.ts`. The live mode loads the same tables into Zetaris.

| File | What it is | Real or synthetic |
|---|---|---|
| `sample/supplier_financials.csv` | Quarterly financials for 20 US-listed companies (6 quarters each; 5 for Vishay, see below) | **Real**, from SEC EDGAR |
| `sample/supplier_spend.csv` | Our (fictional) spend with each company: SUP-01..SUP-20 | **Synthetic** |
| `sample/changes/01_new_quarter.json` | Vishay's quarter ended 2026-07-04 | **Real** (held back from the CSV) |
| `sample/changes/02_spend_share_jump.json` | SUP-06 share of chemicals spend 0.35 → 0.58 | **Synthetic** |
| `sample/changes/03_lead_time_slip.json` | SUP-12 lead time 3 → 9 weeks | **Synthetic** |
| `cache/` | Raw SEC downloads (gitignored) | |
| `ledger/` | Runtime: decision ledger and applied changes (gitignored) | |

## Real data: SEC EDGAR
- Fetched on **2026-10-22** (inside the build window) by `scripts/fetch_edgar.ts`, with User-Agent `Tripwire hackathon demo <contact email>` and at most 5 requests per second.
- Sources:
  - `https://www.sec.gov/files/company_tickers.json` (ticker → CIK)
  - `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json` (XBRL facts)
  - `https://data.sec.gov/submissions/CIK##########.json` (SIC code)
- Each row's `source_url` is the EDGAR folder of the 10-Q / 10-K that first reported that quarter's balance sheet.
- Companies are chosen as plausible suppliers in 5 categories: semiconductors (TXN, MCHP, ON, WOLF), chemicals (DOW, CE, HUN, EMN), logistics (UPS, CHRW, JBHT, XPO), packaging (IP, BALL, SON, PKG) and electronic components (APH, JBL, SANM, VSH). Picking them does not mean any of them is, or is not, a good supplier; the spend relationship is fictional.
- Rebuild with `npx tsx scripts/fetch_edgar.ts` (add `--refresh` to re-download). Later filings will change the numbers.

### How the columns are derived (us-gaap XBRL tags)
- `period_end`: the balance sheet date of a 10-Q or 10-K.
- `revenue`: the quarter's revenue (`RevenueFromContractWithCustomerExcludingAssessedTax`, else `Revenues`, else similar). Q4 is not reported on its own, so it is the fiscal year minus the 9-month year-to-date figure.
- `gross_margin`: `GrossProfit` ÷ revenue, or (revenue − `CostOfGoodsAndServicesSold`/`CostOfRevenue`) ÷ revenue. **Empty** where the filer reports no cost of sales (UPS, C.H. Robinson, J.B. Hunt, XPO, Ball).
- `current_ratio`: `AssetsCurrent` ÷ `LiabilitiesCurrent`.
- `debt_to_equity`: **total liabilities** ÷ stockholders' equity (`Liabilities` ÷ `StockholdersEquity`; if `Liabilities` is not tagged, `LiabilitiesAndStockholdersEquity` − equity). This is the "total liabilities" version of the ratio, not interest-bearing debt only. It is negative when equity is negative (Wolfspeed, mid-2025).
- The original filing's value is used, not later restatements.
- Dropped: quarters that cannot be derived (no current liabilities or no quarterly revenue), a second balance date within a week of another (Wolfspeed's fresh-start split in Sept 2025), and quarters whose derived numbers are implausible (revenue below 30% of the company's median, or gross margin outside −100%…100%). Most of these come from Q4 = year − YTD mixing restated and original figures. This is why some companies' latest row is March 2026 rather than June 2026.

### Licence
SEC EDGAR data is US government work and is in the public domain. See the SEC's [website policies](https://www.sec.gov/privacy) and [fair access rules](https://www.sec.gov/os/accessing-edgar-data). No endorsement by the SEC or any company is implied.

## Real data: SEC 8-K events and the OFAC sanctions screen
Built by `npx tsx scripts/fetch_sources.ts` (add `--refresh` to download again). Raw downloads are cached in `data/cache/`, which is gitignored.

- `supplier_events.csv`: every Form 8-K and 8-K/A each supplier filed in the 365 days before the fetch, from SEC EDGAR's submissions API (`data.sec.gov/submissions/CIK##########.json`). Columns: `cik, filed_date, form, items, accession, url`. `items` holds the 8-K item numbers, separated by spaces. The metric `risk_events_12m` counts filings that carry a serious item: 1.02, 1.03, 1.05, 2.04, 2.05, 2.06, 3.01, 4.01, 4.02 or 5.01 (`RISK_ITEMS` in `app/metrics.ts`). One real filing is held back for the demo (see change file 04).
- `sanctions_screen.csv`: each supplier's legal name screened against the US Treasury OFAC Specially Designated Nationals list (`sdn.csv`) and its aliases (`alt.csv`). Columns: `cik, name, list, list_as_of, list_entries, match_count, matches, screened_on, source_url`. `list_as_of` is the list file's Last-Modified date. Names are compared after removing punctuation and legal-form words (Inc, Corp, LLC and so on). One-word names need an exact match, so "Dow" does not hit every listed name containing "Dow". **Every supplier currently has 0 matches.** A match would be a candidate for a compliance officer to check, never a finding, and no sanctions hit has been invented for a real company.
- Licence: SEC EDGAR and OFAC data are US government works, in the public domain. SEC asks automated clients to send a User-Agent with contact details (`SEC_USER_AGENT`) and to stay under 10 requests per second; the script makes at most 5 per second.

## Synthetic data
`supplier_spend.csv` and change files 02 and 03 are **made up** for the demo. They describe a fictional buyer's relationship with each company. No real contract, price or purchase order is implied.
- `spend_share`: the supplier's share of **our spend in its category** (each category sums to 1.00).
- `lead_time_weeks`, `open_po_value` (USD), `contract_end`, `updated_at`: fictional.
- They were written so a few suppliers stand out when combined with their real financials:
  - SUP-04 Wolfspeed: negative gross margin; 26-week lead time.
  - SUP-18 Jabil: 62% of its category; current ratio below 1; high liabilities to equity.
  - SUP-15 Sonoco: current ratio below 1.
  - The rest are meant to be mostly unremarkable.
  The agents decide; this table does not encode answers.

## Change files (selective reopen demo)
Each file is `{description, synthetic, table, key, row}` (or an array of them). `key` is the row key from `ROW_KEY` in `app/sql/templates.ts`: `cik` for financials, 8-K events and the sanctions screen; `supplier_id` for spend. The adapter's `applyChange(file)` upserts the row and logs it in `ledger/applied_changes.jsonl`. Financial rows match on (cik, period_end), so file 01 adds a quarter. `changesSince(marker)` then reports the changed rows to the Watcher.

- `01_new_quarter.json` is real: Vishay's 10-Q for the quarter ended 2026-07-04. Its current ratio falls from 2.64 to 1.80. In the same filing, noncurrent long-term debt drops by about $750M and current liabilities rise by about $800M.
- `02` and `03` are synthetic.
- `04_new_8k.json` is real: Dow Inc.'s 8-K filed 2026-01-29 (item 2.05, exit or restructuring costs). It is held back from `supplier_events.csv` so the demo can show it arriving. Applying it takes Dow's `risk_events_12m` from 0 to 1, which fires that decision's tripwire and reopens only SUP-05; the other 19 decisions are left alone (`test/fragments.test.ts`).
