# README-2: the live recording, end to end

This is your own run sheet for the last live step before submission: recording the Proving Ground with real Nemotron answers on the Windows side of this laptop, then bringing the results back to Linux. Follow it top to bottom. The general project README is [README.md](README.md); its section "Recording the Proving Ground live" covers the same scripts for a machine that has a git checkout.

Why Windows: Meterless Nightshift (the app that serves Nemotron to Tripwire) runs only on Windows or Mac. Everything recorded there is saved to files, and from then on anyone can replay it on any machine, with no keys.

---

## 1. Where every credential is

Keys and tokens are never in the git repo. This table says where each one lives. It holds no values.

| What | What it is for | Where it is |
|---|---|---|
| **NVIDIA API key** (starts with `nvapi-`) | Lets Nightshift call Nemotron on build.nvidia.com | **Windows:** `D:\NVIDIA-KEY.txt` (one line; copy it into Nightshift). **Linux:** the `NVIDIA_API_KEY` line in `~/.zshenv`, plus a copy in `~/tripwire-secrets/nvidia-api-key.txt` (only you can read it). Inside Nightshift: Setup > Providers. |
| **Nightshift runtime token** | Lets Tripwire talk to Nightshift on the same PC | Shown in Nightshift > Console. Saved in `D:\tripwire\.env` on the `METERLESS_RUNTIME_TOKEN=` line (carried over from your last Windows run). It exists only on Windows. |
| **Zetaris login** | The local Zetaris data platform (Linux only) | `~/zetaris-local/zetaris-platform/.env` on Linux. Not needed for this recording. |

Rules that keep them safe:

- Tripwire on Windows never sees the NVIDIA key. `RUN-ME.bat` clears it, so every call goes through Nightshift, which keeps the key inside itself.
- `D:\NVIDIA-KEY.txt` is outside the project folder, so it can never be committed. After the key is in Nightshift and the run has finished, delete the file. The Linux copy stays for next time.
- `.env` and `logs/` are excluded by `.gitignore`. The run logs blank out keys and tokens before writing.
- A `.env` file is never copied from Windows to Linux.

---

## 2. What is on the D: drive now

| Path | What it is |
|---|---|
| `D:\tripwire\` | **Fresh copy of branch `pg-integrate` (commit 48819a8)**, with the Proving Ground and the backtest. This is the folder to use. |
| `D:\tripwire\RUN-ME.bat` | Runs the whole recording (fresh run). |
| `D:\tripwire\RESUME.bat` | Continues a recording that stopped part-way. |
| `D:\tripwire\.env` | Nightshift address and token (copied from the old folder). |
| `D:\tripwire\README-2.md` | This file. |
| `D:\tripwire-old-2026-10-27\` | The previous folder from the earlier Windows run, untouched (its `run-logs` and recordings are kept). Delete it whenever you like. |
| `D:\NVIDIA-KEY.txt` | Your NVIDIA key, for pasting into Nightshift. |

`D:\tripwire` is a plain copy, not a git checkout, so nothing is committed or pushed from Windows. Claude does that from Linux afterwards (step 5).

---

## 3. On Windows: the recording (about 1 to 1.5 hours)

**3.1 Start Nightshift.** Open Meterless Nightshift.

- Setup > Providers: check that your NVIDIA key is there. If it is not, open `D:\NVIDIA-KEY.txt` in Notepad, copy the line, paste it there and save.
- Console: check the runtime token. If it is different from the one in `D:\tripwire\.env` (for example after a reinstall), open `D:\tripwire\.env` in Notepad and paste the new token after `METERLESS_RUNTIME_TOKEN=`. If you clear that line instead, `RUN-ME.bat` asks for the token.
- If Console shows an address other than `http://127.0.0.1:8088/v1`, change `METERLESS_BASE_URL=` in the same file.

**3.2 Plug the laptop in** and keep it awake (no sleep, no lid close) for the whole run.

**3.3 Double-click `D:\tripwire\RUN-ME.bat`.** It does everything by itself:

| Step | What happens | Time |
|---|---|---|
| Set-up | Checks Node.js 22+ (offers to install it with winget; then double-click again), then `npm install` | about 1 to 2 min |
| 1 of 3: quick check | Decides 2 suppliers live into `data\recordings\check.jsonl`. Stops at once if fewer than 3 in 4 model calls were really answered, so the long steps never record rule-based fallbacks. | about 2 min |
| 2 of 3: full live run | `record_live.ts`: all 20 suppliers, each bundled change, the pre-mortem (Ultra) and crash tests (Lightning) on every decision. About 300 to 400 calls. | about 20 to 30 min |
| 3 of 3: backtest | `backtest.ts --record --max-cases 40`: 40 past decisions, each set using only what was filed by its date. About 800 calls. | about 35 to 50 min |
| Secret check | Searches the recordings and logs for `nvapi-` and for your token | seconds |

