---
slug: sulla-judge-and-land-worker-results
label: Review, correct, and land a worker's result
trigger_when: When a sub-agent returns work and you need to decide whether it satisfies the brief, review its diff, close gaps, integrate it, and verify cleanup.
trigger_actions: [review worker output, judge a sub-agent result, inspect a diff, request corrections, land delegated work, verify cleanup]
trigger_phrases: [review the worker, judge the result, agent finished, inspect the diff, re-brief the worker, land the PR, verify cleanup]
scope: [sulla-agents]
---

**When:** Use this after every delegated result. The owner keeps the goal. A worker saying "done" does not make the task done.

**Do:**
1. Reopen the original brief. Turn its `Done means` section into a checklist. Judge the result against that checklist, not the worker's confidence or summary.
2. Inspect the returned contract and job state:
   `sulla agents/check_agent_jobs '{"jobId":"<job-id>"}'`
   Confirm the intended task returned, the status is truthful, blockers are resolved, and the artifacts are the ones requested.
3. Read the actual deliverable. For code, inspect the full diff, nearby callers, error paths, migrations, security boundaries, tests, and generated or lockfile changes. For documents or assets, open the artifact and compare every requested section.
4. Check coverage. Verify each acceptance check has evidence. Run only the checks allowed by the brief and repository policy. Do not invent a pass from checks that were skipped.
5. Use a different suitable agent to review high-stakes security, money, privacy, destructive operations, or critical architecture work. Give the reviewer the original brief, exact branch or artifact, and a request for concrete defects rather than a general opinion.
6. If a gap remains, continue the same task. Message the running job when it is still active:
   `sulla agents/send_job_message '{"jobId":"<job-id>","taskIndex":0,"message":"Gap: <exact failed acceptance check>. Fix it on the existing branch, verify <check>, and return the same contract."}'`
   If it ended, relaunch from the existing pushed branch or retained workspace with the exact gap. Do not open a duplicate branch or PR.
7. If the worker or provider repeatedly fails, select another suitable agent with `sulla agents/directory`. Give it the prior branch, evidence, and remaining gap so it resumes rather than starts over.
8. Before landing code, confirm the remote head contains the reviewed commit, the PR targets the correct integration branch, and required checks and approvals match the brief. Integrate in dependency order.
9. Verify cleanup from evidence, not promises: the worker worktree is gone, its local branch is deleted after remote parity, scratch and build artifacts are removed, and any retained container recovery workspace was either used for recovery or intentionally handled under the task's deletion rules.
10. Report what landed, the exact verification performed, checks deliberately not run, cleanup state, risks, and the undo path.

**Check it worked:**
- Every original acceptance item has direct evidence.
- The reviewed diff, not only the summary, supports the claim.
- Critical work has an independent review.
- Corrections stayed on the existing task branch and PR.
- No accepted work exists only in a local workspace.
- Cleanup and undo are explicit.

**Don't:**
- Don't grade against the worker's rewritten version of the task.
- Don't open a duplicate PR to fix a gap in an existing task.
- Don't merge unreviewed output because the contract validated.
- Don't claim tests passed when they were not run.
- Don't delete a retained recovery workspace until its useful work is safely pushed and deletion is authorized.
