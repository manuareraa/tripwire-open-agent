// Tripwire console: decide → review and approve → change data → watch what reopens.
TW.mountNav("console");
TW.renderModes(document.getElementById("modes"));

const $ = (id) => document.getElementById(id);
const esc = TW.esc;
const LABEL = { keep: "Keep", dual_source: "Dual-source", exit: "Exit" };
const VERB = { keep: "keep this supplier", dual_source: "add a second supplier alongside this one", exit: "move this spend to other suppliers" };
const METRIC = {
  current_ratio: ["Current ratio", "ratio"],
  debt_to_equity: ["Liabilities to equity", "ratio"],
  gross_margin: ["Gross margin", "share"],
  revenue_change_pct: ["Revenue change across reported periods", "pct"],
  spend_share: ["Share of our category spend", "share"],
  lead_time_weeks: ["Lead time", "weeks"],
  category_alternatives: ["Other suppliers in the category", "count"],
};
const OP = { ">": "rises above", ">=": "reaches", "<": "falls below", "<=": "falls to", "==": "equals", changed: "changes at all" };
const TIP = {
  confidence: "How sure the Decider is, from 0 to 100%. Low confidence on a risky call is a reason to escalate.",
  risk: "Graded in code by the Risk Officer from the metrics, not by a model.",
  evidence: "Each finding names the approved SQL query it came from and a hash of the exact result. If the data changes, the hash no longer matches.",
  tripwire: "A condition on a specific data row. When that row changes, the Watcher re-checks the condition in code. If it fires, the decision is reopened.",
  escalated: "Risky or low-confidence decisions go to a senior buyer. Approving one needs a written reason.",
  status: "proposed → approved or rejected by a human. A reopened decision marks the old one superseded.",
};

let selected = null;
let suppliers = [];
let lastTrace = [];

const titleCase = (s) => String(s || "").toLowerCase()
  .replace(/(^|[\s.\-&/])([a-z])/g, (m, a, b) => a + b.toUpperCase())
  .replace(/[\s,]+(incorporated|inc|corporation|corp|company|co|ltd|plc|llc|n\.v|holdings?)\.?$/i, "").trim();
const supName = (id) => suppliers.find((s) => s.supplier_id === id)?.short ?? id;
const pct = (v) => `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}%`;
function fmtMetric(metric, v) {
  if (typeof v !== "number") return esc(v ?? "");
  const u = METRIC[metric]?.[1];
  if (u === "share") return pct(v);
  if (u === "pct") return `${v.toFixed(1)}%`;
  if (u === "weeks") return `${v} weeks`;
  return Math.abs(v) >= 1e5 ? v.toLocaleString() : String(+v.toFixed(2));
}
const info = (key) => `<span class="info" tabindex="0" data-tip="${esc(TIP[key])}">i</span>`;

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.detail || body.error || r.statusText), { body });
  return body;
}

let toastT;
function toast(html, ms = 7000) {
  document.querySelector(".toast")?.remove();
  const t = Object.assign(document.createElement("div"), { className: "toast", role: "status" });
  t.innerHTML = `<div>${html}</div><button type="button" aria-label="Dismiss">×</button>`;
  t.querySelector("button").onclick = () => t.remove();
  document.body.appendChild(t);
  clearTimeout(toastT); toastT = setTimeout(() => t.remove(), ms);
}

function setStep(n) {
  ["step-decide", "step-review", "step-change"].forEach((id, i) => {
    const el = $(id);
    el.classList.toggle("active", i + 1 === n);
  });
}
function markDone(id) { $(id).classList.add("done"); }

// ---------- Step 1: suppliers ----------
async function loadSuppliers() {
  suppliers = (await api("/suppliers").catch(() => [])).map((s) => ({ ...s, short: titleCase(s.name) || s.supplier_id }));
  if (!suppliers.length) for (let i = 1; i <= 20; i++) suppliers.push({ supplier_id: `SUP-${String(i).padStart(2, "0")}`, short: "" });
  const s = $("supplier");
  s.innerHTML = suppliers.map((x) => `<option value="${esc(x.supplier_id)}">${esc(x.supplier_id)} · ${esc(x.short)}</option>`).join("");
  const want = new URLSearchParams(location.search).get("supplier");
  s.value = suppliers.some((x) => x.supplier_id === want) ? want : "SUP-18";
  s.onchange = supMeta;
  supMeta();
}
function supMeta() {
  const x = suppliers.find((s) => s.supplier_id === $("supplier").value);
  $("sup-meta").innerHTML = x?.category
    ? `${esc(String(x.category).replace(/_/g, " "))}${x.ticker ? ` · ${esc(x.ticker)}` : ""} · <span class="term" tabindex="0" data-tip="Share of what we spend in this category that goes to this supplier (synthetic data).">${pct(Number(x.spend_share))} of category spend</span>`
    : "";
}

