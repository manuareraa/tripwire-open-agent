// Proving Ground stage 2 · Imagine. Owner: the "imagine" stream.
// One card per failure story Ultra wrote, the tripwire it became, and whether the crash test kept it.
import type { Decision, Tripwire } from "../types";
import { OP } from "../labels";
import { fmtMetric } from "../format";
import { metricName } from "../names";

const VERDICT: Record<string, string> = {
  verified: "crash test: crossing it changes the call",
  untested: "not crash-tested yet",
};

function watch(t: { metric: string; op: string; threshold?: number | null }) {
  return `watch: ${metricName(t.metric).toLowerCase()} ${OP[t.op] ?? t.op}${t.threshold != null ? ` ${fmtMetric(t.metric, t.threshold)}` : ""}`;
}

export function ImagineStage({ d }: { d: Decision }) {
  const stories = d.proving?.stories;
  const done = stories !== undefined;
  const crashRan = d.proving?.crash !== undefined;
  const byStory = new Map<string, Tripwire>();
  for (const t of d.tripwires || []) if (t.story_id) byStory.set(t.story_id, t);
  return (
    <div className={`pg-stage${done ? "" : " skipped"}`}>
      <div className="pg-step">2 · Imagine</div>
      <div className="pg-title">Ultra's pre-mortem: how this call could fail</div>
      {!done && <div className="pg-note muted">Not run for this decision.</div>}
      {done && stories!.length === 0 && <div className="pg-note muted">Ultra answered, but no story passed the code checks.</div>}
      {done && stories!.length > 0 && (
        <ul className="pg-imagine-list">
          {stories!.map((st) => {
            const tw = byStory.get(st.id);
            const dropped = !tw && crashRan;
            const verdict = tw?.crash_test?.verdict;
            return (
              <li key={st.id} className={`pg-imagine-card${dropped ? " dropped" : ""}`}>
                <div className="pg-imagine-story">{st.story}</div>
                <div className="pg-imagine-wire">{watch(tw ?? st)}</div>
                {dropped && <div className="pg-imagine-mark">✕ dropped by the crash test</div>}
                {!dropped && verdict && VERDICT[verdict] && <div className={`pg-imagine-mark ${verdict}`}>{verdict === "verified" ? "✓ " : ""}{VERDICT[verdict]}</div>}
                {st.grounded_in.length > 0 && <div className="pg-imagine-cite muted">based on {st.grounded_in.map((g) => metricName(g)).join(", ")}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
