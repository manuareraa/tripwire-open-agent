// The number check behind the critic (and the eval harness): every figure in a rationale must trace to the evidence.
import { describe, expect, it } from "vitest";
import { unsupportedNumbers } from "../app/agents/critic.js";
import type { MetricValue } from "../app/metrics.js";

const metrics = [{ metric: "debt_to_equity", value: 4.138 }, { metric: "spend_share", value: 0.35 }] as MetricValue[];

describe("unsupportedNumbers", () => {
  it("does not read SEC form names or supplier ids as figures", () => {
    expect(unsupportedNumbers("SUP-06 filed a material-risk 8-K and a late 10-Q; liabilities/equity 4.138.", metrics)).toEqual([]);
  });

  it("still catches a number that is not in the evidence", () => {
    expect(unsupportedNumbers("liabilities/equity 4.138 and an 8-K, with margin 0.61", metrics)).toEqual(["0.61"]);
  });
});
