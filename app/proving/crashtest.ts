// Proving Ground stage 3, Crash-test: for each candidate tripwire, Lightning re-decides with that one number pushed
// just past the line and just short of it. Verified tripwires stay; decorative and mis-set ones are dropped or reset.
// Owner: the "crash-test" stream. Returns the final tripwire drafts (each with crash_test set) and fills s.proving.crash.
// Stub until that stream lands: every candidate is kept, marked untested.
import type { TripwireDraft } from "../tripwires.js";
import type { DecisionDraft, Deps, RunState } from "../orchestration/state.js";

export async function crashTest(_deps: Deps, s: RunState, _draft: DecisionDraft, candidates: TripwireDraft[]): Promise<TripwireDraft[]> {
  (s.proving.skipped ??= []).push("crash-test: not built yet");
  return candidates.map((c) => ({ ...c, crash_test: c.crash_test ?? { verdict: "untested", reason: "crash test not built yet" } }));
}
