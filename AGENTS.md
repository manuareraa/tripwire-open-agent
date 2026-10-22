# AGENTS.md: rules for every coding agent (Claude Code, Cursor CLI)

Tripwire: agents that make a supplier decision (keep / dual_source / exit), record the exact rows each decision depends on, and reopen only the affected decisions when a source row changes. A person approves before anything is written back to Zetaris.

## 1. One writer per checkout (git worktrees)
- Never edit `repo/` (the main checkout) directly. Work in your own worktree under `../repo-worktrees/<slug>` on branch `<slug>`, created from `scaffold`:
  `git -C <repo> worktree add ../repo-worktrees/<slug> -b <slug> scaffold`
- One session per worktree. Never edit another stream's worktree or files it owns (see §4).
- Commit early and often on your own branch. Never stash, `reset --hard`, `checkout --`, `clean`, or force-push.
- Never merge into `main`. The integrator merges branches into `integration` only after tests pass; `main` changes only when the user says so.

## 2. Memory limits (the machine has crashed from OOM before)
- Wrap every install, test, build, and server run in `scripts/memguard.sh -- <cmd>` (2 GB cap, refuses if free RAM < 1.5 GB). Example: `scripts/memguard.sh -- npm test`.
- Do not run more than one server or test watcher at a time. No `--watch` left running.
- Only the zetaris-gateway stream may start or stop the Zetaris Docker stack, and only with `ZSPARK_DRIVER_MEM=3g ZETARIS_API_MAX_HEAP=1g`, and only when `MemAvailable` ≥ 7 GB. Stop it when done.
- No browsers, no ML model downloads, no Docker images other than Zetaris.

## 3. Secrets and honesty
- Never print, copy, or commit keys (`nvapi-…`, Zetaris, any `.env`). Read them from `process.env` only. `~/zetaris-local/zetaris-platform/.env` is off limits.
- No hardcoded answers: agents must branch on real query/model output. SAMPLE_MODE uses bundled data and rule-based fallbacks, clearly marked `fallback: true`; never replay saved outputs.
- Never claim a sponsor call (Zetaris write, Nemotron call, H-MEM) that the code does not actually make. Every sponsor call has a timeout and a logged fallback.

## 4. Code layout and ownership
| Path | Owner stream |
|---|---|
| `app/types.ts`, `app/config.ts`, `app/tracing.ts`, `app/sql/templates.ts` | scaffold (shared contracts; change only via integrator) |
| `app/adapters/zetaris.ts`, `app/sql/zetaris_*.ts`, `scripts/zetaris_*` | zetaris-gateway |
| `app/adapters/sample_data.ts`, `data/`, `scripts/fetch_edgar.ts`, `input_examples/` | data-samples |
| `app/adapters/hmem.ts`, `vendor/hmem/` | hmem-memory |
| `app/adapters/model.ts` | model-nemotron |
| `app/agents/`, `app/orchestration/`, `app/watcher.ts`, `app/tripwires.ts`, `server.ts`, `web/` | core (integrator) |

Code against the interfaces in `app/types.ts`. If you need a contract change, write it in your `docs/log/<stream>.md` under "Contract requests" instead of editing `types.ts`.

## 5. Conventions
- TypeScript, ES modules, Node 22. Imports use `.js` suffixes. `strict` mode.
- Tests in `test/<area>.test.ts` (vitest). Every adapter has a test that runs without keys.
- Trace every agent step with `Tracer.emit` (fields from `TraceEvent`).
- Log your work in `docs/log/<stream>.md`: what you did, what you ran, what Cursor (`agent -p`) did. Use Cursor CLI for at least one real build step per stream and record the command.
