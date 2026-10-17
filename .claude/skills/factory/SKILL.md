---
name: factory
description: Software factory. Takes a GitHub issue through spec → build → parallel reviews → approve-and-merge or escalate to a human. State lives in issue labels and in issue and PR comments. Works in any repo with a `.factory/config.toml`. Use for /factory <issue|text>, /factory next, /factory status, /factory approve <issue>, /factory rework <issue> <note>.
---

# Software factory

```
issue → spec-writer → builder → reviewers (parallel) → all PASS → CI green → approver
                         ▲                                │                     │
                         └──── any CHANGES (max 2 resumes) ┘      APPROVE: merge │ ESCALATE: needs-human
```

The session running this skill is the **orchestrator**:
- It spawns every agent, and it alone moves labels, merges and cleans up.
- Subagents cannot merge, because the permission classifier blocks it, so merging must happen here.
- Agents take their context from GitHub, the worktree and the repo's `.factory/` files, not from this conversation. Each agent posts only its own comment.

## What the repo provides

The loop below is the same everywhere. What differs per repository lives in that repository:

| File | Holds |
|---|---|
| `.factory/config.toml` | Commands, merge method, reviewer kinds and when each one runs. **Required:** without it, stop and say so. Don't guess commands. |
| `.factory/<role>.md` | Optional guidance for one agent: `spec-writer`, `builder`, `reviewer-<kind>`, `approver`. Each agent reads its own file. `approver.md` holds the repo's escalation rules, and the spec writer reads it to know what to flag. |
| `AGENTS.md` | Conventions every agent follows, including how to run the app for checks, if the repo has one. |

```toml
# .factory/config.toml (example). {n} is the issue number.
[commands]
setup = "just factory-setup {n}"       # run in the worktree; prints KEY=VALUE lines on stdout
teardown = "just factory-teardown {n}" # run after merge
check = "just lint && just typecheck && just test"
regenerate = "just openapi"            # optional: after merging the default branch in

merge = "squash"                       # squash | merge | rebase

[review]
kinds = ["security", "code"]           # agent factory-reviewer-<kind> for each
ignore = ["**/*.test.*"]               # changed files that never trigger a conditional reviewer

[review.when_changed]                  # conditional kinds; any kind not listed always runs
# ui = ["web/**"]
```

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

- **Issue and branch:** issue `N`, branch `factory/N`, cut from the repo's default branch: `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`.
- **Worktree:** `../<repo>-factory/N` as an absolute path next to the main checkout, where `<repo>` is the checkout's directory name.
- **Environment:** run `commands.setup` in the worktree. It starts whatever the job needs (a database, dependencies) and prints `KEY=VALUE` lines. Give every line to every agent.
- **Ports:** if setup prints `PORT_BASE`, each agent gets its own app port. The builder gets `PORT_BASE`. Reviewer kind number *i* in `review.kinds` (counting from 1) gets `PORT_BASE + i`.

Give every agent the issue, the PR, the worktree path, the environment lines and its own port in its prompt.

## Commands

### `/factory <issue number | free text>` and `/factory next`
1. **Resolve the issue.**
   - **Free text:** create an issue with `gh issue create` (title and body from the text), then continue with it.
   - **`next`:** the oldest open issue labelled `factory:ready`:
     `gh issue list --label factory:ready --state open --json number,createdAt -q 'sort_by(.createdAt)[0].number'`
   - **A stage label is already present:** resume from that stage (see Resume). Don't start over.
2. **Set up.**
   - Read `.factory/config.toml`.
   - Swap the issue's labels to `factory:spec`.
   - `git fetch origin`, then create the worktree:
     `git worktree add <path> -b factory/N origin/<default>`
     If the worktree already exists, reuse it.
   - Run `commands.setup` in the worktree and keep its output.
3. **Spec.**
   - Spawn `factory-spec-writer`.
   - If its comment says `SPEC: BLOCKED`, apply `factory:needs-human` and stop. Report its questions to the user.
4. **Build.**
   - Set `factory:build` and spawn `factory-builder`. Keep its agent id, because rework rounds resume it with SendMessage.
   - It returns a PR number.
