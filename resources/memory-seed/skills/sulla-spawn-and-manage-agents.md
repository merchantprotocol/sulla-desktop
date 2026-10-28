---
slug: sulla-spawn-and-manage-agents
label: Spawn and manage bounded agent jobs
trigger_when: When work can be split across agents, delegated to a worker, monitored asynchronously, or returned to a parent.
trigger_actions: [delegate work, spawn an agent, check a job, report progress, return a contract]
trigger_phrases: [spawn an agent, delegate, sub-agent, worker, async job, check agent jobs]
scope: [sulla-agents]
---

**When:** Delegate independent, bounded work or monitor a delegated task.

**Do:**
1. Give each task a self-contained prompt, acceptance checks, and a contract.
2. Launch up to 10 tasks together when they are independent:
   `sulla meta/spawn_agent '{"tasks":[{"agentId":"<slug>","prompt":"<self-contained brief>","label":"<short label>","visibility":"hidden","contract":{"name":"result","schema":{"type":"object"}}}]}'`
3. Check progress with `sulla agents/check_agent_jobs '{"jobId":"<job-id>"}'` or omit `jobId` for recent jobs.
4. In a delegated task, check in with `sulla agents/report_progress '{"step":"<milestone>","summary":"<what changed>","percent":50,"filesTouched":["<path>"],"blockers":[]}'`.
5. Finish from the child thread with `sulla agents/return_result '{"status":"completed","summary":"<one paragraph>","output":{}}'` matching the contract.
6. Send a job message with `sulla agents/send_job_message '{"jobId":"<job-id>","message":"<message>"}'`; do not use deprecated `send_agent_message`.

**Tools:**
- `sulla agents/directory '{"query":"<capability>"}'`: find enabled agent cards.
- `sulla agents/list_agents '{}'`: list callable agent definitions.
- `sulla meta/spawn_agent '{"tasks":[{"prompt":"<brief>"}]}'`: start hidden or tab jobs.
- `sulla agents/check_agent_jobs '{}'`: list active and recent jobs.
- `sulla agents/report_progress '{"step":"<step>","summary":"<summary>"}'`: record a delegated-task check-in.
- `sulla agents/return_result '{"status":"completed","summary":"<summary>","output":{}}'`: return a validated contract.
- `sulla agents/send_job_message '{"jobId":"<id>","message":"<text>"}'`: message a running job.
- `sulla agents/stop_agent_job '{"jobId":"<id>"}'`: stop a job when stopping is authorized.

**Don't:**
- Poll for a channel response; channel messages are fire-and-forget.
- Claim a worker's work is done before checking its result and contract.
- Pass secrets or unstated assumptions in a worker prompt.