When the window says **ALL DONE**: Start > Power > **Restart** (not Shut down), pick Linux, and tell Claude **"Windows run done"**.

**3.4 What you will see that is normal:**

- A line like `run 3: full log in logs\runs\run-0003-record_live.log` at the start of each step. That file is the full record of the step (every model call, any crash, the exit code), with keys blanked out.
- Safety-check calls failing with 404. Nightshift 1.2.7 does not serve the Content Safety model; those calls fall back and leave the decision unchanged.
- "Busy" replies (429, 502, 503, 504) retried up to twice.
- Backtest cases whose model call failed are listed and left out of the model's score, never counted as the model's.

**3.5 If it says STOPPED:**

1. Check that Nightshift is still running (and the token is still right).
2. Double-click **`D:\tripwire\RESUME.bat`**. It finds where the run stopped and continues it: answers already recorded are reused, and only the missing or failed calls go to Nightshift again. If the full live run had finished, it goes straight on to the backtest.
3. If it stops again, restart into Linux and tell Claude **"Windows run failed"**. The logs in `D:\tripwire\logs\runs\` show what went wrong.

Do not double-click `RUN-ME.bat` to recover: it starts a new run from the beginning (nothing is lost, but it takes the full time again).

---

## 4. Files the run produces

| File | What it holds | Goes into git? |
|---|---|---|
| `D:\tripwire\data\recordings\nightshift.jsonl` | Every model call of the full live run, with Nightshift receipts (appended to the earlier recording) | Yes |
| `D:\tripwire\data\backtest\recordings.jsonl` | Every model call of the backtest | Yes |
| `D:\tripwire\data\recordings\check.jsonl` | The quick check only | No |
| `D:\tripwire\logs\runs\run-000N-*.log` | One log per run, keys blanked out | No (kept for debugging) |
| `D:\tripwire\eval\*` written during the run | Results Claude regenerates by replay on Linux | No, replaced in step 5 |

---

## 5. Back on Linux (Claude does this when you say "Windows run done")

1. Mount the D: drive (it appears as `/media/manuareraa/42B406CEB406C47F`).
2. Copy only `data/recordings/nightshift.jsonl` and `data/backtest/recordings.jsonl` into the `pg-integrate` worktree and check that neither contains `nvapi-` or the token.
3. Replay them with no keys, which writes the measured numbers into `eval/`:

   ```bash
   npx tsx scripts/eval_crash.ts --write
   npx tsx scripts/backtest.ts --replay --max-cases 40
   ```

4. Run the tests and typechecks, fill the measured numbers into the README (replacing the "not recorded yet" entries), and commit on `pg-integrate`.
5. Ask you before each push, and before merging `pg-integrate` into `main`.

The worktree is `~/Manu/github/hackathons-2026/tripwire-open-agent/repo-worktrees/pg-integrate`. The main checkout (`.../repo`) is never edited directly.

---

## 6. Your own steps for submission

Claude never does these:

1. Make the GitHub repo `manuareraa/tripwire-open-agent` public (after `main` has the final code).
2. In HackOS, switch the project to Track 01.
3. Fill in the submission form and press Submit before **27 Oct 2026, 23:45 UTC**.

---

## 7. Quick reference

| Situation | Do this |
|---|---|
| First run | Double-click `D:\tripwire\RUN-ME.bat` |
| Run stopped part-way | Double-click `D:\tripwire\RESUME.bat` |
| Token rejected (401 / "unauthorized") | Copy the token again from Nightshift > Console into `D:\tripwire\.env`, then RESUME.bat |
| Nightshift "offline" | Start Nightshift, then RESUME.bat |
| Need the NVIDIA key | `D:\NVIDIA-KEY.txt` (Windows) or `~/tripwire-secrets/nvidia-api-key.txt` (Linux) |
| Want to see what happened | Newest file in `D:\tripwire\logs\runs\` |
| Same steps by hand in PowerShell | `npx tsx scripts/record_live.ts; if ($?) { npx tsx scripts/backtest.ts --record --max-cases 40 }` (set `$env:METERLESS_RUNTIME_TOKEN` first); add `--resume` to the part that stopped |
