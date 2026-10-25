// The three steps (pick a supplier, review decisions, change the data): rail pieces on the left, the change board in the middle.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CountUp, Empty, Ring, Spin } from "./bits";
import { cap, fmtField, pct } from "./format";
import { Ic, Play, type IconName } from "./icons";
import { FIELD, LABEL, WATCHER_STEPS } from "./labels";
import { decName, initials, rowName, rowTip, sup, supName } from "./names";
import { wireText } from "./plain";
import type { ChangeOp } from "./App";
import type { ChangeCard, ChangeField, ChangeReport, Decision, Supplier, WhatIf } from "./types";

const live = (d: Decision) => d.status !== "superseded" && d.status !== "rejected";

const Check = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>;

/** One step of the rail. Only open steps show their body; closed ones fold to a one-line summary, so the rail stays short. */
export function Step({ id, n, title, active, done, open, summary, count, onToggle, children }: {
  id: string; n: number; title: string; active: boolean; done: boolean; open: boolean; summary: ReactNode; count?: number; onToggle: () => void; children: ReactNode;
}) {
  return (
    <li className={`step${active ? " active" : ""}${done ? " done" : ""}${open ? " open" : ""}`} id={id}>
      <span className="node"><span>{n}</span><Check /></span>
      <section className="step-card enter" style={{ "--i": n - 1 } as React.CSSProperties} aria-labelledby={`h${n}`}>
        <button className="step-h" type="button" aria-expanded={open} aria-controls={`b${n}`} onClick={onToggle}>
          <h2 id={`h${n}`}>{title}</h2>{count != null && <span className="count" id="dcount">{count}</span>}
          <span className="chip" data-chip>{active ? "Now" : done ? "Done" : "Next"}</span><Ic n="chev" />
        </button>
        {open ? <div className="step-b" id={`b${n}`}>{children}</div> : <div className="step-sum">{summary}</div>}
      </section>
    </li>
  );
}

// ---------- Step 1 ----------
function SupplierCard({ id, decisions, swap }: { id: string; decisions: Decision[]; swap: boolean }) {
  const x = sup(id);
  const prior = decisions.find((d) => d.subject_id === id && live(d));
  const cat = x?.category ? String(x.category).replace(/_/g, " ") : "";
  const [w, setW] = useState(0);
  useEffect(() => { const f = requestAnimationFrame(() => setW(Math.min(100, (x?.spend_share ?? 0) * 100))); return () => cancelAnimationFrame(f); }, [x?.spend_share]);
  return (
    <div className={`sup-card${swap ? " swap" : ""}`} id="sup-meta">
      <div className="sc-head">
        <span className="avatar">{initials(id)}</span>
        <div className="sc-id"><span className="nm">{x?.short || id}</span><span className="mt"><span className="mono">{id}</span>{x?.ticker && <><span className="dotsep" /><span tabIndex={0} data-tip="Stock ticker">{x.ticker}</span></>}</span>{cat && <span className="cat" tabIndex={0} data-tip="Purchase category this supplier sells us">{cat}</span>}</div>
      </div>
      {typeof x?.spend_share === "number" && <div className="sc-stats">
        <div className="stat share"><span className="k term" tabIndex={0} data-tip="Of everything we spend in this category, how much goes to this supplier (synthetic data). Above 25% counts as heavy dependence.">Share of category spend</span><b>{pct(x.spend_share)}</b><span className="bar"><i style={w ? { width: `${w}%` } : undefined} /><em style={{ left: "25%" }} title="25%: heavy-dependence line" /></span></div>
        {typeof x.lead_time_weeks === "number" && <div className="stat"><span className="k term" tabIndex={0} data-tip="Weeks from placing an order to delivery. 12 weeks or more makes switching slow.">Lead time</span><b>{x.lead_time_weeks} wk</b></div>}
      </div>}
      {prior && <div className="prior"><span>Already decided</span><span className={`verdict ${prior.decision}`}>{LABEL[prior.decision] ?? prior.decision}</span><span className={`st ${prior.status}`}>{prior.status}</span></div>}
    </div>
  );
}

