// Planner: picks which data templates the Analyst should query for this question.
import { TEMPLATES } from "../sql/templates.js";
import { extractJson } from "../adapters/model.js";
import { callModel, type Deps, type RunState } from "../orchestration/state.js";

const AGENT = "Planner";
export const ORDER = [
  "supplier_spend_row", "supplier_financials_latest", "supplier_financials_history", "category_concentration",
  "supplier_events_recent", "sanctions_screen_row", "source_status",
];
// A keep/dual-source/exit call needs every view: without history there is no trend, without the category no
// alternatives, without the 8-K feed no material events, without the sanctions screen no compliance check.
const REQUIRED = ORDER;

export async function plan(deps: Deps, s: RunState): Promise<string[]> {
  const options = TEMPLATES.filter((t) => ORDER.includes(t.id));
  const res = await callModel(deps, s, {
    tier: "small",
    agent_name: AGENT,
    json: true,
    system:
      "You plan a supplier risk review. Choose which data queries are needed to answer the question. " +
      'Reply only with JSON: {"steps": [template ids], "focus": "one sentence on what matters most"}.',
    user:
      `Supplier: ${s.subject_id}\nQuestion: ${s.question}\nAvailable queries:\n` +
      options.map((t) => `- ${t.id}: ${t.description}`).join("\n"),
  });

  let steps: string[] = [];
  let focus = "";
  const parsed = res.fallback ? undefined : extractJson<{ steps?: unknown; focus?: unknown }>(res.text);
  if (parsed && Array.isArray(parsed.steps)) {
    const known = parsed.steps.filter((x): x is string => typeof x === "string" && ORDER.includes(x));
    const unknown = parsed.steps.filter((x) => !ORDER.includes(String(x)));
    if (unknown.length) {
      deps.tracer.emit({ decision_id: s.decision_id, agent_name: AGENT, action: "drop_unknown_steps", event: "critique", status: "needs_revision", output_summary: `ignored: ${unknown.join(", ")}` });
    }
    steps = known;
    focus = typeof parsed.focus === "string" ? parsed.focus : "";
  } else {
    steps = [...ORDER];
    focus = "full review (rule-based plan)";
  }
  const added = REQUIRED.filter((r) => !steps.includes(r));
  steps.push(...added);
  steps = ORDER.filter((id) => steps.includes(id));

  deps.tracer.emit({
    decision_id: s.decision_id, agent_name: AGENT, action: "plan", event: "handoff", target_agent: "Analyst",
    status: res.fallback ? "fallback" : "success", input_summary: s.question, output_summary: `${steps.join(" → ")}${focus ? ` | focus: ${focus}` : ""}${added.length && !res.fallback ? ` | policy added: ${added.join(", ")}` : ""}`,
  });
  return steps;
}
