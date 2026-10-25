// What-if changes for any supplier, built from its current values in the live data layer.
// Each is a synthetic, clearly labelled change to real columns (spend share, lead time, open POs, contract end, or a
// new quarter of financials). Because they are computed from what is in the data now, applying one twice moves the
// numbers again instead of being a no-op.
import { TABLES } from "./sql/templates.js";
import { normaliseRow, type ChangeFile, type Row } from "./changes.js";
import type { DataGateway } from "./types.js";

export const WHATIF_KINDS = ["spend_shift", "lead_time", "contract_renewal", "weak_quarter", "downturn"] as const;
export type WhatIfKind = (typeof WHATIF_KINDS)[number];

export interface WhatIfField {
  table: string;
  key: string;
  supplier_id: string;
  field: string;
  before: number | string | null;
  after: number | string | null;
}

export interface WhatIf {
  /** Stable id for the UI, e.g. "whatif:SUP-06:spend_shift". */
  id: string;
  kind: WhatIfKind;
  supplier_id: string;
  title: string;
  description: string;
  available: boolean;
  /** Why it cannot be applied right now (only when available is false). */
  reason?: string;
  changes: ChangeFile[];
  fields: WhatIfField[];
}

export interface WhatIfContext {
  /** Company facts the templates do not return (SEC industry code), by CIK. */
  sicByCik?: Map<string, string>;
  now?: Date;
}

/** Points of category spend a spend shift moves, and the most of a category one supplier may end up with. */
const SHIFT = 0.2;
const MAX_SHARE = 0.95;
const MAX_LEAD_WEEKS = 52;

const QUARTER: Record<"weak_quarter" | "downturn", { revenue: number; gross_margin: number; current_ratio: number; debt_to_equity: number }> = {
  weak_quarter: { revenue: 0.12, gross_margin: 0.15, current_ratio: 0.15, debt_to_equity: 0.2 },
  downturn: { revenue: 0.3, gross_margin: 0.4, current_ratio: 0.4, debt_to_equity: 0.6 },
};

const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;
const roundTo = (x: number, step: number) => Math.round(x / step) * step;
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** ISO timestamp without milliseconds, the form supplier_spend.updated_at uses. */
export const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

const lastDay = (y: number, month1: number) => new Date(Date.UTC(y, month1, 0)).getUTCDate();

/**
 * Same date `months` later. A month-end stays a month-end (2026-09-30 + 3 → 2026-12-31, as quarter ends do);
 * any other day is clamped to the end of a shorter month (2026-01-30 + 1 → 2026-02-28).
 */