export function SupplierStep({ suppliers, value, swapN, decisions, running, onChange, onDecide, onPick }: {
  suppliers: Supplier[] | null; value: string; swapN: number; decisions: Decision[]; running: boolean;
  onChange: (id: string) => void; onDecide: () => void; onPick: (id: string, thenChange: boolean) => void;
}) {
  return (
    <>
      <p className="hint">Pick a supplier. Six agents read its data and propose what to do.</p>
      <label className="field" htmlFor="supplier">Supplier</label>
      <select className="input" id="supplier" value={value} onChange={(e) => onChange(e.target.value)}>
        {suppliers ? suppliers.map((x) => <option key={x.supplier_id} value={x.supplier_id}>{x.supplier_id} · {x.short}</option>) : <option>Loading suppliers…</option>}
      </select>
      {suppliers ? <SupplierCard key={`${value}-${swapN}`} id={value} decisions={decisions} swap={swapN > 0} />
        : <div className="sup-card" id="sup-meta"><div className="skel avatar" /><div className="skel" style={{ height: 14 }} /><div className="skel" style={{ height: 10, width: "60%" }} /></div>}
      <button className={`btn primary full${running ? " running" : ""}`} id="decide" type="button" disabled={running} onClick={onDecide}>{running ? <><Spin />Agents working…</> : <><Play />Decide</>}</button>
      <div className="try">Try:<button type="button" data-q="SUP-18" disabled={running} onClick={() => onPick("SUP-18", false)}>Risky</button><button type="button" data-q="SUP-17" disabled={running} onClick={() => onPick("SUP-17", false)}>Healthy</button><button type="button" data-q="SUP-06" data-then="change" disabled={running} onClick={() => onPick("SUP-06", true)}>Tripwire test</button></div>
    </>
  );
}

// ---------- Step 2 ----------
export function DecisionList({ decisions, selected, onOpen }: { decisions: Decision[] | null; selected: string | null; onOpen: (id: string) => void }) {
  return (
    <>
      <p className="hint">Open a decision to read why. Nothing is final until you approve it.</p>
      <div className="dlist" id="decisions">
        {!decisions ? <><div className="skel dk" /><div className="skel dk" /></>
          : decisions.length ? decisions.map((d, i) => {
            const conf = Math.round((d.confidence ?? 0) * 100);
            return (
              <button key={d.decision_id} className={`dcard enter ${d.decision}${d.decision_id === selected ? " sel" : ""}${live(d) ? "" : " old"}`} style={{ "--i": Math.min(i, 8) } as React.CSSProperties} data-id={d.decision_id} type="button" onClick={() => onOpen(d.decision_id)}>
                <span className="who">{supName(d.subject_id)}<small>{d.subject_id}</small></span>
                <span className="mini-ring" title={`${conf}% confident`}><Ring v={conf} />{conf}%</span>
                <span className="tags"><span className={`verdict ${d.decision}`}>{LABEL[d.decision] ?? d.decision}</span><span className={`st ${d.status}`}>{d.status}</span>{d.escalated && <span className="st esc">escalated</span>}</span>
              </button>
            );
          }) : <Empty>No decisions yet. Make one in step 1.</Empty>}
      </div>
    </>
  );
}

// ---------- Step 3 ----------
export const changeName = (file: string) => file.replace(/\.json$/, "").replace(/^\d+_/, "").replace(/_/g, " ");

function Deltas({ fields, owner }: { fields: (ChangeField & { supplier_id?: string })[]; owner?: string }) {
  const shown = fields.filter((f) => f.before !== f.after).slice(0, 4);
  if (!shown.length) return null;
  return <div className="deltas">{shown.map((f, j) => <div className="delta" key={j}><span className="l">{FIELD[f.field] ?? f.field.replace(/_/g, " ")}{f.supplier_id && owner && f.supplier_id !== owner && <small> · {supName(f.supplier_id)}</small>}</span><s>{fmtField(f.field, f.before)}</s><span className="arr">→</span><b>{fmtField(f.field, f.after)}</b></div>)}</div>;
}

