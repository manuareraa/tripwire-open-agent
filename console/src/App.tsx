// The console: three steps on the left, the current view in the middle, the agent trace on the right.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActionBar } from "./ActionBar";
import { api, smooth } from "./api";
import { DecisionView, DoneMark } from "./DecisionView";
import { rid, titleCase } from "./format";
import { Ic } from "./icons";
import { TOUR } from "./labels";
import { setSuppliers, supName } from "./names";
import { RunView } from "./RunView";
import { ChangeList, changeName, DecisionList, Step, SupplierStep, Toast, watcherStage, type ReportState } from "./Steps";
import { TracePanel, type TraceState } from "./Trace";
import type { ChangeCard, ChangeReport, Decision, Supplier, TraceEvent, WriteResult } from "./types";

type View =
  | { kind: "start" }
  | { kind: "skeleton" }
  | { kind: "run"; title: string; sub: string; runKind: "decide" | "change" }
  | { kind: "decision"; d: Decision; write?: WriteResult }
  | { kind: "error"; msg: string }
  | { kind: "runFailed"; msg: string; thenChange: boolean }
  | { kind: "nothing"; total: number };

type StepId = "step-decide" | "step-review" | "step-change";
const STEPS: StepId[] = ["step-decide", "step-review", "step-change"];
const narrow = () => innerWidth < 860;
const toDetail = () => { if (narrow()) document.getElementById("detail")?.scrollIntoView({ behavior: smooth(), block: "start" }); };
export const startTour = () => window.TW.tour(TOUR, { finishLabel: "Start using it" });

function StartView({ running, onPick }: { running: boolean; onPick: (id: string, thenChange: boolean) => void }) {
  const q = (cls: string, i: number, id: string, then: boolean, icon: "warn" | "shield" | "wire", title: string, exp: string) => (
    <button className={`qcard ${cls} enter`} style={{ "--i": i } as React.CSSProperties} type="button" data-q={id} data-then={then ? "change" : undefined} disabled={running} onClick={() => onPick(id, then)}>
      <span className="qi"><Ic n={icon} /></span><b>{title}</b><span className="s">{supName(id)} · {id}</span><span className="exp">{exp}</span><span className="go">Run it <Ic n="arrow" /></span>
    </button>
  );
  return (
    <div className="start">
      <div className="eyebrow">Start here</div>
      <h2>Make a decision, then change the data under it.</h2>
      <p>Agents decide whether to keep, dual-source or exit a supplier, and record which data rows each decision used. Change one of those rows and only the affected decisions reopen.</p>
      <div className="loop">
        <div><span className="ic"><Ic n="agents" /></span><b>Agents decide</b><span>Six agents query, check each other and propose</span></div>
        <div><span className="ic"><Ic n="person" /></span><b>You approve</b><span>Nothing is final until a person signs off</span></div>
        <div><span className="ic"><Ic n="db" /></span><b>Data changes</b><span>A new filing or a spend shift lands</span></div>
        <div><span className="ic"><Ic n="wire" /></span><b>Tripwire checks</b><span>Only dependent decisions are re-checked</span></div>
      </div>
      <div className="eyebrow" style={{ marginBottom: 10 }}>Quick start</div>
      <div className="quick">
        {q("risky", 1, "SUP-18", false, "warn", "Risky supplier", "Weak financials. Expect exit or dual-source, escalated.")}
        {q("healthy", 2, "SUP-17", false, "shield", "Healthy supplier", "No red flags. Expect keep.")}
        {q("wire", 3, "SUP-06", true, "wire", "Test a tripwire", "Decide, then apply the spend share jump.")}
      </div>
    </div>
  );
}