5. **Review round r** (starting at 1).
   - Set `factory:review`.
   - Decide which conditional reviewers to skip. Compare the PR's whole diff (`gh pr diff <pr> --name-only`) against the `review.when_changed` globs of each kind, ignoring files that match `review.ignore`.
     - If no changed file matches a kind's globs, don't spawn that reviewer. Post its comment yourself: `<!-- factory:review-<kind> round=r -->`, then `VERDICT: PASS`, then `SKIPPED: no matching files changed.`
     - When unsure, spawn the reviewer. A spawned reviewer can still post a quick PASS for "no visible change" or "no user-facing change".
   - Spawn the remaining reviewers in **one message** so they run in parallel. Kinds without `when_changed` globs always run.
   - The round is done only when every kind in `review.kinds` has a `round=r` comment. Check the markers on the PR yourself, because a reviewer's reported URL may not be its own comment. If an agent finishes without posting, re-run it.
   - **If any reviewer says CHANGES:**
     - If r < 3, resume the builder with the links to the CHANGES comments. It pushes fixes and posts `factory:build round=r+1`. Then run round r+1 with every reviewer again.
     - If r = 3, escalate: set `factory:needs-human` and post a PR comment listing the unresolved findings.
6. **Integrate and run CI.** This happens here because subagents can't merge.
   - If the default branch moved since the branch was cut, then in the worktree:
     - `git fetch origin && git merge origin/<default>`;
     - resolve conflicts, following AGENTS.md (it says what to regenerate after a merge);
     - run `commands.regenerate`, if set, then `commands.check`;
     - commit and push.
   - If the merge changed code beyond regenerated files, run review round r+1. It is not a builder resume.
   - Then `gh pr checks <pr> --watch`.
   - If CI fails, treat it as a CHANGES round: resume the builder with the failing job's log. This counts toward the 2 resumes.
7. **Approve.**
   - Set `factory:approve` and spawn `factory-approver`.
   - **APPROVE:**
     - Re-check the head SHA: CI must be green on the commit the approver saw.
     - `gh pr merge <pr> --<merge>`, using `merge` from the config (default `squash`). Don't pass `--delete-branch`: the branch is still checked out in the worktree.
     - Remove the stage label and clean up.
   - **ESCALATE:** set `factory:needs-human`, leave the worktree and the job's services in place, and tell the user why, quoting the decision's first lines.
8. **Clean up after a merge.**
   - `git worktree remove <path>`
   - `git branch -D factory/N`
   - `git push origin --delete factory/N`
   - Run `commands.teardown`, if set.
   - Stop any servers left on the job's ports.
   - Do **not** deploy. Say "merged; not deployed" and let the user decide.

### `/factory status`
List the open issues for each `factory:*` label, with their PR links. This replaces the dashboard. On GitHub the same view is the issues list filtered by `label:factory:needs-human`.

### `/factory approve <issue>`
The user typing this is the human approval for an escalated job.
1. Find the PR: `gh pr list --head factory/N`.
2. Confirm CI is green on its head.
3. Post `<!-- factory:decision -->\nAPPROVE (human)`.
4. Merge and clean up as in steps 7 and 8.

### `/factory rework <issue> <note>`
1. Post the note as `<!-- factory:human round=r -->` on the PR.
2. Resume the builder if it is still in this session. Otherwise spawn a fresh `factory-builder` and point it at the PR, its comments and the note.
3. Set `factory:build`, then run review rounds again. The round counter restarts, so two more resumes are allowed.

## Resume (a fresh session picking up a job)
Everything needed is on GitHub, in the worktree and in `.factory/`. If the job's services are gone, re-run `commands.setup`; it must be safe to run twice. Work out the next stage from the issue's stage label and the latest comment markers:
- `spec`, with no spec comment yet: run step 3.
- `build`, with no PR: run step 4.
- `review`: find the highest round with a build comment or the PR body, and run that round's missing reviewers.
- `approve`, with no decision: run step 7.

A builder agent from an old session can't be resumed. Spawn a new `factory-builder` with "continue PR #X; address comments …".

## Rules
- **Parallel jobs.** Several sessions can each run their own `/factory` job, because each has its own worktree and whatever `commands.setup` allocates for it. Never `git stash`.
- **Agent prompts.** Brief agents to work in the foreground and to finish only once their comment is posted. Spawn them by name: `subagent_type: "factory-<role>"`.
- **Never:**
  - merge with red or pending CI (skipped checks are fine);
  - push to the default branch;
  - deploy, or touch a live deployment;
  - print secrets.
- **One-line status.** At each label change, tell the user the issue, the stage and the link.
