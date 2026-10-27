// Time machine: replay one supplier's real SEC history quarter by quarter, with the tripwires set as of the start.
// Drag the slider (or press play) and watch whether a tripwire goes red before the real trouble lands.
// Data: GET /proving/timeline/:subject_id (eval/backtest_timeline.json, written by scripts/backtest.ts).
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { fmtMetric } from "../format";
import { METRIC, OP } from "../labels";
import type { BacktestTimeline } from "../types";

type Line = BacktestTimeline["lines"][number];
const crossed = (l: Line, v: number | null) => v !== null && (l.op === "<" ? v < l.threshold : v > l.threshold);
// Only the watched quarters count as firings; later quarters only show what followed.
const firstFired = (l: Line, watched: number) => l.values.findIndex((v, i) => i < watched && crossed(l, v));
const ARM: Record<string, string> = { rules: "rule-based tripwires", decider: "Ultra's tripwires", "premortem+crash": "pre-mortem tripwires that passed the crash test" };

export function TimeLapse({ subject }: { subject: string }) {
  const [t, setT] = useState<BacktestTimeline | null>(null);
  const [q, setQ] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let live = true;
    setT(null); setQ(0); setPlaying(false);
    api<BacktestTimeline>(`/proving/timeline/${subject}`).then((x) => { if (live && x?.quarters?.length) setT(x); }).catch(() => {});
    return () => { live = false; };
  }, [subject]);

  useEffect(() => {
    if (!playing || !t) return;
    if (q >= t.quarters.length - 1) { setPlaying(false); return; }
    const id = setTimeout(() => setQ(q + 1), window.TW.reduced() ? 150 : 650);
    return () => clearTimeout(id);
  }, [playing, q, t]);

  const fired = useMemo(() => t?.lines.map((l) => firstFired(l, t.watched ?? t.quarters.length)) ?? [], [t]);
  if (!t) return null;

  const n = t.quarters.length;
  const troubleAt = t.trouble.map((e) => ({ ...e, i: t.quarters.indexOf(e.quarter) })).filter((e) => e.i >= 0);
  const firstWarn = Math.min(...fired.filter((i) => i >= 0), Infinity);
  const firstTrouble = troubleAt.length ? Math.min(...troubleAt.map((e) => e.i)) : -1;
  const seen = troubleAt.filter((e) => e.i <= q);
  const end = q === n - 1;

  let verdict = "";
  if (end) {
    if (firstTrouble < 0) verdict = firstWarn === Infinity ? "No real trouble in this window, and no tripwire fired: no false alarm." : `No real trouble followed, so the tripwire that fired in ${t.quarters[firstWarn]} was a false alarm.`;
    else if (firstWarn === Infinity) verdict = `Real trouble came in ${t.quarters[firstTrouble]} and no tripwire fired: a miss.`;
    else if (firstWarn <= firstTrouble) {
      const lead = firstTrouble - firstWarn;
      verdict = lead ? `A tripwire fired in ${t.quarters[firstWarn]}, ${lead} quarter${lead === 1 ? "" : "s"} before the real trouble in ${t.quarters[firstTrouble]}.` : `A tripwire fired in ${t.quarters[firstWarn]}, the same quarter the real trouble was filed.`;
    } else verdict = `A tripwire fired in ${t.quarters[firstWarn]}, after the real trouble in ${t.quarters[firstTrouble]}: late.`;
  }

  return (
    <div className="pg-tl">
      <div className="pg-tl-h">
        <div><b>Time machine</b><span className="muted"> · tripwires set in {t.as_of} using only what was filed by then ({ARM[t.arm] ?? t.arm}), then real history replayed</span></div>
        <button type="button" className="btn sm" onClick={() => { if (end) setQ(0); setPlaying(!playing || end); }}>{playing ? "Pause" : end ? "Replay" : "Play"}</button>
      </div>
      <div className="pg-tl-q"><b>{t.quarters[q]}</b>
        <input type="range" min={0} max={n - 1} value={q} onChange={(e) => { setPlaying(false); setQ(Number(e.target.value)); }} aria-label="Quarter" aria-valuetext={t.quarters[q]} />
        {t.watched !== undefined && q >= t.watched && <span className="muted"> after the watched window</span>}
      </div>
      <div className="pg-tl-lines">{t.lines.map((l, k) => <Spark key={k} l={l} q={q} n={n} trouble={troubleAt.map((e) => e.i)} fired={fired[k]} quarters={t.quarters} />)}</div>
      <div className="pg-tl-ev">{seen.length ? seen.map((e, i) => (
        <div key={i} className="pg-tl-trouble enter"><span className="tag">Real event · {e.quarter}</span> {e.source_url ? <a href={e.source_url} target="_blank" rel="noreferrer">{e.label}</a> : e.label}</div>
      )) : <span className="muted">No real trouble filed yet by {t.quarters[q]}.</span>}</div>
      <p className="pg-tl-verdict" aria-live="polite">{verdict}</p>
    </div>
  );
}

function Spark({ l, q, n, trouble, fired, quarters }: { l: Line; q: number; n: number; trouble: number[]; fired: number; quarters: string[] }) {
  const W = 300, H = 56, P = 4;
  const nums = [...l.values.filter((v): v is number => v !== null), l.threshold];
  const lo = Math.min(...nums), hi = Math.max(...nums), span = hi - lo || 1;
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(1, n - 1);
  const y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  const pts = l.values.slice(0, q + 1).map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(" ");
  let nowAt = q;
  while (nowAt >= 0 && l.values[nowAt] === null) nowAt--;
  const now = nowAt >= 0 ? l.values[nowAt] : null;
  const red = fired >= 0 && fired <= q;
  const name = METRIC[l.metric]?.[0] ?? l.metric.replace(/_/g, " ");
  return (
    <div className={`pg-tl-line${red ? " fired" : ""}`}>
      <div className="pg-tl-lab"><b>{name}</b> <span className="muted">reopen if {OP[l.op] ?? l.op} {fmtMetric(l.metric, l.threshold)}</span>
        <span className="pg-tl-now">{now === null ? "no filing" : fmtMetric(l.metric, now)}{red ? ` · fired ${quarters[fired]}` : ""}</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${name} by quarter`}>
        {trouble.filter((i) => i <= q).map((i) => <line key={i} className="tr" x1={x(i)} x2={x(i)} y1={0} y2={H} />)}
        <line className="th" x1={P} x2={W - P} y1={y(l.threshold)} y2={y(l.threshold)} />
        <polyline className="v" points={pts} />
        {now !== null && <circle className="dot" cx={x(nowAt)} cy={y(now)} r={3.5} />}
      </svg>
    </div>
  );
}
