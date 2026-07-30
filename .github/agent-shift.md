[autonomous shift] Work the sooya project one shift, unattended. Do not ask the user anything.

This message was queued by the `agent shift` GitHub Actions workflow, not typed by a human. Nobody is watching, so do not answer with questions and do not stop early.

1. GROUND TRUTH FIRST. The workspace is wiped regularly; trust nothing you remember.
   cd sooya 2>/dev/null || git clone https://github.com/sooya7/sooya.git sooya
   Then: export PATH="$PWD/../.bcode/agent-workspace/toolchain/node/bin:$PATH"
   git fetch origin --prune && git log --oneline -3 && git status --short
   git fetch origin agent/handoff && git show origin/agent/handoff:HANDOFF.md
   HANDOFF.md on the orphan branch agent/handoff is the ONLY authoritative state.
   Read it fully, including Rule 0 and the autonomy protocol, before deciding anything.

2. DO THE WORK. Take the first queue item and keep taking items until ~3 minutes remain. A fresh clone has no node_modules: decide in the first minute whether to spend `npm ci` and do one substantial code item, or to take work that does not need it. Verify locally the cheap way (`npm run typecheck -w @sooya/web`, the single affected test file; never the 195s full server suite for one change), then push and let CI be the judge.

3. FINISH THE SHIFT (always leave 3 minutes). Commit and push even mid-task WIP, because the remote is the only durable store. Update HANDOFF.md and push it to agent/handoff. If a branch is fully green in CI, open a PR and merge it — the user delegated that. Never force-push, never rewrite main.

4. IF BLOCKED. Anything only the user can do (secrets, their server, a product decision) goes in the "needs the user" list in HANDOFF instead of stalling; move to the next queue item. Email 779083953@qq.com at most once per shift, and only for a dead push token (403) or CI red on main. If the queue has nothing actionable left, say so in that mail and tell them to disable this workflow so it stops waking you.

Edit this file to change what a shift does — the workflow reads it at run time, so no workflow edit is needed.
