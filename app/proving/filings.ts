// Proving Ground stage 1, Read: material events from the supplier's real 8-K filings, read by Nemotron Parse.
// Owner: the "read" stream. Fills s.proving.filings; may add findings (with evidence) the Analyst and pre-mortem can cite.
// Stub until that stream lands: records the stage as skipped.
import type { Deps, RunState } from "../orchestration/state.js";

export async function readFilings(_deps: Deps, s: RunState): Promise<void> {
  (s.proving.skipped ??= []).push("read: 8-K reading not built yet");
}