function ChangeItem({ c, i, applying, suggest, pulse, disabled, onApply }: { c: ChangeCard; i: number; applying: boolean; suggest: boolean; pulse: boolean; disabled: boolean; onApply: () => void }) {
  const [open, setOpen] = useState(false);
  const name = changeName(c.file);
  const about = cap(String(c.description).replace(/^SYNTHETIC:\s*/i, "").replace(/\s*Figures from (https?:\S+)/, ""));
  const who = c.supplier_id || (c.table === "supplier_spend" ? c.key : null);
  return (
    <div className={`ccard enter${suggest ? " suggest" : ""}${pulse ? " pulse-once" : ""}`} style={{ "--i": i } as React.CSSProperties} data-card={c.file}>
      <span className="cc-ico"><Ic n={changeIcon(c)} /></span>
      <div className="cc-t">{cap(name)}<span className={`tg ${c.synthetic ? "synthetic" : "real"}`} data-tip={c.synthetic ? "A made-up change to synthetic spend data, to show the mechanism." : "Based on a real SEC filing."} tabIndex={0}>{c.synthetic ? "synthetic" : "real filing"}</span></div>
      <div className="cc-who">{who && <><b>{supName(who)}</b><span className="mono">{who}</span></>}{c.table && <span className="watch" data-tip={`The exact data row this change rewrites (${rowTip(c.table, c.key!)}). Only decisions that read this row are checked.`} tabIndex={0}><Ic n="db" />{rowName(c.table, c.key!)}</span>}</div>
      <Deltas fields={c.fields || []} />
      <div className="cc-foot"><details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}><summary>Details</summary></details>
        <button className="btn sm primary" data-f={c.file} type="button" disabled={disabled || !!c.in_data} onClick={onApply}
          title={c.in_data ? "These values are already in the data. Reset the demo data to apply it again." : undefined}>{applying ? <><Spin />Applying</> : c.in_data ? <><Ic n="check" />In the data</> : "Apply"}</button></div>
      <p className="cc-about" hidden={!open}>{about}</p>
    </div>
  );
}

const whatIfIcon = (w: WhatIf): IconName => w.kind === "lead_time" ? "clock" : w.kind === "weak_quarter" || w.kind === "downturn" ? "file" : "trend";

function WhatIfItem({ w, i, applying, suggest, pulse, disabled, onApply }: { w: WhatIf; i: number; applying: boolean; suggest: boolean; pulse: boolean; disabled: boolean; onApply: () => void }) {
  const [open, setOpen] = useState(false);
  const rows = [...new Map(w.fields.map((f) => [`${f.table}\u0000${f.key}`, f])).values()];
  return (
    <div className={`ccard enter${suggest ? " suggest" : ""}${pulse ? " pulse-once" : ""}${w.available ? "" : " off"}`} style={{ "--i": i } as React.CSSProperties} data-card={w.id}>
      <span className="cc-ico"><Ic n={whatIfIcon(w)} /></span>
      <div className="cc-t">{w.title}<span className="tg synthetic" data-tip="Computed from this supplier's current data. Not a real filing or order." tabIndex={0}>what-if</span></div>
      <div className="cc-who">{rows.map((f) => <span key={`${f.table}${f.key}`} className="watch" data-tip={`A data row this change rewrites (${rowTip(f.table, f.key)}).`} tabIndex={0}><Ic n="db" />{rowName(f.table, f.key)}</span>)}</div>
      {w.available ? <Deltas fields={w.fields} owner={w.supplier_id} /> : <p className="muted cc-off">Not available: {w.reason}.</p>}
      <div className="cc-foot">{w.available && <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}><summary>Details</summary></details>}
        <button className="btn sm primary" data-f={w.id} type="button" disabled={disabled || !w.available} onClick={onApply}>{applying ? <><Spin />Applying</> : "Apply"}</button></div>
      <p className="cc-about" hidden={!open}>{cap(w.description.replace(/^SYNTHETIC what-if:\s*/i, ""))}</p>
    </div>
  );
}