// ---------- Step 2: decisions list ----------
async function loadDecisions() {
  const list = await api("/decisions").catch(() => []);
  list.sort((a, b) => (a.status === "superseded") - (b.status === "superseded"));
  $("decisions").innerHTML = list.length ? list.map((d) => `
    <button class="item ${d.decision_id === selected ? "sel" : ""}" data-id="${esc(d.decision_id)}" type="button">
      <span class="who">${esc(d.subject_id)} · ${esc(supName(d.subject_id))}</span>
      <span class="verdict ${esc(d.decision)}">${LABEL[d.decision] ?? esc(d.decision)}</span>
      <span class="sub"><span class="st ${esc(d.status)}">${esc(d.status)}</span>${d.escalated ? `<span class="st esc">escalated</span>` : ""}<span>${Math.round((d.confidence ?? 0) * 100)}% confident</span></span>
    </button>`).join("") : `<div class="none">No decisions yet. Make one in step 1.</div>`;
  for (const el of $("decisions").querySelectorAll(".item")) el.onclick = () => openDecision(el.dataset.id);
  if (list.some((d) => d.status === "approved")) markDone("step-review");
  return list;
}

// ---------- Step 3: change files ----------
async function loadChanges() {
  let cat = await api("/changes/catalog").catch(() => null);
  if (!cat) cat = (await api("/changes").catch(() => [])).map((f) => ({ file: f, description: f }));
  $("changes").innerHTML = cat.map((c, i) => {
    const name = c.file.replace(/\.json$/, "").replace(/^\d+_/, "").replace(/_/g, " ");
    return `<div class="change">
      <div class="t">${esc(name.charAt(0).toUpperCase() + name.slice(1))}<span class="tg ${c.synthetic ? "synthetic" : "real"}" data-tip="${c.synthetic ? "A made-up change to synthetic spend data, to show the mechanism." : "Based on a real SEC filing."}" tabindex="0">${c.synthetic ? "synthetic" : "real filing"}</span></div>
      <p>${esc(String(c.description).replace(/^SYNTHETIC:\s*/i, "").replace(/\s*Figures from (https?:\S+)/, "").replace(/^./, (m) => m.toUpperCase()))}</p>
      ${c.table ? `<p>Changes row <code>${esc(c.table)}:${esc(c.key)}</code></p>` : ""}
      <button class="btn sm" data-f="${esc(c.file)}" type="button" ${i === 0 ? 'id="first-change"' : ""}>Apply this change</button>
    </div>`;
  }).join("") || `<div class="none">No change files found.</div>`;
  for (const b of $("changes").querySelectorAll("button[data-f]")) b.onclick = () => applyChange(b.dataset.f, b);
}

// ---------- Detail ----------
function renderStart() {
  selected = null;
  $("detail").innerHTML = `
    <div class="start">
      <div class="eyebrow">Start here</div>
      <h2>Make a decision, then change the data under it.</h2>
      <p>Tripwire's agents decide whether to keep, dual-source or exit a supplier. Each decision records which data rows it used and sets tripwires. When one of those rows changes, only the decisions it affects are reopened.</p>
      <div class="quick">
        <button type="button" data-q="SUP-18"><b>Risky supplier</b><span>SUP-18 · ${esc(supName("SUP-18"))}. Weak financials, so expect an exit or dual-source that gets escalated.</span></button>
        <button type="button" data-q="SUP-17"><b>Healthy supplier</b><span>SUP-17 · ${esc(supName("SUP-17"))}. No red flags, so expect keep.</span></button>
        <button type="button" data-q="SUP-06" data-then="change"><b>Test a tripwire</b><span>SUP-06 · ${esc(supName("SUP-06"))}. Decide, then apply the spend share jump in step 3 and see whether the decision reopens.</span></button>
      </div>
      <div class="steps3">
        <div><span class="n">1</span><span><b>Decide.</b> Pick a supplier on the left and press Decide. A live run takes about 30 to 90 seconds.</span></div>
        <div><span class="n">2</span><span><b>Review.</b> Read the verdict, the evidence behind every number, and the tripwires. Approve it to write it to the ledger.</span></div>
        <div><span class="n">3</span><span><b>Change the data.</b> Apply a change and see which decisions reopen and which are left alone.</span></div>
      </div>
    </div>`;
  for (const b of $("detail").querySelectorAll("[data-q]")) b.onclick = () => {
    $("supplier").value = b.dataset.q; supMeta();
    decide(b.dataset.then === "change");
  };
}

