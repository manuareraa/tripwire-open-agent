// Proving Ground stage 2, Imagine: Ultra writes a pre-mortem ("six months on, this went badly: what happened?")
// and turns each failure story into a candidate tripwire on the earliest number it would move.
// Owner: the "imagine" stream. Fills s.proving.stories and returns the candidates (origin "premortem", story_id set).
// Stub until that stream lands: no stories.
import type { TripwireDraft } from "../tripwires.js";
import type { DecisionDraft, Deps, RunState } from "../orchestration/state.js";

export async function premortem(_deps: Deps, s: RunState, _draft: DecisionDraft): Promise<TripwireDraft[]> {
  (s.proving.skipped ??= []).push("imagine: pre-mortem not built yet");
  return [];
}
