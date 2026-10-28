---
slug: sulla-resume-after-restart
label: Resume work after a restart or crash
trigger_when: When Desktop restarted, crashed, or lost a session and you need diagnostics plus a safe inventory of unfinished work before resuming.
trigger_actions: [run post-restart diagnostics, inspect unfinished jobs, resume interrupted work]
trigger_phrases: [I just restarted, we crashed, pick up where you left off, did everything get in, check Postgres first, resume last night's work, last night, what got finished, after the restart]
scope: [sulla, sulla-desktop, sulla-vm]
---

**When:** Re-establish facts before touching interrupted work. A restart can leave agents, containers, or database services in different states.

**Do:**
1. Check delegated work: `sulla agents/check_agent_jobs '{}'`.
2. Check containers and recent failures: `sulla docker/ps '{"all":true}'`; for a named container, `sulla docker/logs '{"container":"<container>","tail":100}'`.
3. Check database reachability without changing data: `sulla pg/queryone '{"sql":"SELECT 1 AS ok"}'`.
4. Check model/provider availability: `sulla models/providers '{}'`.
5. Check repository state only in the assigned worktree: `sulla github/git_status '{"absolutePath":"<worktree>"}'`.
6. Check open PRs when work was code-related: `sulla github/list_prs '{"owner":"<owner>","repo":"<repo>","state":"open"}'`.
7. Find the project's task file with `sulla files/search '{"query":"TASKS.md","path":"/mnt/sulla-files/Projects"}'`; read the matching task and resume only the unfinished item.

**Check:** The output records which jobs, containers, database, providers, branch, PRs, and task entries are healthy or unfinished. Re-run only the failed check after a repair.

**Cleanup:** Do not restart or delete anything just to make the checklist green. Preserve logs and task history; update the project task only after verified progress.

**Traps:** `check_agent_jobs` may show no active jobs after a crash; that does not prove work completed. A healthy PostgreSQL ping does not prove application data was committed. Never guess a missing task from logs.
