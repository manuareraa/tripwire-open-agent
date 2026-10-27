// Proving Ground stage 1 · Read: the supplier's real 8-K filings (US "material event" reports), read by Nemotron Parse.
import type { Decision, FilingEvent } from "../types";

const RANK = { high: 0, medium: 1, low: 2 } as const;
const SEVERITY = { high: "serious", medium: "worth a look", low: "routine" } as const;

export function ReadStage({ d }: { d: Decision }) {
  const filings = d.proving?.filings;
  const done = filings !== undefined;
  const top: FilingEvent[] = [...(filings ?? [])]
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.filed.localeCompare(a.filed))
    .slice(0, 3);
  const high = filings?.filter((f) => f.severity === "high").length ?? 0;
  return (
    <div className={`pg-stage${done ? "" : " skipped"}`}>
      <div className="pg-step">1 · Read</div>
      <div className="pg-title">Real 8-K filings, read by Nemotron Parse</div>
      {!done && <div className="pg-note muted">Not run for this decision.</div>}
      {done && (
        <>
          <div className="pg-note">
            <b>{filings.length}</b> filing{filings.length === 1 ? "" : "s"} read by Nemotron Parse
            {high > 0 ? `, ${high} serious` : ", none serious"}.
          </div>
          <ul className="pg-read-list">
            {top.map((f) => (
              <li key={f.id} className={`pg-read-${f.severity}`}>
                <span className="pg-read-sev">{SEVERITY[f.severity]}</span>{" "}
                <span className="pg-read-date">{f.filed}</span>{" "}
                {f.headline}{" "}
                <a href={f.source_url} target="_blank" rel="noreferrer" title={`Items ${f.items.join(", ") || "none read"}; text hash ${f.text_hash.slice(0, 12)}`}>
                  filing
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
