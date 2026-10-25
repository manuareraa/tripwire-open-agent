# Recording a live Nemotron run through Meterless Nightshift

Tripwire asks Nemotron for help at seven points in each decision (Planner, Analyst, Decider, the safety check and so on).
Every one of those calls goes through **Meterless Nightshift**, a small program that runs on your own machine,
holds your NVIDIA key, and forwards each request to a Nemotron model. Nightshift sends back a **receipt** with each
answer: an id, plus the name of the model that really answered. Tripwire shows both in the trace and in the console
("Which model handled each step").

This guide records one full live run and saves it, so the hosted demo can **replay** those exact answers later with
no keys and no network. Replayed answers are always labelled as replays, with the date they were recorded.

Nightshift has Windows, Mac and DGX editions, and **no Linux edition**, so this run happens on a Windows PC or a Mac.

## 1. Set up Nightshift (once)

1. Install and start Nightshift.
2. Open **Setup > Providers** and paste your NVIDIA key (it starts with `nvapi-`). The key lives only inside Nightshift.
   Tripwire never sees it, and it must never go into the project or a `.env` file.
3. Open **Console**. It shows two things you need:
   - the **runtime URL** (usually `http://127.0.0.1:8088/v1`);
   - the **runtime token** (a long string that lets apps use Nightshift). Treat it like a password.

## 2. Get Tripwire on the same machine

You need Git and Node.js 22 or newer.

```bash
git clone https://github.com/manuareraa/tripwire-open-agent.git
```

```bash
cd tripwire-open-agent && npm install
```

## 3. Point Tripwire at Nightshift

Set two environment variables in the terminal you will run the script from. They last only for that terminal window,
so nothing is written to disk.

macOS (Terminal):

```bash
export METERLESS_BASE_URL="http://127.0.0.1:8088/v1"
```

```bash
export METERLESS_RUNTIME_TOKEN="paste-the-token-from-Nightshift-Console"
```

Windows (PowerShell):

```powershell
$env:METERLESS_BASE_URL = "http://127.0.0.1:8088/v1"
$env:METERLESS_RUNTIME_TOKEN = "paste-the-token-from-Nightshift-Console"
```

Instead of the token itself you can set `METERLESS_TOKEN_FILE` to the `proxy-token` file Nightshift writes in its
state folder.

## 4. Record

Start with a short run of two suppliers to check everything answers:

```bash
npx tsx scripts/record_live.ts --suppliers SUP-01,SUP-05 --no-changes --out data/recordings/check.jsonl
```

Then the full run (all 20 suppliers, then each bundled change, then back to the original data):

```bash
npx tsx scripts/record_live.ts
```

What the script does:

- It checks that Nightshift answers before making any model call. If it doesn't, it stops and records nothing.
- It uses the bundled sample data in a throwaway folder. It never touches Zetaris or your own decision ledger.
- It uses Nightshift only. The direct build.nvidia.com backup is off unless you add `--allow-backup`.
- It appends every call to `data/recordings/nightshift.jsonl`, with the prompt, the answer, the tokens, the time and the
  receipt. Receipt fields whose names look like credentials are dropped before anything is written.

At the end it prints an honest summary, for example:

```text
recorded 84 calls to data/recordings/nightshift.jsonl in 412 s
  answered by a model: 84; fell back to rules: 0
  with a Nightshift receipt: 84
  nvidia/nemotron-3.5-lightning-30b-a3b: 42
  ...
```

(The numbers above are only an illustration of the format, not a real run.)

## 5. Check what you got

- **Which models really answered.** Nightshift can serve a different model from the one Tripwire asked for (other teams
  have seen Ultra requests served by another model). Tripwire always shows the model that answered, and writes
  "asked for …" beside it when the two differ. Nothing to fix: just note it.
- **Fallbacks.** If a step says "fell back to rules", the script prints the first few reasons. A common one is a model
  Nightshift cannot serve, such as the safety model. You can choose another model for that step with
  `METERLESS_GUARD_MODEL` (or `METERLESS_REASONING_MODEL`, `METERLESS_SMALL_MODEL`) and record again.
- **No secrets.** Search the file for your token and for `nvapi-` before you share it. Neither should appear.

## 6. Use the recording

Copy `data/recordings/nightshift.jsonl` back into the repo (or commit it from that machine). From then on, any copy of
Tripwire with no live model replays it automatically: the console says "replay of a live call recorded …" on every step
that came from it. A step whose prompt was never recorded (for example a what-if you didn't run live) uses the
rule-based path and says so. It is never guessed.

To record again, delete the old file first (or pass a new `--out`), so the replay holds one coherent run.
Set `MODEL_REPLAY=false` to turn replay off.

## 7. Record the measured comparison

In the same terminal (Nightshift still running, the two variables still set):

```bash
npx tsx scripts/eval_arms.ts --write
```

This runs the 23 cases in `eval/cases.json` through five set-ups: rules only, one Ultra call on its own, the full
Tripwire graph on Lightning only, the full graph as shipped, and the full graph with thinking always on. Code scores
every answer on the same checks (expected label where one exists, valid answer, every number traced to the data,
tripwires valid, stale sources named, escalation when required) and counts tokens, time and fallbacks.

It records each set-up's calls to `eval/recordings/<name>.jsonl` and writes `eval/results.json` and
`eval/RESULTS.md`. Commit all of them. Later runs with no live model replay those recordings, and the report says
"replay of a live run recorded …". If recordings already exist it stops; pass `--overwrite` to keep the old ones as
`.bak` and record again. Check the "Rule-based decisions" column: a set-up that fell back to rules on many cases says
little about the model, and the reasons are in the per-case rows.

## 8. Measure the guard check

```bash
npx tsx scripts/safety_probes.ts --write
```

This sends the 32 probes in `eval/safety_probes.json` to the safety model, each in the exact form the Risk Officer's
final check uses, and scores them beside a keyword filter: 22 harmful recommendations (an echoed prompt injection,
tipping off a supplier under a sanctions review, leaked credentials or personal data, illegal proposals) and 10
ordinary ones that use the same alarming words. It records to `eval/recordings/safety.jsonl` and writes
`eval/SAFETY.md`. If the summary warns that a non-safety model answered, Nightshift routed the request elsewhere; run
it with `--direct` instead (this needs `NVIDIA_API_KEY` set in that terminal, and the report then names
build.nvidia.com as the provider).

## 9. Measure rerank

Nemotron rerank orders the Analyst's findings by how much they bear on the buyer's question, so the summary leads
with the right evidence. Nightshift serves chat models only, so this one call goes to build.nvidia.com directly, and
the trace says so. It needs `NVIDIA_API_KEY` in that terminal (only for this step, never in a file):

```bash
npx tsx scripts/eval_rerank.ts --write
```

It ranks the findings of two suppliers for the 17 buyer questions in `eval/rerank_gold.json` with Nemotron rerank
and with keyword overlap, scores both (hit@1, recall@3, MRR), records to `eval/recordings/rerank.jsonl`, and writes
`eval/RERANK.md`. If every call fails with HTTP 404, the hosted path differs from the default: copy the URL from the
model's API page on build.nvidia.com into `NVIDIA_RERANK_URL` and run it again. To use rerank in the app itself, set
`RERANK=nvidia` as well.

## Running Tripwire on Linux against Nightshift on another machine

This only works if Nightshift accepts connections from other machines (its Console shows an address other than
`127.0.0.1`). If it does, set `METERLESS_BASE_URL` on the Linux machine to that address and run the same script there.
If Console shows only `127.0.0.1`, run Tripwire on the Nightshift machine as above.
