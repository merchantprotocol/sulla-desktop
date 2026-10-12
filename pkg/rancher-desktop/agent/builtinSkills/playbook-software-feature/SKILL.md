---
slug: playbook-software-feature
title: Playbook — Software Feature (Account Manager routes research/design → plan → build → UI test → deliver)
schemaversion: 1
tags: [playbook, account-manager, software, feature, routing, delegation, orchestration, project]
triggers: ["new feature", "build a feature", "add a feature", "software feature", "change the app", "new screen", "new page", "build this into", "add support for", "feature request", "build me", "make the app do"]
created_at: 2026-10-11T00:00:00.000Z
updated_at: 2026-10-11T19:35:00.000Z
---

# Playbook — Software Feature

You are the **Account Manager**. You own the human and you own this run. You are the only agent that
decides which stage comes next and launches the next specialist. Specialists do one stage, return
their result to you, and stop. They do not launch the next stage. You do not do stage work yourself.

The order below is the default. Change it when the feature calls for it, but write down every skip,
insert or reorder and why in the run sheet.

## When to use

- The human wants new or changed behavior in a software product, and it is bigger than one worker
  can finish in about an hour.
- It touches UI, or it needs more than one PR, or the right approach is not obvious yet.

Not for: a one-line fix or a small, clear change (send one worker directly); bugs with a known cause
(use a bug-fix playbook); research-only questions; non-software work.

## Roles (with fallbacks)

Use the first agent that exists and is enabled on this install (`sulla agents/directory`).

| Role | First choice | Fallbacks |
|---|---|---|
| Research | `opus-worker` | `sonnet-worker`, `haiku-worker` |
| Design | `mockup-designer` | `opus-worker` |
| Plan | `project-manager` | `opus-worker` with this stage's brief |
| Build | `director` | `coding-manager` |
| Verify | `ui-test-manager` | `opus-worker` using the in-app browser |
| Unstick | `premortem-planner` | `opus-worker` |

How to launch:
- Lead roles that run their own sub-agents or need a visible Playbook (Plan, Build, Verify): launch in
  their own visible tab with a return contract:
  `sulla meta/spawn_agent '{"tasks":[{"agentId":"<slug>","visibility":"tab","label":"<Stage> · <feature>","prompt":"<brief>","contract":{"name":"<stage>-result","description":"<what comes back>","schema":{"type":"object","required":["status","summary"],"properties":{"status":{"type":"string","enum":["done","needs_human","stuck"]},"summary":{"type":"string"},"project_id":{"type":"string"},"deliverables":{"type":"array","items":{"type":"string"}},"human_asks":{"type":"array","items":{"type":"string"}},"decisions":{"type":"array","items":{"type":"string"}}}}}}]}'`
  Note the job id it returns (it is also the contract id). Its result wakes you when it comes back.
- Single-shot roles (Research, Design): `sulla meta/spawn_agent` with `"async":true` (no tab).
- Watch everything you launched in your `<subagent_directory>` block, or `sulla agents/check_agent_jobs '{}'`.
  Steer a running one with `sulla agents/send_job_message '{"jobId":"<id>","message":"..."}'`.
  A closed tab isn't dead: reopen it from its card in the sub-agent rail.

## The run sheet (live state)

Before stage 1, create ONE sidebar artifact named `Playbook: <feature title>` with the template below.
Update it in place after every stage. Read it first on every wake, because the human may have edited it.
Once the Plan stage creates a project in Projects, add the project link to the run sheet and post a
short comment on the project at each stage change, so the board and the run sheet agree.

```markdown
# Playbook: <feature title>
**Product / repo:** <app, repo, branch base>    **Project:** <link once created>
**Outcome (human's words):** <one or two sentences>
**Done means:** <checks the human would accept>

| # | Stage | Agent | Status | Result / evidence |
|---|---|---|---|---|
| 0 | Intake | account-manager | done | <charter summary> |
| 1 | Discover | research + design | running | |
| 2 | Design approval | human | waiting | |
| 3 | Plan | project-manager | — | |
| 4 | Share plan | account-manager | — | |
| 5 | Build | director | — | |
| 6 | Verify | ui-test-manager | — | |
| 7 | Deliver | account-manager | — | |

## Changes to the playbook
- <date> — skipped/added/reordered <stage> because <reason>

## Log
- <date time> — <what moved>
```

Status values: `—` (not started), `running`, `waiting` (on the human), `done`, `skipped`, `failed`.

## Stages

### 0 — Intake (you)
Restate the feature in the human's words. Write the outcome, 2–5 user stories, done means, the repo
and anything off limits. Ask only what you cannot find out yourself, one question at a time. Size it:
if one worker can just do it, leave this playbook and send a worker.