/** Puts every table back to the bundled sample. Asks once inline, as it can reopen decisions too. */
function ResetData({ running, applying, onReset }: { running: boolean; applying: boolean; onReset: () => void }) {
  const [ask, setAsk] = useState(false);
  return (
    <div className="reset" id="reset-data">
      {ask ? <><span>Put the spend and financials tables back to the bundled sample? Decisions that read a restored row are re-checked.</span>
        <button className="btn sm" type="button" disabled={running} onClick={() => { setAsk(false); onReset(); }}>Reset</button>
        <button className="btn sm ghost" type="button" onClick={() => setAsk(false)}>Cancel</button></>
        : <button className="btn sm ghost" type="button" disabled={running} onClick={() => setAsk(true)}>{applying ? <><Spin />Resetting</> : "Reset demo data"}</button>}
    </div>
  );
}

export type ReportState = null | { kind: "working" } | { kind: "done"; reports: ChangeReport[]; snapshot: Decision[] } | { kind: "error"; msg: string };

function WatcherSteps({ stage }: { stage: number }) {
  return <div className="wsteps">{WATCHER_STEPS.map((t, i) => <div key={i} className={i < stage ? "ok" : i === stage ? "on" : ""}><i />{t}</div>)}</div>;
}

function ReportCard({ x, snapshot, onOpen }: { x: ChangeReport; snapshot: Decision[]; onOpen: (id: string) => void }) {
  const dep = new Set(x.dependents.map((d) => (typeof d === "string" ? d : d.decision_id)));
  const fired = new Set(x.reopened.map((o) => o.old));
  const dots = snapshot.filter((d) => live(d) || fired.has(d.decision_id));
  const n = Math.max(x.active, dots.length);
  return (
    <div className="wr">
      <div className="wr-h"><Ic n="db" /><span>Changed: <b tabIndex={0} data-tip={rowTip(x.changed.table, x.changed.key)}>{rowName(x.changed.table, x.changed.key)}</b></span></div>
      {n > 0 && <><div className="dots">{Array.from({ length: n }, (_, i) => {
        const d = dots[i], id = d?.decision_id;
        return <span key={i} style={{ "--i": i } as React.CSSProperties} className={id && fired.has(id) ? "fire" : id && dep.has(id) ? "dep" : ""} title={id ? `${supName(d.subject_id)}'s decision (${LABEL[d.decision] ?? d.decision})` : "decision"} />;
      })}</div><div className="dots-legend"><span><i />left alone</span><span><i className="dep" />depends, still holds</span><span><i className="fire" />tripwire fired</span></div></>}
      <div className="tiles">
        <div className="tile" data-tip="Active decisions that read the changed row." tabIndex={0}><CountUp to={x.dependents.length} ms={800} /><span>of {x.active} {x.dependents.length === 1 ? "depends" : "depend"} on it</span></div>
        <div className={`tile${x.reopened.length ? " hot" : ""}`} data-tip="Dependent decisions whose tripwire fired." tabIndex={0}><CountUp to={x.reopened.length} ms={800} /><span>reopened</span></div>
        <div className="tile" data-tip="Active decisions not re-run because the change could not affect them, or no tripwire fired." tabIndex={0}><CountUp to={x.work_saved} ms={800} /><span>left alone</span></div>
      </div>
      {x.reopened.map((o, i) => <div className="rline fired" key={i}><b>Tripwire fired.</b> {decName(o.old)} reopened → <a href="#" data-id={o.new.decision_id} onClick={(e) => { e.preventDefault(); onOpen(o.new.decision_id); }}>new decision: {LABEL[o.new.decision] ?? o.new.decision}</a><ul>{o.fired.map((f, j) => <li key={j}>{cap(wireText(f))}</li>)}</ul></div>)}
      {x.still_valid.map((v, i) => <div className="rline" key={i}><b>Still holds.</b> {decName(v.decision_id)} depends on this row, but no tripwire fired.{(v.checked || []).length > 0 && <ul>{v.checked!.map((c, j) => <li key={j}>{typeof c === "string" ? cap(wireText(c)) : JSON.stringify(c)}</li>)}</ul>}</div>)}
      {!x.dependents.length && <div className="rline">No active decision depends on this row, so nothing was re-run.{x.active ? "" : " Make a decision first to see the Watcher at work."}</div>}
    </div>
  );
}

