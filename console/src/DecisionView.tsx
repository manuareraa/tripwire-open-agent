// Centre panel: one decision, explained.
import { Fragment, useEffect, useRef } from "react";
import { smooth } from "./api";
import { Empty, Info, Ring } from "./bits";
import { cap, fmtMetric, plural } from "./format";
import { Ic, VICON } from "./icons";
import { GROUP, LABEL, METRIC, METRIC_TIP, OP, TIP, VERB } from "./labels";
import { decName, initials, rowName, rowTip, supName, tplName } from "./names";
import { readReasons, writeText } from "./plain";
import type { Decision, Tripwire, WriteResult } from "./types";

const evidenceFor = (d: Decision, metric: string) => (d.findings || []).find((f) => f.metric === metric && typeof f.value === "number");

function Gauge({ t, d }: { t: Tripwire; d: Decision }) {
  const name = METRIC[t.metric]?.[0] ?? t.metric.replace(/_/g, " ");
  const hasTh = t.threshold != null && t.op !== "changed";
  const f = evidenceFor(d, t.metric);
  let track = null, gap = "";
  if (f && typeof t.threshold === "number" && t.op !== "changed") {
    const cur = f.value as number, th = t.threshold;
    const share = METRIC[t.metric]?.[1] === "share";
    const lo = Math.min(0, cur, th), hi = share ? Math.max(1, cur, th) : Math.max(cur, th) * 1.35 || 1;
    const p = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    const below = t.op === "<" || t.op === "<=";
    const zone = below ? { left: 0, width: `${p(th)}%` } : { left: `${p(th)}%`, right: 0 };
    track = (
      <div className="track"><span className="base" /><span className="zone" style={zone} />
        <span className="th" style={{ left: `${p(th)}%` }} data-l={`trips at ${fmtMetric(t.metric, th)}`} />
        <span className="cur" style={{ left: `${p(cur)}%` }} data-l={`now ${fmtMetric(t.metric, cur)}`} /></div>
    );
    gap = `${fmtMetric(t.metric, Math.abs(cur - th)).replace(/^-/, "")} away`;
  } else if (f) gap = `now ${fmtMetric(t.metric, f.value)}`;
  const rows = (t.depends_on || []).map((r) => rowName(r.table, r.key)).join(" or ") || "its source data";
  const tip = `If ${rows} changes and ${METRIC[t.metric]?.[0]?.toLowerCase() ?? "this value"} ${OP[t.op] ?? t.op}${hasTh ? ` ${fmtMetric(t.metric, t.threshold)}` : ""}, the Watcher reopens this decision.${f ? ` It is ${fmtMetric(t.metric, f.value)} now.` : ""} ${METRIC_TIP[t.metric] ?? ""}`;
  return (
    <div className="gauge">
      <div className="g-t"><Ic n="wire" /><span className="term-ish" tabIndex={0} data-tip={tip.trim()}><b>{name}</b> {OP[t.op] ?? t.op}{hasTh && <> <b>{fmtMetric(t.metric, t.threshold)}</b></>}</span><span className="gap" tabIndex={0} data-tip="How far the current value is from the line that fires this tripwire.">{gap}</span></div>
      {track}
      <div className="rows"><Ic n="db" />Watches {(t.depends_on || []).length ? (t.depends_on || []).map((r, i) => <Fragment key={i}>{i > 0 && ", "}<span tabIndex={0} data-tip={rowTip(r.table, r.key)}>{rowName(r.table, r.key)}</span></Fragment>) : "its source rows"}</div>
    </div>
  );
}

