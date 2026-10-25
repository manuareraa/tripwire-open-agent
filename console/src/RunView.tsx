// Centre panel while agents work: the relay of six agents, what is happening now, counters and a feed.
import { useEffect, useState } from "react";
import { Spin } from "./bits";
import { pretty } from "./format";
import { Ic } from "./icons";
import { CHANGE_STAGES, STAGES, TIPS } from "./labels";
import { nowText, say } from "./plain";
import type { TraceEvent } from "./types";

const pushed = (e: TraceEvent) => e.status === "needs_revision" || e.event === "retry";

/** A counter that pops each time its value changes. */
const Count = ({ v }: { v: number }) => <b key={v} className={v ? "bump" : ""}>{v}</b>;

export function RunView({ title, sub, kind, events }: { title: string; sub: string; kind: "decide" | "change"; events: TraceEvent[] }) {
  const stages = kind === "decide" ? STAGES : CHANGE_STAGES;
  const [t0] = useState(() => Date.now());
  const [secs, setSecs] = useState(0);
  const [tipI, setTipI] = useState(0);
  useEffect(() => {
    const tick = setInterval(() => setSecs(Math.round((Date.now() - t0) / 1000)), 250);
    const tips = setInterval(() => setTipI((i) => (i + 1) % TIPS.length), 6000);
    return () => { clearInterval(tick); clearInterval(tips); };
  }, []);

  const idx = (a?: string) => stages.findIndex(([n]) => n === a);
  const counts = { q: 0, ok: 0, push: 0 };
  const pushes = stages.map(() => 0);
  const reached = new Set<number>();
  for (const e of events) {
    if (e.event === "tool_call" && e.agent_name === "Analyst") counts.q++;
    if (e.event === "critique" && e.status === "success") counts.ok++;
    if (pushed(e)) counts.push++;
    const i = idx(e.agent_name);
    if (i >= 0) { reached.add(i); if (pushed(e)) pushes[i]++; }
  }
  const last = events[events.length - 1];
  const next = last ? idx(last.target_agent) : -1;
  const cur = next >= 0 ? next : last ? idx(last.agent_name) : -1;
  if (next >= 0 && idx(last.agent_name) < 0) reached.add(next);
  const x = 8.33 + Math.max(cur, 0) * (83.34 / 5);
  const feed = events.map((e, i) => ({ e, i })).filter(({ e }) => e.agent_name !== "Orchestrator").slice(-4).reverse();
  const detail = last ? say(last).detail : "";

  return (
    <div className="run" data-kind={kind}>
      <div className="run-head">
        <span dangerouslySetInnerHTML={{ __html: window.TW.LOADER }} />
        <div><div className="eyebrow"><span className="live">Live</span></div><h2>{title}</h2><div className="muted" style={{ fontSize: 13 }}>{sub}</div></div>
        <span className="t" id="elapsed">{secs}s</span>
      </div>
      <div className="relay" id="relay"><span className="fill" style={cur >= 0 ? { width: `${x - 8.33}%` } : undefined} /><span className="spark" style={{ left: `${x}%` }} />
        {stages.map(([a, ab, d], i) => (
          <div key={a} className={`ag${cur >= 0 && i === cur ? " on" : cur >= 0 && reached.has(i) ? " done" : ""}${pushes[i] ? " push" : ""}`} data-a={a} data-i={i}>
            <span className="av" key={pushes[i]}>{ab}<Ic n="check" className="ck" /></span><b>{pretty(a)}</b><span>{d}</span><span className="think"><i /><i /><i /></span>
          </div>
        ))}
      </div>
      <div className="now" id="now"><Spin /><div className="tx">
        {last ? <>{nowText(last)}{detail && <small>{detail}</small>}
          {next >= 0 && stages[next][0] !== last.agent_name && <small>Handed to the <b>{pretty(last.target_agent)}</b>, which is working on it now{last.target_agent === "Decider" ? ". With thinking on, a model call can take a minute." : "."}</small>}</> : "Sending the request…"}
      </div></div>
      <div className="counters">
        <div className="counter"><Count v={counts.q} /><span>queries run</span></div>
        <div className="counter"><Count v={counts.ok} /><span>checks passed</span></div>
        <div className="counter"><Count v={counts.push} /><span>pushbacks</span></div>
        <div className="counter"><Count v={events.length} /><span>trace steps</span></div>
      </div>
      <div className="feed" id="feed">{feed.map(({ e, i }) => <div key={i} className={`fe ${e.status === "needs_revision" ? "push" : ""}`}><b>{pretty(e.agent_name)}</b><span>{say(e).title}</span></div>)}</div>
      <div className="tipcard"><Ic n="bulb" /><div className="tx" id="tip" key={tipI} dangerouslySetInnerHTML={{ __html: TIPS[tipI] }} /></div>
    </div>
  );
}
