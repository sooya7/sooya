[autonomous shift] Work the sooya project one shift, unattended. Do not ask the user anything.

This message was queued by the `agent shift` GitHub Actions workflow, not typed by a human. Nobody is watching, so do not answer with questions and do not stop early.

1. GROUND TRUTH FIRST. Trust nothing you remember; the workspace may not even be the same one.
   Work in `/tmp`, never keep a git repo in the workspace (`.git` is never persisted):

       mkdir -p /tmp/bcode && cd /tmp/bcode
       [ -d node ] || { curl -s -o node.tgz https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-arm64.tar.gz \
         && tar xzf node.tgz && rm node.tgz && mv node-v22.12.0-linux-arm64 node; }
       export PATH=/tmp/bcode/node/bin:$PATH
       [ -d sooya ] || git clone https://github.com/sooya7/sooya.git sooya
       cd sooya && git fetch origin --prune && git log --oneline -5 && git status --short
       git fetch origin agent/handoff && git show origin/agent/handoff:HANDOFF.md

   HANDOFF.md on the orphan branch `agent/handoff` is the ONLY authoritative state.
   Read §0 (setup + Rule 0), §1 (current state) and §2 (queue) before deciding anything.
   Pushing needs a GitHub PAT: use `.bcode/agent-workspace/github_pat` if it exists, otherwise
   it is a "needs the user" item — do not hunt for another credential.

2. DO THE WORK. Take the first queue item and keep taking items until ~3 minutes remain. Verify locally the cheap way (`npm run typecheck -w @sooya/server`, the single affected test file; never the 195s full server suite for one change), then push and let CI be the judge. If `npm ci` at the repo root is too expensive for what is left of the shift, take work that does not need it and let CI verify.

3. FINISH THE SHIFT (always leave 3 minutes). Commit and push even mid-task WIP, because the remote is the only durable store — the workspace is not, and a run that never reaches its end saves nothing. Update HANDOFF.md and push it to `agent/handoff`, replacing stale claims rather than appending a new timeline entry. If a branch is fully green on all four CI jobs, open a PR and merge it — the user delegated that. Never force-push, never rewrite main.

4. IF BLOCKED. Anything only the user can do (secrets, their server, a product decision) goes in HANDOFF §3 instead of stalling; move to the next queue item. Email 779083953@qq.com at most once per shift, and only for a dead push token (403) or CI red on main. If the queue has nothing actionable left, say so in that mail and tell them to disable this workflow so it stops waking you.

5. TIME. Report every time to the user in 北京时间 (UTC+8) — `TZ=Asia/Shanghai date`.
   The machine, git timestamps and cron are all UTC.

Edit this file to change what a shift does — the workflow reads it at run time, so no workflow edit is needed.