/** The escalation reasons as readable rows: what was measured, its value, the policy line and what it means. */
function EscPanel({ d }: { d: Decision }) {
  const flags = readReasons(d.escalation_reasons);
  const groups = (Object.keys(GROUP) as (keyof typeof GROUP)[]).map((g) => [g, flags.filter((f) => f.group === g)] as const).filter(([, l]) => l.length);
  return (
    <section className="esc-panel enter" aria-label="Why this was escalated">
      <div className="esc-h"><span className="esc-ic"><Ic n="warn" /></span><div><b>Escalated: a senior buyer must sign off</b> <Info k="escalated" />
        <p>{flags.length ? `The Risk Officer found ${plural(flags.length, "reason")} in code. Each value is compared with a fixed policy line.` : "This decision needs a senior buyer's sign-off."}</p></div></div>
      {groups.map(([g, list]) => (
        <div className="esc-g" key={g}><div className="esc-gh">{GROUP[g]}</div>{list.map((f, i) => (
          <div className="flag" key={i}>
            <div className="f-l"><b>{f.name}</b>{f.meaning && <span>{f.meaning}</span>}</div>
            {f.value && <div className="f-r"><b>{f.value}</b>{f.rule && <span>{cap(f.rule)}</span>}</div>}
          </div>))}</div>
      ))}
    </section>
  );
}

export const DoneMark = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="m7 12.5 3.2 3.2L17 9" /></svg>;

