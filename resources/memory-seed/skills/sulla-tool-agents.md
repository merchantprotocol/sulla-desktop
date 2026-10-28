---
slug: sulla-tool-agents
label: Use the Sulla agents tools
trigger_when: When you need to delegate work or inspect agent jobs and conversations.
trigger_actions: [agents, Sulla agents tool, tool call]
trigger_phrases: [agents]
scope: [tool-agents]
---

**When:** Use `exec` to dispatch an exact `sulla agents/<tool>` command. Discover current tools with `sulla meta/browse_tools '{"category":"agents"}'` before an unfamiliar call.

**Tools:**
- `sulla agents/spawn_agent '{"prompt":"<prompt>","name":"<name>"}'`: The one way to delegate. Launch one or more child agents, each with a return contract. visibility "hidden" (default) runs the child in the background; visibility "tab" opens it as a live chat tab the human can join (use for leads that run their own team or keep a visible Playbook). Every child shows in your sub-agent rail and your <subagent_directory> block, finishes with agents/return_result, and its result wakes you. Supports parallel execution and async (fire-and-forget) mode for hidden children. Required: prompt, name.
- `sulla agents/return_result '{}'`: Finish your delegated task by returning its contract to the agent that launched you (hidden worker or agent tab). The result is checked against the contract in your brief; a mismatch is refused so you can fix it. Default contract: {status: completed|blocked|failed, summary, output}. A tab closes only when you call this. Required: none.
- `sulla agents/check_agent_jobs '{}'`: Inspect delegated jobs (hidden and tab), including visibility, contract, per-task elapsed time, latest and recent check-ins, blockers, touched files, and undelivered orchestrator-message counts. Required: none.
- `sulla agents/send_job_message '{"jobId":"<jobId>","message":"<message>"}'`: Send new direction to one or all running tasks in a delegated job, hidden or tab. Hidden workers get it live when possible, otherwise at their next model-call boundary; a tab child gets it in its chat (steers a live turn or starts one). Required: jobId, message.
- `sulla agents/report_progress '{"step":"<step>","summary":"<summary>"}'`: Record a milestone check-in for your current delegated task (hidden worker or agent tab). Call it at meaningful milestones and at least every ~5 minutes; your parent sees it in its subagent directory. Required: step, summary.
- `sulla agents/stop_agent_job '{"jobId":"<jobId>"}'`: Kill switch for a running delegated job, hidden or tab. Hidden: fires the job\'s abort signal, which cascades to every sub-agent it spawned, unwinding them cooperatively (an in-flight LLM/tool call finishes first). Tab: stops the tab\'s live turn and closes its contract. Use when a job was misfired, duplicated, stalled, or is no longer needed; check_agent_jobs afterwards confirms it settled as \'stopped\'. Required: jobId.
- `sulla agents/start_agent_conversation '{"prompt":"<prompt>"}'`: DEPRECATED compatibility wrapper over spawn_agent. Launches one async job and returns jobId plus a conversationId alias. Results wake the parent graph; use check_agent_jobs only as fallback/history. Multi-turn follow-ups are not supported. Required: prompt.
- `sulla agents/send_agent_message '{"conversationId":"<conversationId>","message":"<message>"}'`: DEPRECATED conversation compatibility surface. For a running spawn_agent job, use send_job_message with its jobId instead. Required: conversationId, message.
- `sulla agents/read_agent_conversation '{}'`: Read the transcript of an open sub-agent conversation, or list all open conversations when called without a conversationId. Required: none.
- `sulla agents/close_agent_conversation '{"conversationId":"<conversationId>"}'`: Close a sub-agent conversation and free its resources (drops the sub-agent\'s graph + state). Do this when you\'re done talking to a sub-agent. Required: conversationId.
- `sulla agents/list_agents '{"schemaDef":"<schemaDef>"}'`: List the live named agents you can message (heartbeat, mobile-relay, other frontends) with their channel, status, and uptime — the roster from turn context, queryable on demand. Message any with a <channel:CHANNEL>text</channel:CHANNEL> tag (fire-and-forget; the reply arrives on a later turn). Use spawn_agent for bounded delegated work. Required: schemaDef.

**Do:**
1. Discover the category when names or parameters may have changed.
2. Run the command through `exec`, passing one JSON object with required parameters.
3. Treat returned IDs, cursors, and SHAs as inputs to the next call; verify destructive or outward-facing results.

**Don't:**
- Don't spawn vague work without a self-contained task and return contract.
- Don't stop or delete jobs without checking the job and preserving results.