export function addMonths(date: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`not a date: ${date}`);
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + months;
  const y = Math.floor(total / 12);
  const mo = (total % 12) + 1;
  const last = lastDay(y, mo);
  const d = Number(m[3]) === lastDay(Number(m[1]), Number(m[2])) ? last : Math.min(Number(m[3]), last);
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A ratio made worse by a fraction of its size: lower for margins and liquidity, higher for leverage. */
function worse(v: unknown, by: number, up: boolean): number | null {
  if (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  return round(up ? n + Math.abs(n) * by : n - Math.abs(n) * by, 4);
}

function fieldsOf(c: ChangeFile, before: Row | undefined, supplier_id: string, cols: string[]): WhatIfField[] {
  return cols
    .filter((f) => c.row[f] !== undefined)
    .map((f) => ({
      table: c.table, key: c.key, supplier_id, field: f,
      before: before?.[f] === undefined ? null : (before[f] as number | string | null),
      after: c.row[f] as number | string | null,
    }));
}

/** Every what-if for one supplier, computed from the live data. Unavailable ones say why. */
export async function buildWhatIfs(gw: DataGateway, supplier_id: string, ctx: WhatIfContext = {}): Promise<WhatIf[]> {
  const now = ctx.now ?? new Date();
  const stamp = isoSeconds(now);
  const spend = (await gw.runTemplate("supplier_spend_row", { supplier_id })).rows[0];
  if (!spend) throw new Error(`no spend row for ${supplier_id}`);
  const cik = String(spend.cik);
  const category = String(spend.category);
  const latest = (await gw.runTemplate("supplier_financials_latest", { cik })).rows[0];
  const name = String(latest?.name ?? supplier_id);
  const out: WhatIf[] = [];
  const make = (kind: WhatIfKind, title: string, description: string, changes: ChangeFile[], fields: WhatIfField[], reason?: string): WhatIf => ({
    id: `whatif:${supplier_id}:${kind}`, kind, supplier_id, title, description,
    available: !reason, ...(reason ? { reason } : {}), changes: reason ? [] : changes, fields: reason ? [] : fields,
  });
  const spendChange = (row: Row, description: string): ChangeFile => ({
    description, synthetic: true, table: TABLES.spend, key: String(row.supplier_id), row: normaliseRow(TABLES.spend, row),
  });

  // 1. Spend shifts here from the biggest other supplier in the category.
  {
    const share = Number(spend.spend_share ?? 0);
    const others = (await gw.runTemplate("category_concentration", { category })).rows
      .filter((r) => r.supplier_id !== supplier_id && Number(r.spend_share ?? 0) > 0)
      .sort((a, b) => Number(b.spend_share) - Number(a.spend_share) || String(a.supplier_id).localeCompare(String(b.supplier_id)));
    const donorId = others[0] ? String(others[0].supplier_id) : undefined;
    const donor = donorId ? (await gw.runTemplate("supplier_spend_row", { supplier_id: donorId })).rows[0] : undefined;
    // Whole points only; rounding first stops float noise (0.95 - 0.9 = 0.04999…) from losing a point.
    const move = donor ? Math.floor(round(Math.min(SHIFT, Number(donor.spend_share), MAX_SHARE - share) * 100, 6)) / 100 : 0;
    const title = `Spend shifts to ${name}`;
    if (!donor) out.push(make("spend_shift", title, "", [], [], `no other ${category} supplier has spend to move`));
    else if (move < 0.01) out.push(make("spend_shift", title, "", [], [], `already ${pct(share)} of ${category} spend`));
    else {
      const scalePo = (r: Row, to: number) => {
        const from = Number(r.spend_share);
        const po = r.open_po_value == null ? null : Number(r.open_po_value);
        return po === null || !(from > 0) ? po : roundTo((po * to) / from, 10000);
      };
      const toShare = round(share + move, 4);
      const fromShare = round(Number(donor.spend_share) - move, 4);
      const description = `SYNTHETIC what-if: ${Math.round(move * 100)} points of ${category} spend move from ${donorId} to ${supplier_id} (${pct(share)} → ${pct(toShare)}); open orders scale with the share.`;
      const here = spendChange({ ...spend, spend_share: toShare, open_po_value: scalePo(spend, toShare), updated_at: stamp }, description);
      const there = spendChange({ ...donor, spend_share: fromShare, open_po_value: scalePo(donor, fromShare), updated_at: stamp }, description);
      out.push(make("spend_shift", title, description, [here, there], [
        ...fieldsOf(here, spend, supplier_id, ["spend_share", "open_po_value"]),
        ...fieldsOf(there, donor, donorId!, ["spend_share", "open_po_value"]),
      ]));
    }
  }

  // 2. A longer quoted lead time.
  {
    const lead = Number(spend.lead_time_weeks ?? 0);
    const to = Math.min(MAX_LEAD_WEEKS, lead + Math.max(3, Math.round(lead * 0.5)));
    const title = `${name} quotes a longer lead time`;
    if (!(to > lead)) out.push(make("lead_time", title, "", [], [], `lead time is already ${lead} weeks`));
    else {
      const description = `SYNTHETIC what-if: ${supplier_id} quotes ${to} weeks instead of ${lead}.`;
      const c = spendChange({ ...spend, lead_time_weeks: to, updated_at: stamp }, description);
      out.push(make("lead_time", title, description, [c], fieldsOf(c, spend, supplier_id, ["lead_time_weeks"])));
    }
  }

  // 3. Contract renewed for a year with a bigger order book (no risk metric moves, so decisions should hold).
  {
    const title = `${name} contract renewed`;
    const end = spend.contract_end == null ? "" : String(spend.contract_end);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) out.push(make("contract_renewal", title, "", [], [], "no contract end date on file"));
    else {
      const po = spend.open_po_value == null ? null : roundTo(Number(spend.open_po_value) * 1.25, 10000);
      const to = addMonths(end, 12);
      const description = `SYNTHETIC what-if: ${supplier_id}'s contract runs to ${to} instead of ${end}, and open orders grow by a quarter.`;
      const c = spendChange({ ...spend, contract_end: to, open_po_value: po, updated_at: stamp }, description);
      out.push(make("contract_renewal", title, description, [c], fieldsOf(c, spend, supplier_id, ["contract_end", "open_po_value"])));
    }
  }

  // 4–5. A new quarter of financials: a soft one, or a sharp downturn.
  for (const kind of ["weak_quarter", "downturn"] as const) {
    const title = kind === "weak_quarter" ? `${name} reports a weak quarter` : `${name} reports a sharp downturn`;
    const period = latest?.period_end == null ? "" : String(latest.period_end);
    if (!latest || !/^\d{4}-\d{2}-\d{2}$/.test(period)) {
      out.push(make(kind, title, "", [], [], "no filed quarter to build on"));
      continue;
    }
    const k = QUARTER[kind];
    const next = addMonths(period, 3);
    const revenue = latest.revenue == null ? null : Math.round(Number(latest.revenue) * (1 - k.revenue));
    const row: Row = {
      cik, ticker: latest.ticker ?? null, name: latest.name ?? null, sic: ctx.sicByCik?.get(cik) ?? null, period_end: next,
      revenue,
      gross_margin: worse(latest.gross_margin, k.gross_margin, false),
      current_ratio: worse(latest.current_ratio, k.current_ratio, false),
      debt_to_equity: worse(latest.debt_to_equity, k.debt_to_equity, true),
      source_url: "synthetic what-if",
    };
    const description =
      `SYNTHETIC what-if: a quarter ending ${next} with revenue down ${Math.round(k.revenue * 100)}%, gross margin and current ratio ` +
      `${Math.round(k.gross_margin * 100)}% weaker, and debt to equity ${Math.round(k.debt_to_equity * 100)}% higher than ${period}. Not an SEC filing.`;
    const c: ChangeFile = { description, synthetic: true, table: TABLES.financials, key: cik, row: normaliseRow(TABLES.financials, row) };
    out.push(make(kind, title, description, [c], fieldsOf(c, latest, supplier_id, ["revenue", "gross_margin", "current_ratio", "debt_to_equity"])));
  }
  return out;
}
