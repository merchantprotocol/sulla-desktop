---
slug: sulla-tool-agents
label: Use the Sulla agents tools
trigger_when: When you need to choose a specialist, delegate bounded work, monitor it, or return a child result.
trigger_actions: [agents, Sulla agents tool, tool call]
trigger_phrases: [agent directory, delegate work, spawn a worker, check agent job, stop a job]
scope: [tool-agents]
---

**When:** Use `exec` to dispatch an exact `sulla agents/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"agents"}'` before an unfamiliar call.

**Tools:**

<!-- tools:generated:start -->
- `sulla agents/agents_directory {}`: Directory of every callable custom agent (from agent_definitions) as compact cards: when to call it, when not to, what to send, what it returns, cost tier, and which agents it can call. Use it to pick the right specialist before spawn_agent. Search with query, fetch one card with slug, or omit both to list all enabled agents. Required: none. Optional: query, slug, includeInactive, limit.
- `sulla agents/check_agent_jobs {}`: Inspect delegated jobs (hidden and tab), including visibility, contract, per-task elapsed time, latest and recent check-ins, blockers, touched files, and undelivered orchestrator-message counts. Required: none. Optional: jobId.
- `sulla agents/close_agent_conversation {"conversationId":"<conversationId>"}`: Close a sub-agent conversation and free its resources (drops the sub-agent's graph + state). Do this when you're done talking to a sub-agent. Required: conversationId. Optional: none.
- `sulla agents/list_agents {}`: List the live named agents you can message (heartbeat, mobile-relay, other frontends) with their channel, status, and uptime — the roster from turn context, queryable on demand. Message any with a <channel:CHANNEL>text</channel:CHANNEL> tag (fire-and-forget; the reply arrives on a later turn). Use spawn_agent for bounded delegated work. Required: none. Optional: none.
- `sulla agents/read_agent_conversation {}`: Read the transcript of an open sub-agent conversation, or list all open conversations when called without a conversationId. Required: none. Optional: conversationId.
- `sulla agents/report_progress {"step":"<step>","summary":"<summary>"}`: Record a milestone check-in for your current delegated task (hidden worker or agent tab). Call it at meaningful milestones and at least every ~5 minutes; your parent sees it in its subagent directory. Required: step, summary. Optional: filesTouched, blockers, percent.
- `sulla agents/return_result {}`: Finish your delegated task by returning its contract to the agent that launched you (hidden worker or agent tab). The result is checked against the contract in your brief; a mismatch is refused so you can fix it. Default contract: {status: completed|blocked|failed, summary, output}. A tab closes only when you call this. Required: none. Optional: status, summary, output, result, jobId.
- `sulla agents/send_agent_message {"conversationId":"<conversationId>","message":"<message>"}`: DEPRECATED conversation compatibility surface. For a running spawn_agent job, use send_job_message with its jobId instead. Required: conversationId, message. Optional: none.
- `sulla agents/send_job_message {"jobId":"<jobId>","message":"<message>"}`: Send new direction to one or all running tasks in a delegated job, hidden or tab. Hidden workers get it live when possible, otherwise at their next model-call boundary; a tab child gets it in its chat (steers a live turn or starts one). Required: jobId, message. Optional: taskIndex.
- `sulla agents/start_agent_conversation {"prompt":"<prompt>"}`: DEPRECATED compatibility wrapper over spawn_agent. Launches one async job and returns jobId plus a conversationId alias. Results wake the parent graph; use check_agent_jobs only as fallback/history. Multi-turn follow-ups are not supported. Required: prompt. Optional: agentId, label.
- `sulla agents/stop_agent_job {"jobId":"<jobId>"}`: Kill switch for a running delegated job, hidden or tab. Hidden: fires the job's abort signal, which cascades to every sub-agent it spawned, unwinding them cooperatively (an in-flight LLM/tool call finishes first). Tab: stops the tab's live turn and closes its contract. Use when a job was misfired, duplicated, stalled, or is no longer needed; check_agent_jobs afterwards confirms it settled as 'stopped'. Required: jobId. Optional: none.
<!-- tools:generated:end -->
**Do:**
1. `sulla agents/agents_directory {"query":"<work description>"}` to choose a specialist.
2. `sulla meta/spawn_agent {"tasks":[{"prompt":"<self-contained task>","label":"<label>","returnContract":{"name":"result"}}],"async":true}` to delegate.
3. `sulla agents/check_agent_jobs {"jobId":"<jobId>"}` to inspect progress and blockers.
4. `sulla agents/send_job_message {"jobId":"<jobId>","message":"<new direction>"}` to steer a running task.
5. `sulla agents/return_result {"status":"completed","summary":"<summary>","output":"<deliverable>"}` to close a delegated task.

**Don't:**
- Don't delegate without a concrete prompt, acceptance checks, and return contract.
- Don't stop a job until you have checked its result; stopping is a kill switch.