const changeIcon = (c: ChangeCard): IconName => c.table === "supplier_financials" ? "file" : /lead/.test(c.file) ? "clock" : "trend";

/** Step 3 in the rail: one short row per change. The cards themselves open in the middle. */
export function ChangeRail({ changes, whatifs, supplier, applying, suggest, report, onOpen }: {
  changes: ChangeCard[] | null; whatifs: WhatIf[] | null; supplier: string; applying: string | null; suggest: string | null; report: ReportState; onOpen: (key?: string) => void;
}) {
  const last = report?.kind === "done" ? report.reports.reduce((n, x) => n + x.reopened.length, 0) : null;
  const row = (key: string, icon: IconName, title: string, small: string | null, end: ReactNode) => (
    <button key={key} type="button" className={`crow${suggest === key ? " suggest" : ""}`} data-card={key} onClick={() => onOpen(key)}>
      <Ic n={icon} /><span className="cr-t">{title}{small && <small>{small}</small>}</span>{applying === key ? <Spin /> : end}
    </button>
  );
  const go = <Ic n="chev" className="cr-go" />;
  return (
    <>
      <p className="hint">Change data rows. Only decisions that read them are checked.</p>
      <div className="crail" id="changes">
        <div className="crail-h">What could change for {supName(supplier)}</div>
        {!whatifs ? <div className="skel" style={{ height: 36 }} />
          : whatifs.filter((w) => w.available).map((w) => row(w.id, whatIfIcon(w), w.title, null, go))}
        <div className="crail-h">Bundled changes</div>
        {!changes ? <><div className="skel" style={{ height: 36 }} /><div className="skel" style={{ height: 36 }} /></>
          : changes.length ? changes.map((c) => {
            const who = c.supplier_id || (c.table === "supplier_spend" ? c.key : null);
            return row(c.file, changeIcon(c), cap(changeName(c.file)), who ? supName(who) : null, c.in_data ? <span className="cr-ok"><Ic n="check" />In the data</span> : go);
          }) : <Empty>No change files found.</Empty>}
      </div>
      {last != null && <button type="button" className="linkish" onClick={() => onOpen()}>Last result: {last ? `${last} reopened` : "nothing reopened"}. See the report</button>}
    </>
  );
}

/** What the person can do after a result, so a finished step never looks like a dead end. */
export function NextSteps({ title = "What next", items }: { title?: string; items: { icon: IconName; label: string; sub: string; on: () => void; id?: string }[] }) {
  return (
    <div className="next" id="next-steps">
      <div className="eyebrow">{title}</div>
      <div className="next-grid">
        {items.map((x) => <button key={x.label} type="button" className="next-card" id={x.id} onClick={x.on}><span className="qi"><Ic n={x.icon} /></span><b>{x.label}</b><span>{x.sub}</span><Ic n="arrow" className="go" /></button>)}
      </div>
    </div>
  );
}

