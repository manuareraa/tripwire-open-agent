// Fixed wording the console uses: verdicts, metrics, tooltips, the live-run copy and the tour.

export type Dict = Record<string, string>;

export const LABEL: Dict = { keep: "Keep", dual_source: "Dual-source", exit: "Exit" };
export const VERB: Dict = { keep: "Keep this supplier as it is.", dual_source: "Add a second supplier alongside this one.", exit: "Move this spend to other suppliers." };
export const METRIC: Record<string, [string, "ratio" | "share" | "pct" | "weeks" | "count"]> = {
  current_ratio: ["Current ratio", "ratio"],
  debt_to_equity: ["Liabilities to equity", "ratio"],
  gross_margin: ["Gross margin", "share"],
  revenue_change_pct: ["Revenue change across reported periods", "pct"],
  spend_share: ["Share of our category spend", "share"],
  lead_time_weeks: ["Lead time", "weeks"],
  category_alternatives: ["Other suppliers in the category", "count"],
  risk_events_12m: ["Material-risk 8-K filings, last 12 months", "count"],
  sanctions_matches: ["Possible OFAC sanctions name matches", "count"],
  backup_current_ratio: ["Backup's current ratio", "ratio"],
  backup_debt_to_equity: ["Backup's liabilities to equity", "ratio"],
  backup_lead_time_weeks: ["Backup's lead time", "weeks"],
};
export const FIELD: Dict = { spend_share: "Spend share", open_po_value: "Open orders", lead_time_weeks: "Lead time", annual_spend: "Annual spend", revenue: "Revenue", current_assets: "Current assets", current_liabilities: "Current liabilities", total_liabilities: "Total liabilities", equity: "Equity", gross_profit: "Gross profit", contract_end: "Contract end", gross_margin: "Gross margin", current_ratio: "Current ratio", debt_to_equity: "Debt to equity" };
export const OP: Dict = { ">": "rises above", ">=": "reaches", "<": "falls below", "<=": "falls to", "==": "equals", changed: "changes at all" };
export const TIP = {
  confidence: "How sure the Decider is, from 0 to 100%. Low confidence on a risky call is a reason to escalate.",
  risk: "Graded in code by the Risk Officer from the metrics, not by a model.",
  evidence: "Each finding names the approved SQL query it came from and a hash of the exact result. If the data changes, the hash no longer matches.",
  tripwire: "A condition on a specific data row. When that row changes, the Watcher re-checks the condition in code. If it fires, the decision is reopened.",
  escalated: "Risky or low-confidence decisions go to a senior buyer. Approving one needs a written reason.",
  status: "proposed → approved or rejected by a human. A reopened decision marks the old one superseded.",
};
// What each key number means, for the tooltips on the number tiles and tripwires.
export const METRIC_TIP: Dict = {
  current_ratio: "Current assets divided by current liabilities, from the latest SEC filing. Below 1 means the bills due within a year are bigger than what the company can quickly turn into cash.",
  debt_to_equity: "Total liabilities divided by shareholders' equity, from the latest SEC filing. Above 3 means the company is funded mostly by what it owes.",
  gross_margin: "Gross profit divided by revenue: how much of each sale is left after the direct cost of making it. Below 10% leaves little cushion for shocks.",
  revenue_change_pct: "How much revenue changed from the oldest to the newest reported period we hold. A fall of more than 10% is a warning sign.",
  spend_share: "Of everything we spend in this category, the share that goes to this supplier. 25% or more counts as heavy dependence.",
  lead_time_weeks: "Weeks from placing an order to delivery. 12 weeks or more makes switching or recovering slow.",
  category_alternatives: "How many other suppliers we already buy this category from. Zero means there is nowhere to move the work.",
  risk_events_12m: "Form 8-K filings to the SEC in the last 12 months that report a serious event: restructuring, impairment, debt acceleration, bankruptcy, a cybersecurity incident, an auditor change, delisting or change of control. Read from SEC EDGAR, which updates the same day a company files.",
  sanctions_matches: "How many names on the US Treasury OFAC sanctions list (SDN list and its aliases) match this supplier's legal name. A match is a candidate for a compliance officer to check, not a finding. Zero means no listed name matches.",
  backup_current_ratio: "The backup supplier's current assets divided by current liabilities, from its latest SEC filing. Below 1, the backup is no longer a safe place to move work.",
  backup_debt_to_equity: "The backup supplier's total liabilities divided by equity, from its latest SEC filing. Above 3, the backup is no longer a safe place to move work.",
  backup_lead_time_weeks: "Weeks from order to delivery at the backup supplier: how fast it could take on the work.",
};

export const TEMPLATE: Dict = {
  supplier_spend_row: "our spend record",
  supplier_financials_latest: "latest SEC financials",
  supplier_financials_history: "financial history",
  category_concentration: "category spend split",
  supplier_events_recent: "recent SEC 8-K filings",
  sanctions_screen_row: "OFAC sanctions screen",
  source_status: "source fetch log",
  decisions_for_supplier: "past decisions",
};
export const TABLE: Dict = { supplier_spend: "spend table", supplier_financials: "financials table", supplier_events: "SEC 8-K events", sanctions_screen: "OFAC sanctions screen", source_status: "source fetch log", tripwire_decisions: "decision ledger" };
export const MODEL_TIER: Dict = { small: "fast model", reasoning: "reasoning model", guard: "safety guard model" };
export const DATA_SRC: Dict = { zetaris: "live data in Zetaris", sample: "the bundled sample data" };
export const GUARD: Dict = { safe: "The guard model saw no problem.", unsafe: "The guard model raised a concern.", unknown: "The guard model gave no clear verdict, so the code rules decide." };
export const ZETARIS: Dict = { health: "Zetaris health check", write_decision: "Zetaris wrote the decision to the ledger", verify_decision: "Zetaris read the ledger back to confirm the write", read_decisions: "Zetaris read the decision ledger" };
export const GROUP: Dict = { health: "Financial health", exposure: "How much we depend on them", policy: "Policy" };
export const AGENT: Dict = { Orchestrator: "Or", ZetarisGateway: "Ze", Planner: "Pl", Analyst: "An", EvidenceCritic: "Cr", MemoryKeeper: "Me", RiskOfficer: "Ri", Decider: "De", Watcher: "Wa", BackupPicker: "Ba", Human: "Hu", Server: "Da" };

