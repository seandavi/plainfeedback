---
name: factory
description: Software factory. Takes a GitHub issue through spec → build → four parallel reviews (security, ux, ui, code) → approve-and-merge or escalate to a human. State lives in issue labels and in issue and PR comments. Use for /factory <issue|text>, /factory next, /factory status, /factory approve <issue>, /factory rework <issue> <note>.
---

# Software factory

```
issue → spec-writer → builder → [security, ux, ui, code] → all PASS → CI green → approver
                         ▲                                  │                       │
                         └──── any CHANGES (max 2 resumes) ─┘        APPROVE: merge │ ESCALATE: needs-human
```

The session running this skill is the **orchestrator**:
- It spawns every agent, and it alone moves labels, merges and cleans up.
- Subagents cannot merge, because the permission classifier blocks it, so merging must happen here.
- Agents take their context from GitHub and the worktree, not from this conversation. Each agent posts only its own comment.

## State on GitHub (no local state files)

| Thing | Where |
|---|---|
| Backlog | open issues labelled `factory:ready`, oldest first |
| Stage | exactly one of `factory:spec`, `factory:build`, `factory:review`, `factory:approve`, `factory:needs-human` on the issue |
| Spec | issue comment starting `<!-- factory:spec -->` |
| Build report | PR body (round 1), then PR comments `<!-- factory:build round=N -->` |
| Reviews | PR comments `<!-- factory:review-<kind> round=N -->`; next line `VERDICT: PASS` or `VERDICT: CHANGES` |
| Decision | PR comment `<!-- factory:decision -->`; next line `APPROVE` or `ESCALATE` |
| Human feedback | PR comment `<!-- factory:human round=N -->` |
| Done | issue closed by the merged PR (`Closes #N`); stage label removed |

The latest comment with a given marker wins. Read the comments with:

`gh pr view <pr> --json comments -q '.comments[].body'`

or `gh issue view <n> --json comments`.

If a label is missing, create it once:

`gh label create factory:<x> --color <hex> --description ...`

The colours are: ready `0e8a16`, spec, build, review and approve `1d76db`, needs-human `d93f0b`.

## Per-job resources

- Issue `N`, branch `factory/N`.
- Worktree `../plainfeedback-factory/N`, as an absolute path next to the main checkout.
- Postgres container `pf-factory-N` on `127.0.0.1:$((56000 + N % 1000))`, with `DATABASE_URL=postgresql://plainfeedback:dev@127.0.0.1:<dbport>/plainfeedback`.
- App ports: builder `4000 + (N % 1000) * 10`, security +1, ux +2, ui +3.

The setup recipe is in AGENTS.md, under "Running the app locally for checks". Give every agent the issue, PR, worktree path, `DATABASE_URL` and its own port in its prompt.

## Commands

### `/factory <issue number | free text>` and `/factory next`
1. **Resolve the issue.**
   - **Free text:** create an issue with `gh issue create` (title and body from the text), then continue with it.
   - **`next`:** the oldest open issue labelled `factory:ready`:
     `gh issue list --label factory:ready --state open --json number,createdAt -q 'sort_by(.createdAt)[0].number'`
   - **A stage label is already present:** resume from that stage (see Resume). Don't start over.
2. **Set up.**
   - Swap the issue's labels to `factory:spec`.
   - `git fetch origin`, then create the worktree:
     `git worktree add <path> -b factory/N origin/main`
     If the worktree already exists, reuse it.
   - Start the job's Postgres container and run `pnpm install --frozen-lockfile` in the worktree.
3. **Spec.**
   - Spawn `spec-writer`.
   - If its comment says `SPEC: BLOCKED`, apply `factory:needs-human` and stop. Report its questions to the user.
4. **Build.**
   - Set `factory:build` and spawn `builder`. Keep its agent id, because rework rounds resume it with SendMessage.
   - It returns a PR number.
5. **Review round r** (starting at 1).
   - Set `factory:review`.
   - Spawn the four reviewers in **one message** so they run in parallel: `reviewer-security`, `reviewer-ux`, `reviewer-ui`, `reviewer-code`.
   - The round is done only when all four `round=r` comments exist. If an agent finishes without posting, re-run it.
   - **If any reviewer says CHANGES:**
     - If r < 3, resume the builder with the links to the CHANGES comments. It pushes fixes and posts `factory:build round=r+1`. Then run round r+1 with all four reviewers again.
     - If r = 3, escalate: set `factory:needs-human` and post a PR comment listing the unresolved findings.
6. **Integrate and run CI.** This happens here because subagents can't merge.
   - If `main` moved since the branch was cut, then in the worktree:
     - `git fetch origin && git merge origin/main`;
     - resolve conflicts;
     - `just openapi`;
     - if both sides added migrations, regenerate this branch's migration so the journal `when` values stay ordered;
     - `just lint && just typecheck`;
     - commit and push.
   - If the merge changed code beyond regenerated files, run review round r+1. It is not a builder resume.
   - Then `gh pr checks <pr> --watch`.
   - If CI fails, treat it as a CHANGES round: resume the builder with the failing job's log. This counts toward the 2 resumes.
7. **Approve.**
   - Set `factory:approve` and spawn `approver`.
   - **APPROVE:**
     - Re-check the head SHA: CI must be green on the commit the approver saw.
     - `gh pr merge <pr> --squash`. Don't pass `--delete-branch`: the branch is still checked out in the worktree.
     - Remove the stage label and clean up.
   - **ESCALATE:** set `factory:needs-human`, leave the worktree and container in place, and tell the user why, quoting the decision's first lines.
8. **Clean up after a merge.**
   - `git worktree remove <path>`
   - `git branch -D factory/N`
   - `git push origin --delete factory/N`
   - `docker stop pf-factory-N`
   - Stop any servers on the job's ports.
   - Do **not** redeploy the live instance. Say "merged; not deployed" and let the user decide.

### `/factory status`
List the open issues for each `factory:*` label, with their PR links. This replaces the dashboard. On GitHub the same view is the issues list filtered by `label:factory:needs-human`.

### `/factory approve <issue>`
The user typing this is the human approval for an escalated job.
1. Find the PR: `gh pr list --head factory/N`.
2. Confirm CI is green on its head.
3. Post `<!-- factory:decision -->\nAPPROVE (human)`.
4. Merge and clean up as in step 8.

### `/factory rework <issue> <note>`
1. Post the note as `<!-- factory:human round=r -->` on the PR.
2. Resume the builder if it is still in this session. Otherwise spawn a fresh `builder` and point it at the PR, its comments and the note.
3. Set `factory:build`, then run review rounds again. The round counter restarts, so two more resumes are allowed.

## Resume (a fresh session picking up a job)
Everything needed is on GitHub and in the worktree. Work out the next stage from the issue's stage label and the latest comment markers:
- `spec`, with no spec comment yet: run step 3.
- `build`, with no PR: run step 4.
- `review`: find the highest round with a build comment or the PR body, and run that round's missing reviewers.
- `approve`, with no decision: run step 7.

A builder agent from an old session can't be resumed. Spawn a new `builder` with "continue PR #X; address comments …".

## Rules
- **Parallel jobs.** Several sessions can each run their own `/factory` job, because each has its own worktree, ports and container. Never `git stash`.
- **Agent prompts.** Brief agents to work in the foreground and finish with their comment posted. Spawn them by name: `subagent_type: "<agent>"`.
- **Never** merge with red or pending CI, push to `main`, touch the live deployment, or print secrets.
- **One-line status.** At each label change, tell the user the issue, the stage and the link.
