// Right panel: every step of the last run, streamed in as it happens.
import { useLayoutEffect, useRef } from "react";
import { Ic } from "./icons";
import { pretty } from "./format";
import { AGENT } from "./labels";
import { say } from "./plain";
import type { TraceEvent } from "./types";

/** gen changes when the list is replaced, so every row animates in again; appended rows keep older keys. */
export interface TraceState { gen: number; events: TraceEvent[]; empty: "initial" | "waiting" | "blank" }

function Tev({ e }: { e: TraceEvent }) {
  const s = say(e);
  return (
    <div className={`tev new ${e.event ?? ""} ${e.status ?? ""}`}>
      <span className="av">{AGENT[e.agent_name ?? ""] ?? String(e.agent_name || "?").slice(0, 2)}</span>
      <div>
        <div className="h"><b>{pretty(e.agent_name)}</b>{e.target_agent && <span className="a">→ {pretty(e.target_agent)}</span>}<span className="a">{s.title}</span>
          {e.sponsor && <span className="bd">{e.sponsor}</span>}{e.event === "fallback" && <span className="bd">fallback</span>}{e.status === "needs_revision" && <span className="bd">sent back</span>}{e.retry_count ? <span className="bd">retry {e.retry_count}</span> : null}</div>
        {s.detail && <div className="o" title={`As logged: ${e.action}${e.output_summary ? ` · ${e.output_summary}` : ""}`}>{s.detail}</div>}
      </div>
    </div>
  );
}

export function TracePanel({ trace, live }: { trace: TraceState; live: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [trace]);
  const n = trace.events.length;
  return (
    <section className="panel enter" style={{ "--i": 2 } as React.CSSProperties} id="trace-panel" aria-labelledby="ht">
      <div className="panel-h"><h2 id="ht">Agent trace</h2><span className="info" tabIndex={0} data-tip="Every step of the last run, in order: who did what, which queries ran, where the Critic pushed back, and any fallback. Full traces are also saved to logs/.">i</span><span className={`trace-live${live ? " on" : ""}`} id="trace-live">live</span><span className="muted" id="trace-count" style={{ marginLeft: "auto", fontSize: 12 }}>{n ? `${n} steps` : ""}</span></div>
      <div className="legend"><span><i className="lg-sponsor" />sponsor call</span><span><i className="lg-push" />pushback / retry</span><span><i className="lg-ok" />check passed</span><span><i className="lg-fb" />fallback / escalation</span><span><i className="lg-dec" />decision</span></div>
      <div className="trace" id="trace" ref={box}>
        {n ? trace.events.map((e, i) => <Tev key={`${trace.gen}-${i}`} e={e} />)
          : trace.empty === "initial" ? <div className="none"><Ic n="pulse" />Run a decision or apply a change. Each agent step appears here as it happens.</div>
          : trace.empty === "waiting" ? <div className="none"><Ic n="empty" />Waiting for the first step…</div> : null}
      </div>
    </section>
  );
}
