---
name: zharness-self-optimization
description: 把用户刚在 ZHarness 里遇到的问题变成对上游仓库的合并质量 PR：用事件日志取证、fork 上游、先写失败测试、最小修复、gh 开 PR；根因不明时只开带证据的 issue。
---

<!-- AIGC 内容溯源元数据（原始记录保留）
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 193041c6b5d42207eacc7a4875567369_51da1a61abfa11f18039525400461939
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 193041c6b5d42207eacc7a4875567369_51da1a61abfa11f18039525400461939
-->



# ZHarness Self-Optimization

Turn a problem the user just experienced in ZHarness into a merged-quality pull
request against the ZHarness upstream repository, using ZHarness's own event
logs as the evidence base. Work autonomously, but keep every action auditable
and reversible.

> Upstream note: this skill does not hard-code an upstream repository URL.
> Replace `<upstream-owner>/<upstream-repo>` below with the actual ZHarness
> fork target the user works against (ask if unsure) before opening a PR.

## 0. Preconditions (check once, fail fast)

- `gh --version` and `gh auth status` must succeed. If not authenticated, ask
  the user to run `gh auth login` and stop — never handle tokens yourself.
- Git identity must exist (`git config user.name` / `user.email`); set a local
  identity in the clone if missing.
- Upstream repo: `https://github.com/<upstream-owner>/<upstream-repo>` (do NOT
  push to it — PRs come from the user's fork only).

## 1. Frame the problem

- Restate in one sentence: what happened, where (TUI / desktop / web / RPC /
  CLI), and whether it is a bug fix or an optimization.
- If the user only reports a vague symptom ("it feels slow", "the menu is
  weird"), decide what measurable signal would confirm it before touching code.

## 2. Collect evidence from the local ZHarness state

ZHarness records everything it does; use it instead of guessing.

- **Version**: `zharness --version` (compare against the repo's `package.json`).
- **Event log** (primary evidence): `~/.zharness/agent/workspaces/<ws_id>/events.sqlite`
  - Find the workspace for the affected project by matching `cwd` in
    `~/.zharness/agent/workspaces/*/meta.json`.
  - Schema: table `events` (sequence, event_id, workspace_id, runtime_id,
    actor_id, timestamp, type, payload_json, caused_by, correlation_id,
    thread_id); sessions/threads index tables sit alongside.
  - Read-only queries while ZHarness is running are safe; if the db is locked
    or a `-wal` file is present, copy `events.sqlite*` to a temp dir first and
    query the copy.
  - Useful starting points: recent errors (`type like '%ERROR%'`), the failing
    session's events (`thread_id`), tool-call payloads around the failure.
  - `sqlite3` CLI may be missing — fall back to
    `node -e` with `node:sqlite` (`DatabaseSync`), or `python3 -c "import sqlite3..."`.
- **Debug log**: `tail -n 500 ~/.zharness/agent/zharness-debug.log` for stack traces.

Write down: the exact event sequence that shows the problem, and the smallest
excerpt (event type + payload fields) that will go into the PR description.

## 3. Fork, clone, branch

- Persistent working dir (keep between runs so forks stay warm):
  `~/.zharness-self-optimization/zharness`
- First run: `gh repo fork <upstream-owner>/<upstream-repo> --clone` (into that dir).
- Later runs: `git fetch upstream main && git checkout main &&
  git reset --hard upstream/main` to rebase onto fresh code.
- Branch naming: `fix/<short-slug>` or `opt/<short-slug>` — one issue per branch.

## 4. Reproduce and diagnose

- Map the evidence to code: event types live in `src/core/event-store/`, RPC
  surface in `packages/rpc/` + `packages/protocol/`, TUI in `packages/tui/`,
  desktop shell in `apps/desktop/`, web UI in `apps/web/`, CLI in `src/cli.ts`
  and `src/main.ts`.
- Reproduce with the actual payload from the event log where possible (e.g.
  replay the exact command or RPC message that failed).
- Write the failing test FIRST (vitest, `test/` mirroring the source path).
  A fix without a regression test is not done.

## 5. Implement

- Minimal, surgical diff. No drive-by refactors, no reformatting untouched
  code. Match local style (tabs, comment conventions).
- For optimizations: measure before/after (timing, event-log deltas) and put
  the numbers in the PR.
- Do not modify the user's installed ZHarness or their `~/.zharness` config —
  the fix lives in the clone until the user chooses to rebuild/reinstall.

## 6. Verify

- `npm test` (offline mode is the default) — full suite must be green.
- Targeted: `ZHARNESS_OFFLINE=1 npx vitest --run test/<file>.test.ts`.
- Web UI changes: `cd apps/web && npm run build`.
- Core changes: `npm run build` must succeed.

## 7. Commit and open the PR

- Conventional commits with a scope, matching `git log` (e.g.
  `fix(rpc): ...`, `feat(skills): ...`, `fix(ui): ...`). One logical commit is
  usually enough; never mix unrelated changes.
- `git push -u origin HEAD` (origin = the fork), then:
  `gh pr create --repo <upstream-owner>/<upstream-repo> --base main`
- PR body sections: **Problem** (user-visible symptom + event-log excerpt),
  **Root cause**, **Fix**, **Verification** (test names/output), **Notes**.
- Report the PR URL to the user at the end.

## Guardrails

- One issue per PR; if the log reveals several unrelated problems, open
  separate branches/PRs (or GitHub issues with evidence) and say so.
- If the root cause is uncertain or the fix would be architectural, STOP after
  step 2/4: file `gh issue create --repo <upstream-owner>/<upstream-repo>` with
  the evidence and your analysis, and summarize options for the user instead of
  guessing.
- Never commit secrets, tokens, or absolute paths from the user's machine.
- Never force-push or commit to `main`; never push anywhere except the fork.
- Ask the user before opening PRs that change public behavior, defaults, or
  anything security-relevant.

## Failure handling

- `gh` unauthorized → ask user to authenticate; continue with the local fix so
  the work isn't lost.
- Cannot reproduce → say so explicitly, attach the evidence to an issue
  instead of shipping a speculative PR.
- Tests red after a reasonable effort → revert to a clean branch state and
  report what you learned; a closed-without-PR investigation is still a good
  outcome when paired with a well-written issue.
*（内容由AI生成，仅供参考）*
