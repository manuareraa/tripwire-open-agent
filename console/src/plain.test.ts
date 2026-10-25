import { beforeAll, describe, expect, it } from "vitest";
import { fmtField, fmtMetric, plural, titleCase } from "./format";
import { setSuppliers } from "./names";
import { issueText, plain, readFlag, say, suggestReason, wireText, writeText } from "./plain";
import type { Decision } from "./types";

beforeAll(() => setSuppliers([
  { supplier_id: "SUP-06", short: "Kemet", cik: "887730" },
  { supplier_id: "SUP-18", short: "Jabil", cik: "898293" },
]));

describe("format", () => {
  it("formats metrics by unit", () => {
    expect(fmtMetric("spend_share", 0.31)).toBe("31%");
    expect(fmtMetric("gross_margin", 0.052)).toBe("5.2%");
    expect(fmtMetric("revenue_change_pct", -12.345)).toBe("-12.3%");
    expect(fmtMetric("lead_time_weeks", 14)).toBe("14 wk");
    expect(fmtMetric("current_ratio", 0.876)).toBe("0.88");
    expect(fmtMetric("x", undefined)).toBe("");
  });
  it("formats changed fields", () => {
    expect(fmtField("spend_share", 0.4)).toBe("40%");
    expect(fmtField("revenue", 2_500_000_000)).toBe("2.50B");
    expect(fmtField("open_po_value", 1_200_000)).toBe("1.2M");
    expect(fmtField("x", null)).toBe("none");
  });
  it("tidies names and plurals", () => {
    expect(titleCase("JABIL INC")).toBe("Jabil");
    expect(plural(1, "row")).toBe("1 row");
    expect(plural("3", "row")).toBe("3 rows");
  });
});

describe("plain English", () => {
  it("reads risk flags", () => {
    expect(readFlag("high risk: current ratio 0.8 < 1")).toMatchObject({ name: "Current ratio", value: "0.8", rule: "should be at least 1", group: "health" });
    expect(readFlag("low confidence 0.42")).toMatchObject({ name: "Low confidence", value: "42%", group: "policy" });
    expect(readFlag("no alternative supplier in category").group).toBe("exposure");
  });
  it("rewrites tripwires and codes", () => {
    expect(wireText("debt_to_equity > 5 (now 4.138, was 4.138)")).toBe("Liabilities to equity rises above 5 (now 4.14, was 4.14)");
    expect(plain("supplier_financials:898293 changed")).toBe("Jabil's SEC filings changed");
    expect(plain("see DEC-SUP-06-abc123")).toBe("see Kemet's decision");
    expect(issueText("numbers not in the evidence: 1.2, 3.4")).toBe("It quotes numbers that no query produced: 1.2, 3.4.");
  });
  it("describes trace events", () => {
    expect(say({ action: "query:supplier_spend_row", output_summary: "1 rows", status: "success" }).title).toBe("Read our spend record");
    expect(say({ action: "propose_decision", output_summary: "exit @ 0.8; tripwires: spend_share > 0.3" })).toEqual({ title: "Proposed Exit at 80% confidence", detail: "Reopen if: Share of our category spend rises above 30%." });
    expect(say({ action: "model_call_reasoning", output_summary: "nvidia/nemotron (thinking on)" })).toEqual({ title: "Asked the reasoning model", detail: "NVIDIA nemotron, with deep thinking on" });
  });
  it("words the ledger write honestly", () => {
    expect(writeText({ written: true, detail: "read back 1 row" })).toBe("Saved to the decision ledger in Zetaris and read back to confirm (1 row).");
    expect(writeText({ written: false })).toBe("The ledger write did not happen.");
  });
});

describe("suggested reason", () => {
  const base: Decision = { decision_id: "DEC-SUP-18-x", subject_id: "SUP-18", decision: "exit", confidence: 0.8, status: "proposed" };
  it("leads with numbered flags", () => {
    const r = suggestReason({ ...base, escalated: true, escalation_reasons: ["exit decisions always go to a senior buyer", "high risk: current ratio 0.8 < 1"], tripwires: [{ metric: "current_ratio", op: ">", threshold: 1.2 }] });
    expect(r).toBe("Reviewed the escalation and agree with Exit at 80% confidence: current ratio is 0.8 (should be at least 1), exit always needs a senior buyer. Reopen if current ratio rises above 1.2.");
  });
  it("falls back to the rationale's first sentence", () => {
    expect(suggestReason({ ...base, decision: "keep", rationale: "Healthy on every measure. More text." })).toBe("Agree with Keep at 80% confidence: healthy on every measure.");
  });
});