function renderWorking(sup, t0) {
  const stages = [["Planner", "picks which approved queries to run"], ["Analyst", "runs them and computes metrics"], ["Evidence Critic", "checks every number against its query"], ["Memory Keeper", "recalls earlier claims, drops stale ones"], ["Risk Officer", "grades risk, sets the thinking budget"], ["Decider", "chooses and drafts tripwires"]];
  $("detail").innerHTML = `
    <div class="working">
      <div class="eyebrow">Working <span id="elapsed">0s</span></div>
      <h2>Deciding on ${esc(sup)} · ${esc(supName(sup))}</h2>
      <p>The agents run in order and can send work back to each other. The full trace appears on the right when the run finishes.</p>
      <div class="pipe">${stages.map(([a, b], i) => `<div data-i="${i}"><b>${a}</b><span>${b}</span></div>`).join("")}</div>
    </div>`;
  // Elapsed timer only. The stage highlight is an approximation of progress, not a live feed.
  const tick = setInterval(() => {
    const el = $("elapsed");
    if (!el) return clearInterval(tick);
    const s = Math.round((Date.now() - t0) / 1000);
    el.textContent = `${s}s`;
    const k = Math.min(stages.length - 1, Math.floor(s / 8));
    for (const d of $("detail").querySelectorAll(".pipe div")) d.classList.toggle("on", Number(d.dataset.i) === k);
  }, 500);
}