/** The middle view for step 3: the latest Watcher report first, then what-ifs for the chosen supplier, then the bundled changes. */
export function ChangesBoard({ changes, whatifs, suppliers, supplier, report, stage, applying, suggest, pulse, running, next, onRun, onOpen, onSupplier }: {
  changes: ChangeCard[] | null; whatifs: WhatIf[] | null; suppliers: Supplier[] | null; supplier: string; report: ReportState; stage: number; applying: string | null;
  suggest: string | null; pulse: Set<string>; running: boolean; next: ReactNode; onRun: (op: ChangeOp) => void; onOpen: (id: string) => void; onSupplier: (id: string) => void;
}) {
  const done = report?.kind === "done" ? report : null;
  const reopened = done ? done.reports.reduce((n, x) => n + x.reopened.length, 0) : 0;
  const checked = done ? done.reports.reduce((n, x) => n + x.active, 0) : 0;
  return (
    <div className="board">
      <div className="eyebrow">Step 3 · Change the data</div>
      <h2>{done ? (reopened ? `${reopened} decision${reopened === 1 ? "" : "s"} reopened` : "Nothing reopened") : "Pick a change to apply"}</h2>
      <p className="muted lead">{done
        ? reopened ? "A tripwire fired, so only the affected decision was re-run. The old one is marked superseded." : checked ? `The change was checked against ${checked} active decision${checked === 1 ? "" : "s"} and crossed no tripwire, so no work was redone.` : done.reports.length ? "No decision exists yet, so there was nothing to check. Make a decision first." : "No data row changed, so there was nothing to check."
        : "Each change rewrites specific data rows. The Watcher then asks memory which decisions read those rows, and re-checks only their tripwires."}</p>
      <div className="report" id="report" aria-live="polite">
        {report?.kind === "working" && <div className="wr"><div className="wr-h"><span dangerouslySetInnerHTML={{ __html: window.TW.LOADER.replace("tw-loader", "tw-loader sm") }} style={{ display: "contents" }} /><b>Watcher at work</b></div><div id="wsteps"><WatcherSteps stage={stage} /></div></div>}
        {done && done.reports.map((x, i) => <ReportCard key={i} x={x} snapshot={done.snapshot} onOpen={onOpen} />)}
        {report?.kind === "error" && <div className="banner bad"><Ic n="warn" /><div>{report.msg}</div></div>}
      </div>
      {done && next}
      <div className="board-sub-row">
        <div className="eyebrow board-sub">What could change for</div>
        <select className="input sm" aria-label="Supplier for what-if changes" value={supplier} disabled={running} onChange={(e) => onSupplier(e.target.value)}>
          {(suppliers ?? []).map((x) => <option key={x.supplier_id} value={x.supplier_id}>{x.supplier_id} · {x.short}</option>)}
        </select>
      </div>
      <p className="muted small">Computed from {supName(supplier)}'s current rows, so each one moves the numbers again if you apply it twice.</p>
      <div className="clist">
        {!whatifs ? <><div className="skel dk" /><div className="skel dk" /></>
          : whatifs.length ? whatifs.map((w, i) => <WhatIfItem key={w.id} w={w} i={i} applying={applying === w.id} suggest={suggest === w.id} pulse={pulse.has(w.id)} disabled={running} onApply={() => onRun({ kind: "whatif", w })} />)
          : <Empty>No what-ifs for this supplier.</Empty>}
      </div>
      <div className="eyebrow board-sub">Bundled changes</div>
      <p className="muted small">Fixed edits to one supplier each. Once one is in the data, applying it again would change nothing.</p>
      <div className="clist">
        {!changes ? <><div className="skel dk" /><div className="skel dk" /><div className="skel dk" /></>
          : changes.length ? changes.map((c, i) => <ChangeItem key={c.file} c={c} i={i} applying={applying === c.file} suggest={suggest === c.file} pulse={pulse.has(c.file)} disabled={running} onApply={() => onRun({ kind: "file", file: c.file })} />)
          : <Empty>No change files found.</Empty>}
      </div>
      <ResetData running={running} applying={applying === "reset"} onReset={() => onRun({ kind: "reset" })} />
    </div>
  );
}

/** Which Watcher step the trace has reached so far. */
export const watcherStage = (actions: (string | undefined)[]) => actions.includes("check_tripwires") ? (actions.includes("plan") ? 3 : 2) : actions.includes("lineage_lookup") ? 1 : 0;

// ---------- Toast ----------
export function Toast({ children, ms, onGone }: { children: ReactNode; ms: number; onGone: () => void }) {
  const [out, setOut] = useState(false);
  const gone = useRef(onGone); gone.current = onGone;
  useEffect(() => { const t = setTimeout(() => setOut(true), ms); return () => clearTimeout(t); }, []);
  useEffect(() => { if (!out) return; const t = setTimeout(() => gone.current(), 250); return () => clearTimeout(t); }, [out]);
  return <div className={`toast${out ? " out" : ""}`} role="status"><div>{children}</div><button type="button" aria-label="Dismiss" onClick={() => setOut(true)}>×</button></div>;
}