export function App() {
  const [suppliers, setSup] = useState<Supplier[] | null>(null);
  const [supplier, setSupplier] = useState("SUP-18");
  const [supSwap, setSupSwap] = useState(0);
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [changes, setChanges] = useState<ChangeCard[] | null>(null);
  const [active, setActive] = useState(1);
  const [done, setDone] = useState<Set<StepId>>(new Set());
  const [view, setViewState] = useState<View>({ kind: "start" });
  const [swapN, setSwapN] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceState>({ gen: 0, events: [], empty: "initial" });
  const [live, setLive] = useState(false);
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [suggest, setSuggest] = useState<string | null>(null);
  const [pulse, setPulse] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<ReportState>(null);
  const [toastMsg, setToast] = useState<{ node: ReactNode; ms: number; n: number } | null>(null);

  // Async flows read the latest values through refs, as they outlive the render that started them.
  const runningRef = useRef(false), supplierRef = useRef(supplier), shownRef = useRef<string | null>(null), decisionsRef = useRef<Decision[]>([]);
  supplierRef.current = supplier;

  const setView = (v: View) => {
    shownRef.current = v.kind === "decision" ? v.d.decision_id : v.kind === "start" ? null : shownRef.current;
    if (v.kind === "start") setSel(null);
    if (v.kind !== "skeleton" && v.kind !== "error") setSwapN((n) => n + 1);
    setViewState(v);
  };
  const toast = (node: ReactNode, ms = 7000) => setToast((t) => ({ node, ms, n: (t?.n ?? 0) + 1 }));
  const markDone = (id: StepId) => setDone((s) => new Set(s).add(id));

  const loadDecisions = async () => {
    const list = await api<Decision[]>("/decisions").catch(() => [] as Decision[]);
    list.sort((a, b) => Number(a.status === "superseded") - Number(b.status === "superseded"));
    decisionsRef.current = list; setDecisions(list);
    if (list.some((d) => d.status === "approved")) markDone("step-review");
    return list;
  };
  const loadTrace = async (run_id: string, append = false) => {
    const list = await api<TraceEvent[]>(`/trace/${run_id}`).catch(() => [] as TraceEvent[]);
    setTrace((t) => append ? { gen: t.events.length ? t.gen : t.gen + 1, events: t.events.concat(list), empty: "blank" } : { gen: t.gen + 1, events: list, empty: "waiting" });
  };
  /** Streams a run's trace while it runs. Returns a stop function that does one last fetch. */
  const watchRun = (run_id: string) => {
    let stopped = false;
    setTrace((t) => ({ gen: t.gen + 1, events: [], empty: "waiting" })); setLive(true);
    const apply = (ev: unknown) => { if (Array.isArray(ev) && ev.length) setTrace((t) => ev.length > t.events.length ? { ...t, events: ev } : t); };
    const poll = async () => {
      if (stopped) return;
      try { apply(await (await fetch(`/trace/${run_id}`)).json()); } catch { /* keep polling */ }
      if (!stopped) setTimeout(poll, 700);
    };
    setTimeout(poll, 400);
    return async () => {
      stopped = true;
      try { apply(await (await fetch(`/trace/${run_id}`)).json()); } catch { /* nothing more to show */ }
      setLive(false);
    };
  };

  const openDecision = async (id: string) => {
    setSel(id);
    if (shownRef.current !== id) setView({ kind: "skeleton" });
    try { setView({ kind: "decision", d: await api<Decision>(`/decisions/${id}`) }); }
    catch (e) { setView({ kind: "error", msg: (e as Error).message }); }
    toDetail();
    loadDecisions();
  };

  const decide = async (thenChange = false) => {
    if (runningRef.current) return;
    runningRef.current = true; setRunning(true);
    const id = supplierRef.current, run_id = rid();
    setActive(1);
    setView({ kind: "run", title: `Deciding on ${supName(id)}`, sub: `${id} · six agents, about 30 to 90 seconds live`, runKind: "decide" });
    toDetail();
    const stop = watchRun(run_id);
    try {
      const r = await api<{ decision_id: string; run_id: string }>("/run", { method: "POST", body: JSON.stringify({ mode: "decide", subject_id: id, run_id }) });
      await stop();
      await openDecision(r.decision_id);
      await loadTrace(r.run_id);
      markDone("step-decide"); setActive(thenChange ? 3 : 2);
      if (thenChange) {
        toast(<><b>Decision made.</b> Now apply <b>Spend share jump</b> in step 3 and see whether this decision reopens.</>, 10000);
        const file = "02_spend_share_jump.json";
        setSuggest(file); setPulse((p) => new Set(p).add(file));
        document.querySelector(`[data-card="${file}"]`)?.scrollIntoView({ block: "center", behavior: smooth() });
      } else {
        toast(<><b>Decision proposed.</b> Read the reasoning and evidence, then approve or reject it in the bar at the bottom of the screen.</>);
      }
    } catch (e) {
      await stop();
      setView({ kind: "runFailed", msg: (e as Error).message, thenChange });
    }
    runningRef.current = false; setRunning(false);
  };
  const pick = (id: string, thenChange: boolean) => { setSupplier(id); supplierRef.current = id; setSupSwap((n) => n + 1); decide(thenChange); };

  const applyChange = async (file: string) => {
    if (runningRef.current) return;
    runningRef.current = true; setRunning(true); setApplying(file);
    setSuggest(file); setActive(3);
    const run_id = rid();
    setReport({ kind: "working" });
    setView({ kind: "run", title: `Applying “${changeName(file)}”`, sub: "The Watcher checks only decisions that read the changed row", runKind: "change" });
    const stop = watchRun(run_id);
    try {
      const r = await api<{ run_id: string; reports: ChangeReport[] }>(`/changes/${encodeURIComponent(file)}/apply?run_id=${run_id}`, { method: "POST" });
      await stop();
      const total = (r.reports || []).reduce((n, x) => n + x.active, 0);
      setReport({ kind: "done", reports: r.reports || [], snapshot: decisionsRef.current });
      await loadTrace(r.run_id);
      const reopened = (r.reports || []).flatMap((x) => x.reopened);
      if (reopened[0]) { await openDecision(reopened[0].new.decision_id); toast(<><b>A tripwire fired.</b> The reopened decision is open in the middle. The old one is marked superseded.</>); }
      else { setView({ kind: "nothing", total }); toast(<><b>Nothing reopened.</b> The change did not cross any tripwire, so no work was redone.</>); }
      markDone("step-change");
      loadDecisions();
      setApplied((s) => new Set(s).add(file));
    } catch (e) {
      await stop();
      setReport({ kind: "error", msg: (e as Error).message });
      setView({ kind: "start" });
    }
    setApplying(null);
    runningRef.current = false; setRunning(false);
  };

  const approve = async (d: Decision, reason: string) => {
    try {
      const r = await api<{ decision: Decision; write: WriteResult; run_id: string }>(`/decisions/${d.decision_id}/approve`, { method: "POST", body: JSON.stringify({ reason }) });
      setView({ kind: "decision", d: r.decision, write: r.write });
      await loadTrace(r.run_id, true);
      markDone("step-review"); setActive(3);
      toast(<><b>Approved.</b> Now try step 3: apply a data change and see which decisions reopen.</>);
    } finally { loadDecisions(); }
  };
  const reject = async (d: Decision) => {
    await api(`/decisions/${d.decision_id}/reject`, { method: "POST" }).catch((e: Error) => toast(e.message));
    await openDecision(d.decision_id);
  };

  useEffect(() => {
    (async () => {
      let list = (await api<Supplier[]>("/suppliers").catch(() => [] as Supplier[])).map((s) => ({ ...s, short: titleCase(s.name) || s.supplier_id }));
      if (!list.length) list = Array.from({ length: 20 }, (_, i) => ({ supplier_id: `SUP-${String(i + 1).padStart(2, "0")}`, short: "" }));
      setSuppliers(list); setSup(list);
      const want = new URLSearchParams(location.search).get("supplier");
      const first = want && list.some((x) => x.supplier_id === want) ? want : "SUP-18";
      setSupplier(first); supplierRef.current = first;
      const decs = await loadDecisions();
      api<ChangeCard[]>("/changes/catalog").catch(() => null)
        .then(async (cat) => cat ?? (await api<string[]>("/changes").catch(() => [] as string[])).map((f) => ({ file: f, description: f })))
        .then(setChanges);
      if (decs.length) setActive(decs.some((d) => d.status === "approved") ? 3 : 2);
      const q = new URLSearchParams(location.search);
      if (q.get("run") === "1") decide(q.get("supplier") === "SUP-06");
      else startTour();
    })();
  }, []);

  const showBar = view.kind === "decision" && view.d.status === "proposed" ? view.d : null;
  const dlist = decisions ?? [];
  const step = (id: StepId, n: number) => ({ id, n, active: active === n, done: done.has(id) });

  let centre: ReactNode;
  switch (view.kind) {
    case "start": centre = <StartView running={running} onPick={pick} />; break;
    case "skeleton": centre = <><div className="skel l1" /><div className="skel l3" /><div className="skel l2" /><div className="skel l3" /><div className="skel l2" /><div className="skel l2" /></>; break;
    case "run": centre = <RunView title={view.title} sub={view.sub} kind={view.runKind} events={trace.events} />; break;
    case "decision": centre = <DecisionView d={view.d} write={view.write} />; break;
    case "error": centre = <div className="banner bad"><Ic n="warn" /><div>{view.msg}</div></div>; break;
    case "runFailed": centre = <div className="banner bad"><Ic n="warn" /><div><b>The run failed.</b> {view.msg}<div style={{ marginTop: 8 }}><button className="btn sm" id="retry" type="button" onClick={() => decide(view.thenChange)}>Try again</button></div></div></div>; break;
    case "nothing": centre = (
      <div className="start"><div className="banner ok done-anim"><DoneMark /><div><b>Nothing reopened.</b> {view.total ? `The change was checked against ${view.total} active decision${view.total === 1 ? "" : "s"} and crossed no tripwire, so no work was redone.` : "No decision exists yet, so there was nothing to check. Make a decision first."}</div></div>
        <p className="muted" style={{ marginTop: 14 }}>See the breakdown under step 3 on the left, and every step the Watcher took in the trace.</p></div>
    ); break;
  }

  return (
    <>
      <main className="console">
        <ol className="stepper" aria-label="Three steps">
          <Step {...step(STEPS[0], 1)} title="Make a decision">
            <SupplierStep suppliers={suppliers} value={supplier} swapN={supSwap} decisions={dlist} running={running}
              onChange={(id) => { setSupplier(id); setSupSwap((n) => n + 1); }} onDecide={() => decide()} onPick={pick} />
          </Step>
          <Step {...step(STEPS[1], 2)} title="Review and approve" count={dlist.filter((d) => d.status !== "superseded" && d.status !== "rejected").length}>
            <DecisionList decisions={decisions} selected={sel} onOpen={openDecision} />
          </Step>
          <Step {...step(STEPS[2], 3)} title="Change the data">
            <ChangeList changes={changes} report={report} stage={watcherStage(trace.events.map((e) => e.action))} applying={applying} applied={applied}
              suggest={suggest} pulse={pulse} running={running} onApply={applyChange} onOpen={openDecision} />
          </Step>
        </ol>
        <section className="panel enter" style={{ "--i": 1 } as React.CSSProperties} id="detail" aria-live="polite" key={swapN}>{centre}</section>
        <TracePanel trace={trace} live={live} />
      </main>
      {showBar && <ActionBar key={showBar.decision_id} d={showBar} onApprove={(r) => approve(showBar, r)} onReject={() => reject(showBar)} />}
      {toastMsg && <Toast key={toastMsg.n} ms={toastMsg.ms} onGone={() => setToast((t) => (t?.n === toastMsg.n ? null : t))}>{toastMsg.node}</Toast>}
    </>
  );
}