function renderDecision(d) {
  selected = d.decision_id;
  const conf = Math.round((d.confidence ?? 0) * 100);
  const fallback = /^Rule-based policy/i.test(d.rationale || "");
  $("detail").innerHTML = `
    <div class="d-head">
      <span class="who"><b>${esc(d.subject_id)} · ${esc(supName(d.subject_id))}</b></span>
      <span class="st ${esc(d.status)}" tabindex="0" data-tip="${esc(TIP.status)}">${esc(d.status)}</span>
      <span class="id mono">${esc(d.decision_id)}</span>
    </div>
    <div class="d-main">
      <div><div class="eyebrow">Recommendation</div><div class="verdict ${esc(d.decision)}">${LABEL[d.decision] ?? esc(d.decision)}</div></div>
      <div class="conf">
        <div class="row"><span>Confidence ${info("confidence")}</span><b>${conf}%</b></div>
        <div class="meter"><i style="width:${conf}%"></i></div>
      </div>
    </div>
    <div class="d-pills">
      <span class="pill">Risk&nbsp;<b class="risk-${esc(d.risk)}">${esc(d.risk ?? "?")}</b>&nbsp;${info("risk")}</span>
      ${fallback ? `<span class="pill fallback" tabindex="0" data-tip="No model was available for this run, so a simple rule-based policy decided. It is labelled, never passed off as a model answer."><span class="dot"></span>rule-based fallback</span>` : ""}
      ${d.supersedes ? `<span class="pill" tabindex="0" data-tip="This decision was reopened by a tripwire and replaces an earlier one.">replaces <code>${esc(d.supersedes)}</code></span>` : ""}
    </div>
    ${d.escalated ? `<div class="banner esc"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01"/></svg><div><b>Escalated to a senior buyer</b> ${info("escalated")}<br>${esc((d.escalation_reasons || []).join("; "))}</div></div>` : ""}

    <div class="sec"><h3>Why</h3>
      <p class="why">${esc(d.rationale || "")}</p>
      ${d.summary ? `<details class="more"><summary>Analyst summary</summary><p>${esc(d.summary)}</p></details>` : ""}
    </div>

    <div class="sec"><h3>Evidence ${info("evidence")}</h3>
      <div class="ev-list">${(d.findings || []).map((f) => `
        <details class="ev-row"><summary><span>${esc(f.claim)}</span><span class="q">${esc(f.evidence?.template_id)}</span></summary>
          <div class="body">
            <pre>${esc(f.evidence?.sql)}</pre>
            <div class="muted">Result hash <code>${esc((f.evidence?.result_hash || "").slice(0, 16))}</code>${(f.evidence?.depends_on || []).length ? ` · rows ${f.evidence.depends_on.map((r) => `<code>${esc(r.table)}:${esc(r.key)}</code>`).join(" ")}` : ""}</div>
          </div></details>`).join("") || `<div class="none">No findings recorded.</div>`}</div>
    </div>

    <div class="sec"><h3>Tripwires: reopen this decision if… ${info("tripwire")}</h3>
      <div class="wires">${(d.tripwires || []).map((t) => `
        <div class="wire">
          <div class="c"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 16h6M16 16h6M8 16l4-9 4 9"/></svg><span><b>${esc(METRIC[t.metric]?.[0] ?? t.metric)}</b> ${esc(OP[t.op] ?? t.op)}${t.threshold !== undefined && t.threshold !== null && t.op !== "changed" ? ` <b>${fmtMetric(t.metric, t.threshold)}</b>` : ""}</span></div>
          <div class="w">watches ${esc((t.depends_on || []).map((r) => `${r.table}:${r.key}`).join(", "))}</div>
        </div>`).join("") || `<div class="none">No tripwires.</div>`}</div>
    </div>

    ${(d.limitations || []).length ? `<div class="sec"><h3>Limitations</h3><ul class="lim">${d.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>` : ""}

    ${d.status === "proposed" ? `
      <div class="approve" id="approval-box">
        <h3>Your call</h3>
        <p>Nothing is final until a person approves it. Approving writes the decision to the ledger${d.escalated ? ". This one is escalated, so a reason is required" : ""}.</p>
        <label class="field" for="reason">Reason ${d.escalated ? "(required)" : "(optional)"}</label>
        <textarea class="input" id="reason" rows="2" placeholder="${d.escalated ? "e.g. Reviewed the financials, agree to start moving volume" : "Optional note for the record"}"></textarea>
        <div class="row"><button class="btn primary" id="approve" type="button">Approve and write to ledger</button><button class="btn ghost" id="reject" type="button">Reject</button></div>
        <div class="err" id="writeres"></div>
      </div>` : d.status === "approved" ? `<div class="banner ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><div><b>Approved.</b> ${esc(d.approved_by_reason || "")}</div></div>` : ""}
    <div id="write-result"></div>`;

  const a = $("approve");
  if (a) {
    a.onclick = async () => {
      const reason = $("reason").value.trim();
      if (d.escalated && !reason) { $("writeres").textContent = "Escalated decisions need a reason before they can be approved."; $("reason").focus(); return; }
      a.disabled = true; a.innerHTML = `<span class="spin"></span>Writing…`;
      try {
        const r = await api(`/decisions/${d.decision_id}/approve`, { method: "POST", body: JSON.stringify({ reason }) });
        renderDecision(r.decision);
        $("write-result").innerHTML = `<div class="banner ${r.write?.written ? "ok" : "bad"}"><div><b>${r.write?.written ? "Written to the ledger." : "Not written."}</b> ${esc(r.write?.detail || "")}</div></div>`;
        await loadTrace(r.run_id, true);
        markDone("step-review"); setStep(3);
        toast(`<b>Approved.</b> Now try step 3: apply a data change and see which decisions reopen.`);
      } catch (e) { $("writeres").textContent = e.message; a.disabled = false; a.textContent = "Approve and write to ledger"; }
      loadDecisions();
    };
    $("reject").onclick = async () => {
      await api(`/decisions/${d.decision_id}/reject`, { method: "POST" }).catch((e) => toast(esc(e.message)));
      openDecision(d.decision_id);
    };
  }
}

async function openDecision(id) {
  try { renderDecision(await api(`/decisions/${id}`)); }
  catch (e) { $("detail").innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; }
  loadDecisions();
}

// ---------- Trace ----------
const AGENT = { Orchestrator: "Or", ZetarisGateway: "Ze", Planner: "Pl", Analyst: "An", EvidenceCritic: "Cr", MemoryKeeper: "Me", RiskOfficer: "Ri", Decider: "De", Watcher: "Wa", Human: "Hu" };
const pretty = (a) => String(a || "").replace(/([a-z])([A-Z])/g, "$1 $2");
function renderTrace(events, append = false) {
  lastTrace = append ? lastTrace.concat(events) : events;
  $("trace-count").textContent = lastTrace.length ? `${lastTrace.length} steps` : "";
  $("trace").innerHTML = lastTrace.map((e) => `
    <div class="tev ${esc(e.event)} ${esc(e.status)}">
      <span class="av">${esc(AGENT[e.agent_name] ?? String(e.agent_name || "?").slice(0, 2))}</span>
      <div>
        <div class="h"><b>${esc(pretty(e.agent_name))}</b>${e.target_agent ? `<span class="a">→ ${esc(pretty(e.target_agent))}</span>` : ""}<span class="a">${esc(String(e.action || "").replace(/_/g, " "))}</span>
          ${e.sponsor ? `<span class="bd">${esc(e.sponsor)}</span>` : ""}${e.event === "fallback" ? `<span class="bd">fallback</span>` : ""}${e.status === "needs_revision" ? `<span class="bd">sent back</span>` : ""}${e.retry_count ? `<span class="bd">retry ${e.retry_count}</span>` : ""}</div>
        ${e.output_summary ? `<div class="o">${esc(e.output_summary)}</div>` : ""}
      </div>
    </div>`).join("") || `<div class="none">No events.</div>`;
}
async function loadTrace(run_id, append) { renderTrace(await api(`/trace/${run_id}`).catch(() => []), append); }

// ---------- Actions ----------
let busy = false;
async function decide(thenChange = false) {
  if (busy) return;
  busy = true;
  const b = $("decide"); b.disabled = true; b.innerHTML = `<span class="spin"></span>Agents working…`;
  const sup = $("supplier").value;
  setStep(1);
  renderWorking(sup, Date.now());
  try {
    const r = await api("/run", { method: "POST", body: JSON.stringify({ mode: "decide", subject_id: sup }) });
    await openDecision(r.decision_id);
    await loadTrace(r.run_id);
    markDone("step-decide"); setStep(thenChange ? 3 : 2);
    if (thenChange) {
      toast(`<b>Decision made.</b> Now apply <b>Spend share jump</b> in step 3 and see whether this decision reopens.`, 10000);
      const btn = document.querySelector('[data-f="02_spend_share_jump.json"]');
      btn?.scrollIntoView({ block: "center", behavior: "smooth" }); btn?.classList.add("pulse-once");
    } else {
      toast(`<b>Decision proposed.</b> Read the reasoning and evidence, then approve or reject it at the bottom.`);
    }
  } catch (e) { $("detail").innerHTML = `<div class="banner bad"><div><b>The run failed.</b> ${esc(e.message)}</div></div>`; }
  b.disabled = false; b.textContent = "Decide"; busy = false;
}

async function applyChange(file, btn) {
  btn.disabled = true; const label = btn.textContent; btn.innerHTML = `<span class="spin"></span>Applying…`;
  setStep(3);
  $("report").innerHTML = `<div class="muted">Writing the change to the data layer, then asking memory which decisions depend on that row…</div>`;
  try {
    const r = await api(`/changes/${encodeURIComponent(file)}/apply`, { method: "POST" });
    $("report").innerHTML = r.reports.map((x) => `
      <div class="tiles">
        <div class="tile" data-tip="Active decisions that read the changed row." tabindex="0"><b>${x.dependents.length}</b><span>of ${x.active} depend on it</span></div>
        <div class="tile ${x.reopened.length ? "hot" : ""}" data-tip="Dependent decisions whose tripwire fired." tabindex="0"><b>${x.reopened.length}</b><span>reopened</span></div>
        <div class="tile" data-tip="Active decisions not re-run because the change could not affect them, or no tripwire fired." tabindex="0"><b>${x.work_saved}</b><span>left alone</span></div>
      </div>
      <div class="muted" style="font-size:12px">Changed row <code>${esc(x.changed.table)}:${esc(x.changed.key)}</code></div>
      ${x.reopened.map((o) => `<div class="rline fired"><b>Tripwire fired.</b> <code>${esc(o.old)}</code> reopened → <a href="#" data-id="${esc(o.new.decision_id)}">new decision: ${LABEL[o.new.decision] ?? esc(o.new.decision)}</a><ul>${o.fired.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>`).join("")}
      ${x.still_valid.map((v) => `<div class="rline"><b>Still holds.</b> <code>${esc(v.decision_id)}</code> depends on this row, but no tripwire fired.${(v.checked || []).length ? `<ul>${v.checked.map((c) => `<li>${esc(typeof c === "string" ? c : JSON.stringify(c))}</li>`).join("")}</ul>` : ""}</div>`).join("")}
      ${!x.dependents.length ? `<div class="rline">No active decision depends on this row, so nothing was re-run.${x.active ? "" : " Make a decision first to see the Watcher at work."}</div>` : ""}
    `).join("") || `<div class="none">No rows changed.</div>`;
    for (const a of $("report").querySelectorAll("a[data-id]")) a.onclick = (ev) => { ev.preventDefault(); openDecision(a.dataset.id); };
    await loadTrace(r.run_id);
    const reopened = r.reports.flatMap((x) => x.reopened);
    if (reopened[0]) { openDecision(reopened[0].new.decision_id); toast(`<b>A tripwire fired.</b> The reopened decision is open in the middle. The old one is marked superseded.`); }
    else toast(`<b>Nothing reopened.</b> The change did not cross any tripwire, so no work was redone.`);
    markDone("step-change");
    loadDecisions();
    btn.textContent = "Applied";
  } catch (e) {
    $("report").innerHTML = `<div class="banner bad">${esc(e.message)}</div>`;
    btn.disabled = false; btn.textContent = label;
  }
}

// ---------- Tour ----------
const TOUR = [
  { el: null, title: "Welcome to the Tripwire console", body: "Tripwire is a team of AI agents that makes supplier decisions and remembers exactly which data each one depends on. When that data changes, it reopens only the decisions affected. This tour takes about a minute." },
  { el: "#status-bar", title: "What is running right now", body: "Each pill shows whether a sponsor technology is live or on its fallback. Hover one for details. <b>Zetaris</b> holds the data, <b>Nemotron</b> does the reasoning, <b>H-MEM</b> stores memory and lineage." },
  { el: "#step-decide", title: "Step 1: make a decision", body: "Pick one of 20 suppliers and press <b>Decide</b>. Six agents plan queries, analyse, critique each other and propose <b>keep</b>, <b>dual-source</b> or <b>exit</b>. A live run takes 30 to 90 seconds." },
  { el: "#detail", title: "The decision, explained", body: "Here you see the verdict and confidence, why, the evidence behind every number (each tied to a SQL query and a result hash), and the <b>tripwires</b>: the conditions that would reopen it." },
  { el: "#step-review", title: "Step 2: review and approve", body: "Every decision starts as a proposal. A human approves or rejects it. Risky ones are <b>escalated</b> and need a written reason. Approval writes the decision to the ledger." },
  { el: "#step-change", title: "Step 3: change the data", body: "Apply a change to the source data. The Watcher asks memory which decisions read that row, checks only their tripwires, and reopens only the ones that fire. Everything else is <b>left alone</b>." },
  { el: "#trace-panel", title: "See the agents think", body: "Every step of each run appears here in order: queries, handoffs, where the Critic sent work back, and any fallback. Nothing is hidden." },
  { el: "#theme-picker", title: "Make it yours", body: "Switch between 12 colour themes and 6 font pairings at any time. Your choice is remembered." },
  { el: "#tour-btn", title: "You're ready", body: "Try the <b>Test a tripwire</b> shortcut first: it decides on SUP-06, then you apply the spend share jump. You can replay this tour from here." },
];
function startTour() { TW.tour(TOUR, { key: "tw.tourDone", finishLabel: "Start using it" }); }
$("tour-btn").onclick = startTour;

// ---------- Boot ----------
(async () => {
  await loadSuppliers();
  renderStart();
  const list = await loadDecisions();
  loadChanges();
  if (list.length) setStep(list.some((d) => d.status === "approved") ? 3 : 2);
  const q = new URLSearchParams(location.search);
  if (q.get("run") === "1") decide(q.get("supplier") === "SUP-06");
  else if (q.get("tour") === "1" || !TW.store.get("tw.tourDone")) startTour();
})();
