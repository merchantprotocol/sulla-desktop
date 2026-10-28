---
slug: sulla-write-a-worker-brief
label: Write a complete brief for a worker agent
trigger_when: When you need to hand work to a sub-agent without follow-up questions, missing context, duplicated work, or an unclear definition of done.
trigger_actions: [write a worker brief, prepare delegation, define acceptance checks, specify a return contract]
trigger_phrases: [worker brief, brief an agent, delegation prompt, self-contained task, definition of done, return shape]
scope: [sulla-agents]
---

**When:** Write this before every non-trivial `meta/spawn_agent` task. The first launch should contain everything the worker needs. A message sent later can interrupt the worker at a model-call boundary and may end its current line of work early.

**Do:**
1. State one outcome and why it matters. Describe what changes for the human when the task succeeds.
2. Give the complete starting state: repository and base branch, exact worktree or workspace rule, owned files, project task entry, identifiers, URLs, relevant source locations, constraints, and what has already been tried.
3. State what is out of bounds. Name files, systems, branches, data, actions, and adjacent problems the worker must not touch.
4. Define exact completion evidence. Name the checks, expected behavior, required commit and PR state, cleanup, and any checks deliberately forbidden.
5. Define the return contract. Ask for concrete artifacts such as a PR URL, head SHA, changed files, verification performed, cleanup receipt, and remaining risks. Use a JSON Schema contract for machine-checkable output.
6. Read the brief once from the worker's position. If it would need to ask where, which branch, what counts as done, or what to return, add that now.

**Template:**
```text
Goal and why
- Outcome: <one observable result>
- Why: <value or risk addressed>

Starting state
- Repo/workspace: <exact location and base>
- Task/project: <exact id or file entry>
- Inputs: <paths, ids, links, examples>
- Prior work: <what was tried and what happened>
- Read first: <source and policy files>

Scope
- Own: <files, services, or decisions>
- Out of bounds: <explicit exclusions>
- Constraints: <safety, privacy, dependencies, no-test or no-send rules>

Done means
1. <observable acceptance check>
2. <verification evidence>
3. <commit/push/PR or deliverable state>
4. <cleanup state>

Return
- Status: completed, blocked, or failed
- Summary: <one paragraph>
- Output: <exact artifact fields and remaining risks>
```

**Contract example:**
`{"name":"result","description":"Verified delivery result","schema":{"type":"object","required":["status","summary","output"],"properties":{"status":{"type":"string","enum":["completed","blocked","failed"]},"summary":{"type":"string"},"output":{"type":"object","required":["artifacts","verification","cleanup"],"properties":{"artifacts":{"type":"array"},"verification":{"type":"array"},"cleanup":{"type":"array"}}}}}}`

**Check it worked:**
- The worker can begin without asking for basic facts.
- The worker and parent can test the same objective definition of done.
- The returned fields are sufficient to inspect, recover, or integrate the work.

**Don't:**
- Don't paste a vague request such as "handle this" or "fix the bug."
- Don't rely on context from the parent conversation that is absent from the prompt.
- Don't hide failed attempts; they prevent repeated dead ends.
- Don't include secrets or irrelevant personal data.
- Don't confuse a worker's return shape with proof of correctness. The parent still reviews it.