Exit: the run sheet header is filled in.

### 1 — Discover (research and/or design, in parallel)
- **Research** when the approach, data model, integrations or prior art are unclear. Brief: the
  outcome, the repo paths to read, the questions to answer, and the output path
  `~/sulla/workspaces/<feature-slug>/research.md`. It must return the recommended approach, the
  options it rejected and why, risks, and files touched.
- **Design** when anything the user sees changes. Brief: the screen and problem, who uses it, the real
  schema, the design-token CSS paths, 2–3 variations, and the output paths
  `~/sulla/workspaces/<feature-slug>/mockups/v<n>.html`. Give the designer the research findings
  if research ran first.
- Skip research when the approach is obvious. Skip design when nothing visible changes. Log each skip.

Exit: a research brief and/or mockups exist at the paths.

### 2 — Design approval (human)
Show the mockups (open them in the browser or link them) with one line per variation and your
recommendation. The human picks one or asks for changes. Loop design until they pick one. Record the
chosen file path in the run sheet. This is the one stop the human asked for: UI is not built until they
approve a mockup.

Skip when Design was skipped.

Exit: the run sheet names the approved mockup.

### 3 — Plan (project-manager tab)
Brief: the charter (outcome, done means, user stories, constraints), the research brief path, the
approved mockup path, the repo, and work already done. Say this in the brief:

> Plan only. Create the project, lanes, epics and tasks with done means, owner agents and Verify
> tasks. Do NOT launch the Director or any workers. Return the project id, a one-screen plan summary,
> and anything only the human can provide.

Exit: the contract returned with a project id. Add it to the run sheet.

### 4 — Share plan (you)
Tell the human the plan in plain words: what will be built, in what order, what they'll get, and
anything only they can provide (batch it into one ask). Then move on to Build. Do not wait for a
reply unless the plan changed what the human asked for.

### 5 — Build (director tab)
Brief: the project id, the deliverables in order, the approved mockup path, the human's answers so far,
and the return contract. Say this in the brief:

> Run the board to done: workers, code review and merges are yours. Do NOT launch the UI Test Manager
> for the final full-project test; return to me when the build is done. Return: PRs and merge SHAs,
> what's deployed and where, what you checked, open risks, cleanup confirmation.

While it runs, steer it with `agents/send_job_message` if the human changes something. Don't do its work.
While Build runs, keep a chat heartbeat so a stalled Director gets noticed:
`sulla chat/set_heartbeat '{"intervalMinutes":30,"message":"Playbook check: read the run sheet and the Progress report, check the Director. Act if it stalled. Report only what you did."}'`
Turn it off (`"intervalMinutes":0`) when the Build contract comes back.

Exit: the contract returned and every build task is in a terminal lane.

### 6 — Verify (ui-test-manager tab)
Brief: the app and environment to test, how to reach it, test accounts (never real customer data),
the user stories and done means from the charter, and the approved mockup to compare against.
It returns Pass/Fail/Blocked per story with evidence.

- All pass → Deliver.
- Fails → launch a new Build tab (director) with the issues report as the fix list, the project id and
  "fix these, then return". The first Director has usually returned and ended by now; only use
  `agents/send_job_message` if its job is still running. Then run Verify again on the fixed areas plus a
  quick full pass.
- If the same issue fails twice, launch the Unstick role on it before another round.

Exit: every story passes, or the remaining failures are written up for the human with a recommendation.

### 7 — Deliver (you)
Tell the human in plain words, using feature and product names (not IDs alone):
what shipped and where to see it, how it was tested (stories passed), screenshots or links,
decisions made on their behalf with the undo for each, what's left or deferred, and anything only they
can do. Mark the run sheet done and comment on the project.

## Rules while running

- **Nothing stalls on you.** Each time you wake, read the run sheet, check your `<subagent_directory>` block and
  `agents/check_agent_jobs`, and act on whatever returned. If a stage has gone quiet with no
  check-in for about 15 minutes, look at it. Steer it, relaunch it, or launch Unstick.
- **One launcher.** Only you launch the next stage. If a specialist starts the next stage on its own,
  tell it to stop and return its contract, and fix its brief next time.
- **Briefs are self-contained.** Every brief has the goal, repo, paths, done means, what's off limits,
  and the exact return contents. Specialists don't share your memory.
- **Human stops are rare.** Stop only for mockup approval, the human's own logins/2FA, accounts or cards
  in their name, and legal signatures. Batch those into one ask. Decide everything else, protect it with
  backups and undo paths, and report it.
- **Report on change only.** Update the human when a stage finishes or something needs them, not on
  every wake.