// ---------- Live run view ----------
export type Stage = [agent: string, short: string, does: string];
export const STAGES: Stage[] = [
  ["Planner", "Pl", "Picks the approved queries"],
  ["Analyst", "An", "Runs them, computes metrics"],
  ["EvidenceCritic", "Cr", "Checks every number"],
  ["MemoryKeeper", "Me", "Recalls, drops stale claims"],
  ["RiskOfficer", "Ri", "Grades risk in code"],
  ["Decider", "De", "Chooses, sets tripwires"],
];
export const CHANGE_STAGES: Stage[] = [
  ["Watcher", "Wa", "Finds dependent decisions"],
  ["Planner", "Pl", "Re-plans reopened ones"],
  ["Analyst", "An", "Re-runs queries"],
  ["EvidenceCritic", "Cr", "Re-checks numbers"],
  ["RiskOfficer", "Ri", "Re-grades risk"],
  ["Decider", "De", "Proposes again"],
];
export const NOW: Dict = {
  start_decision: "Starting the run and handing the question to the Planner",
  plan: "Planner is choosing which approved queries to run",
  check_summary: "Evidence Critic is checking the summary against the numbers",
  recall: "Memory Keeper is recalling earlier claims about this supplier",
  drop_stale: "Memory Keeper is dropping claims whose data has changed",
  assess_risk: "Risk Officer is grading risk from the metrics",
  propose_decision: "Decider is choosing keep, dual-source or exit, and drafting tripwires",
  review_decision: "Evidence Critic is reviewing the draft decision",
  pick_backup: "Backup Picker is choosing which other supplier should take the work",
  final_check: "Risk Officer is running the final guard and escalation check",
  remember: "Memory Keeper is saving claims with their data lineage",
  decision_proposed: "Done. Loading the decision…",
  lineage_lookup: "Watcher is asking memory which decisions read the changed row",
  check_tripwires: "Watcher is re-checking the tripwires of dependent decisions",
  reopen_summary: "Watcher is summarising what reopened",
  write_change: "The change is written. The Watcher is starting",
  write_whatif: "The what-if is written. The Watcher is starting",
  restore_data: "The bundled data is back. The Watcher is re-checking affected decisions",
};
// Fixed copy with a little markup; rendered as HTML because it is ours, never data.
export const TIPS = [
  "Every number in the decision links to the <b>SQL query</b> and a <b>hash</b> of its exact result.",
  "The <b>Evidence Critic</b> can send work back. Pushbacks show up in red in the trace.",
  "<b>Risk</b> is graded in plain code, not by a model, so it can't be talked out of a red flag.",
  "A <b>tripwire</b> is a condition on a specific row. Change that row and only its decisions are re-checked.",
  "If a model is unavailable, a labelled <b>rule-based fallback</b> decides. It is never passed off as a model answer.",
];
export const WATCHER_STEPS = ["Writing the change to the data layer", "Asking memory which decisions read that row", "Re-checking their tripwires in code", "Re-running any decision whose tripwire fired"];

// ---------- Tour ----------
export const TOUR = [
  { el: null, title: "Welcome to the Tripwire console", body: "Tripwire is a team of AI agents that makes supplier decisions and remembers exactly which data each one depends on. When that data changes, it reopens only the decisions affected. This tour takes about a minute." },
  { el: "#status-bar", title: "What is running right now", body: "Each pill shows whether a sponsor technology is live or on its fallback. Hover one for details. <b>Zetaris</b> holds the data, <b>Nemotron</b> does the reasoning, <b>H-MEM</b> stores memory and lineage." },
  { el: "#step-decide", title: "Step 1: make a decision", body: "Pick one of 20 suppliers and press <b>Decide</b>. Six agents plan queries, analyse, critique each other and propose <b>keep</b>, <b>dual-source</b> or <b>exit</b>. You watch each agent work live." },
  { el: "#detail", title: "The decision, explained", body: "Here you see the verdict and confidence, why, the key numbers (click one for its SQL and result hash), and the <b>tripwires</b>: how close each one is to firing." },
  { el: "#step-review", title: "Step 2: review and approve", body: "Every decision starts as a proposal. A human approves or rejects it. Risky ones are <b>escalated</b> and need a written reason. Approval writes the decision to the ledger." },
  { el: "#step-change", title: "Step 3: change the data", body: "Pick a change here and it opens in the middle, with the values before and after. What-ifs are computed for the supplier you picked; the bundled changes are fixed edits. Apply one and the Watcher asks memory which decisions read the changed rows, checks only their tripwires, and reopens only the ones that fire. Reset demo data puts the tables back. Click any step title to open or fold it." },
  { el: "#trace-panel", title: "See the agents think", body: "Every step of each run streams in here as it happens: queries, handoffs, where the Critic sent work back, and any fallback. Nothing is hidden." },
  { el: "#tour-btn", title: "You're ready", body: "Try the <b>Tripwire test</b> shortcut first: it decides on SUP-06, then you apply the spend share jump. You can replay this tour from here." },
];
