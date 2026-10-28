---
slug: sulla-run-a-team-in-parallel
label: Run a team of agents in parallel waves
trigger_when: When a goal has several independent workstreams and you need agents to work concurrently without file conflicts, resource overload, lost commits, or duplicate pull requests.
trigger_actions: [split work into parallel waves, assign file ownership, create worker worktrees, coordinate an integration branch]
trigger_phrases: [run agents in parallel, parallel team, work wave, multiple workers, integration branch, one writer per file]
scope: [sulla-agents]
---

**When:** Use parallel agents only when workstreams can finish independently. If every task depends on the previous result, use one worker or sequential tasks.

**Do:**
1. Draw the dependency graph. Put tasks with no unmet dependency in the same wave. Keep dependent tasks in later waves.
2. Respect the machine's current agent and heavy-command limits. Start no more workers than the machine can run safely. A `spawn_agent` call accepts at most 10 tasks, but that is an API ceiling, not a target.
3. Give one writer ownership of each file set. Split by files, package, service, or artifact. Never let two workers edit the same files concurrently.
4. Give every coding worker its own branch and Git worktree under `/mnt/worktrees`. Never share a writable worktree. Tell each worker the exact base and owned paths.
5. Create an integration branch when several PRs form one delivery. Each worker opens one PR into that integration branch, not into another worker's branch. The owner reviews and lands them in dependency order.
6. Put all independent tasks in one async launch so they start together:
   `sulla meta/spawn_agent '{"tasks":[{"agentId":"<slug-a>","label":"API lane","prompt":"<complete API brief>","contract":{"name":"result"}},{"agentId":"<slug-b>","label":"UI lane","prompt":"<complete UI brief>","contract":{"name":"result"}}],"parallel":true,"async":true}'`
7. Require coding workers to commit and push early, then push after every meaningful step. Restarts destroy unpushed work. A pushed branch is the recovery point.
8. Keep moving on the owner's integration, review plan, or next independent wave. Do not idle while workers run. Completion wakes the parent.
9. Inspect progress with `sulla agents/check_agent_jobs '{"jobId":"<job-id>"}'` only for a status request, recovery, or suspected stall. Use the latest check-in. Quiet for about 15 minutes without a known long operation is a stall signal.
10. When one lane fails, preserve the rest. Read its branch, worktree, result, and retained recovery workspace. Re-brief the exact gap on the existing pushed branch. Change model or provider if the same one repeatedly fails.
11. Start the next wave only after its dependencies are accepted, not merely reported complete.
12. After integration, verify every worker removed its worktree, local branch, scratch files, and build artifacts. The remote branch or merged commit must hold all accepted work first.

**Check it worked:**
- Every file has one active writer.
- Every coding lane has a distinct worktree and branch.
- Each lane has a pushed recovery point and one PR into the integration branch.
- Later waves start from accepted dependency commits.
- Failed lanes can resume without repeating completed work.

**Don't:**
- Don't parallelize dependent edits to the same surface.
- Don't use the maximum task count when the machine cannot support it.
- Don't let workers open duplicate PRs for the same task.
- Don't accept local-only work as a handoff.
- Don't merge summaries. Merge reviewed commits.