export function DecisionView({ d, write }: { d: Decision; write?: WriteResult }) {
  const conf = Math.round((d.confidence ?? 0) * 100);
  const fallback = /^Rule-based policy/i.test(d.rationale || "");
  const risk = String(d.risk || "").toLowerCase();
  const segs = ({ low: 1, medium: 2, high: 3 } as Record<string, number>)[risk] ?? 0;
  const why = String(d.rationale || "");
  const m = why.match(/^(.+?[.!?])(\s|$)/);
  const watched = new Set((d.tripwires || []).map((t) => t.metric));
  const nums = (d.findings || []).map((f, i) => ({ f, i })).filter(({ f }) => typeof f.value === "number" && f.metric);
  const confEl = useRef<HTMLElement>(null);
  useEffect(() => { window.TW.countUp(confEl.current, conf, { ms: 1000, fmt: (v) => `${Math.round(v)}%` }); }, []);

  const proof = (i: number) => {
    const ev = document.getElementById("ev") as HTMLDetailsElement, row = document.getElementById(`ev-${i}`) as HTMLDetailsElement;
    ev.open = true; row.open = true;
    row.scrollIntoView({ block: "center", behavior: smooth() });
    row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 1400);
  };

  return (
    <>
      <div className={`hero-card ${d.decision}`}>
        <div>
          <div className="hc-sup"><span className="avatar">{initials(d.subject_id)}</span><b>{supName(d.subject_id)}</b><span className="mono">{d.subject_id}</span></div>
          <div className="hc-verdict"><span className="vi"><Ic n={VICON[d.decision] ?? "check"} /></span><div><div className="eyebrow">Recommendation</div><div className={`verdict ${d.decision}`}>{LABEL[d.decision] ?? d.decision}</div></div></div>
          <div className="hc-verb">{VERB[d.decision] ?? ""}</div>
        </div>
        <div className="hc-side">
          <div className="gstat" tabIndex={0} data-tip={TIP.confidence}><div className="ring"><Ring v={conf} /><div className="lbl"><b ref={confEl}>{conf}%</b></div></div><span className="cap">Confidence</span></div>
          <div className={`riskm ${risk}`} tabIndex={0} data-tip={TIP.risk}><span>Risk</span><b>{risk || "?"}</b><span className="segs">{[0, 1, 2].map((i) => <i key={i} className={i < segs ? "f" : ""} style={{ "--i": i } as React.CSSProperties} />)}</span></div>
        </div>
        <div className="hc-meta">
          <span className={`st ${d.status}`} tabIndex={0} data-tip={TIP.status}>{d.status}</span>
          {fallback && <span className="pill fallback" tabIndex={0} data-tip="No model was available for this run, so a simple rule-based policy decided. It is labelled, never passed off as a model answer."><span className="dot" />rule-based fallback</span>}
          {d.supersedes && <span className="pill" tabIndex={0} data-tip={`This decision was reopened by a tripwire and replaces an earlier one (${d.supersedes}).`}>replaces {decName(d.supersedes)}</span>}
          <span className="id" tabIndex={0} data-tip="Decision ID, as stored in the ledger.">{d.decision_id}</span>
        </div>
      </div>
      {d.escalated && <EscPanel d={d} />}

      <div className="sec"><div className="sec-h"><h3>Why</h3><span className="line" /></div>
        <p className="why">{m && m[1].length < 180 ? <><b>{m[1]}</b>{why.slice(m[1].length)}</> : why}</p>
        {d.summary && <details className="more"><summary>Read the Analyst's summary</summary><p>{d.summary}</p></details>}
      </div>

      {nums.length > 0 && <div className="sec"><div className="sec-h"><h3>Key numbers</h3><Info k="evidence" /><span className="line" /></div>
        <div className="nums">{nums.map(({ f, i }, k) => (
          <button key={i} className="num enter" style={{ "--i": k } as React.CSSProperties} type="button" onClick={() => proof(i)}
            data-tip={`${METRIC_TIP[f.metric!] ?? f.claim}${watched.has(f.metric!) ? " A tripwire watches this number." : ""} Click to see the query and its exact result.`}>
            {watched.has(f.metric!) && <span className="w"><Ic n="wire" /></span>}<span className="v">{fmtMetric(f.metric, f.value)}</span><span className="l">{METRIC[f.metric!]?.[0] ?? f.metric!.replace(/_/g, " ")}</span><span className="src">From {tplName(f.evidence?.template_id || "")} · show proof</span>
          </button>))}</div>
      </div>}

      <div className="sec"><div className="sec-h"><h3>Tripwires: reopen if…</h3><Info k="tripwire" /><span className="line" /></div>
        <div className="gauges">{(d.tripwires || []).length ? (d.tripwires || []).map((t, i) => <Gauge key={i} t={t} d={d} />) : <Empty>No tripwires.</Empty>}</div>
      </div>

      <div className="sec">
        <details className="ev" id="ev"><summary><Ic n="chev" />Evidence behind every number<span className="muted">{plural((d.findings || []).length, "finding")}, each with its SQL query and result fingerprint</span></summary>
          <div className="ev-list">{(d.findings || []).length ? (d.findings || []).map((f, i) => (
            <details className="ev-row" id={`ev-${i}`} key={i}><summary><span>{f.claim}</span><span className="q">{cap(tplName(f.evidence?.template_id))}</span></summary>
              <div className="body">
                <pre>{f.evidence?.sql}</pre>
                <div className="ev-meta"><span tabIndex={0} data-tip="A fingerprint (SHA-256 hash) of the exact query result. Re-running the query on unchanged data gives the same fingerprint; any change to the data gives a different one.">Result fingerprint <code>{(f.evidence?.result_hash || "").slice(0, 12)}</code></span>
                  {(f.evidence?.depends_on || []).length > 0 && <span>Reads {f.evidence!.depends_on!.map((r, j) => <Fragment key={j}>{j > 0 && ", "}<b tabIndex={0} data-tip={rowTip(r.table, r.key)}>{rowName(r.table, r.key)}</b></Fragment>)}</span>}</div>
              </div></details>)) : <Empty>No findings recorded.</Empty>}</div>
        </details>
      </div>

      {(d.limitations || []).length > 0 && <div className="sec"><div className="sec-h"><h3>Limitations</h3><span className="line" /></div><ul className="lim">{d.limitations!.map((l, i) => <li key={i}>{l}</li>)}</ul></div>}

      {d.status === "proposed"
        ? <div className="await" tabIndex={0} data-tip="Approve or reject in the bar fixed to the bottom of the screen."><Ic n="person" /><span><b>Waiting for your call.</b> Approve or reject it in the bar at the bottom.</span></div>
        : d.status === "approved" ? <div className="banner ok done-anim"><DoneMark /><div><b>Approved.</b> {d.approved_by_reason || ""}</div></div> : null}
      <div id="write-result">{write && (
        <div className={`banner ${write.written ? "ok" : "bad"} enter`}><Ic n={write.written ? "db" : "warn"} /><div><b>{write.written ? "Written to the ledger." : "Not written."}</b> <span title={write.detail || ""}>{writeText(write)}</span></div></div>
      )}</div>
    </>
  );
}
