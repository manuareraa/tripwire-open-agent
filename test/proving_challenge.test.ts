import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionDraft, Deps, RunState } from "../app/orchestration/state.js";
import type { TripwireDraft } from "../app/tripwires.js";
import type { TraceEvent } from "../app/types.js";

let newState: typeof import("../app/orchestration/graph.js").newState;
let selfChallenge: typeof import("../app/proving/challenge.js").selfChallenge;

beforeAll(async () => {
  process.env.LOG_DIR = mkdtempSync(join(tmpdir(), "tw-challenge-"));
  ({ newState } = await import("../app/orchestration/graph.js"));
  ({ selfChallenge } = await import("../app/proving/challenge.js"));
});

const draft: DecisionDraft = { decision: "keep", confidence: 0.8, rationale: "", tripwires: [], limitations: [], rules: false };

function setup() {
  const events: Partial<TraceEvent>[] = [];
  const deps = { tracer: { emit: (e: Partial<TraceEvent>) => events.push(e) } } as unknown as Deps;
  const s: RunState = newState("run-1", "SUP-01", "q");
  return { deps, s, events };
}

const tw = (metric: string, verdict: "verified" | "decorative" | "mis_set" | "untested", origin: TripwireDraft["origin"] = "decider"): TripwireDraft =>
  ({ metric, op: ">", threshold: 1, origin, crash_test: { verdict } });

describe("self-challenge", () => {
  it("leaves a decision alone when a model tripwire is verified and nothing is mis-set", () => {
    const { deps, s, events } = setup();
    s.proving.crash = { tested: 2, verified: 1, decorative: 1, mis_set: 0, dropped: ["spend_share"] };
    selfChallenge(deps, s, draft, [tw("debt_to_equity", "verified")]);
    expect(s.proving.challenge).toEqual({ disagrees: false, reasons: [] });
    expect(s.escalated).toBe(false);
    expect(events[0].agent_name).toBe("SelfChallenge");
  });

  it("escalates when no proposed tripwire survives the crash test", () => {
    const { deps, s } = setup();
    s.proving.crash = { tested: 3, verified: 0, decorative: 3, mis_set: 0, dropped: ["a", "b", "c"] };
    selfChallenge(deps, s, draft, [tw("spend_share", "untested", "rules")]);
    expect(s.escalated).toBe(true);
    expect(s.escalationReasons[0]).toMatch(/^Nemotron disagrees with itself: none of the tripwires/);
  });

  it("escalates a knife-edge call (a mis-set tripwire)", () => {
    const { deps, s } = setup();
    s.proving.crash = { tested: 2, verified: 1, decorative: 0, mis_set: 1, dropped: [] };
    selfChallenge(deps, s, draft, [tw("debt_to_equity", "verified"), tw("spend_share", "mis_set")]);
    expect(s.escalationReasons.join(" ")).toMatch(/crossed \(share of our category spend\), so it sits on a knife-edge/);
  });

  it("escalates only for a likely pre-mortem story grounded in a high-severity filing", () => {
    const { deps, s } = setup();
    s.proving.filings = [{ id: "f1", supplier_id: "SUP-01", accession: "x", filed: "2026-01-01", items: ["5.02"], headline: "CFO left", severity: "high", source_url: "", parsed_by: "p", text_hash: "h" }];
    s.proving.stories = [
      { id: "s1", story: "Liquidity runs out.", metric: "current_ratio", op: "<", threshold: 1, grounded_in: ["current_ratio"], likelihood: "high" },
      { id: "s2", story: "Leadership churn stalls the plant.", metric: "risk_events_12m", op: ">", threshold: 1, grounded_in: ["f1"], likelihood: "medium" },
    ];
    selfChallenge(deps, s, draft, []);
    expect(s.escalated).toBe(false);
    s.proving.stories[1].likelihood = "high";
    selfChallenge(deps, s, draft, []);
    expect(s.escalationReasons.join(" ")).toMatch(/Leadership churn stalls the plant/);
  });
});
