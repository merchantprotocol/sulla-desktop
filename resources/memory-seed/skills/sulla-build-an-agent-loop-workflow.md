---
slug: sulla-build-an-agent-loop-workflow
label: Build an agent workflow that loops until a check passes
trigger_when: When an agent should revise, retry, or keep working until a quality check passes, with a hard iteration limit.
trigger_actions: [loop an agent, retry until pass, quality gate workflow, iterative agent workflow]
trigger_phrases: [agent loop, loop until it passes, retry until success, quality gate, max iterations]
scope: [sulla-workflows]
---

**When:** Use this pattern for bounded revision. Prefer a deterministic function check when pass/fail can be computed in code.

**Do:**
1. Put the loop before the agent. The loop owns iteration state and shares one loop thread across iterations.
2. Return the body to the loop with `targetHandle: loop-back`. Set both a stop condition and `maxIterations`.
3. Use `conditionMode: template` for a literal machine-readable result such as `PASS`. Use `llm` only when code cannot judge the result.
4. Start from this complete definition:

```yaml
id: bounded-agent-review
name: Bounded agent review
description: Revises work until the agent reports PASS or three attempts finish.
version: "1"
enabled: true
maxConcurrentRuns: 1
nodes:
  - id: node-1
    type: workflow
    position: { x: 80, y: 120 }
    data:
      subtype: manual
      category: trigger
      label: Manual trigger
      config:
        triggerType: manual
        triggerDescription: Start with the text to review.
  - id: node-2
    type: workflow
    position: { x: 320, y: 120 }
    data:
      subtype: loop
      category: flow-control
      label: Revision loop
      config:
        loopMode: iterations
        maxIterations: 3
        condition: "{{node-3.result}} contains PASS"
        conditionMode: template
        orchestratorPrompt: ""
  - id: node-3
    type: workflow
    position: { x: 560, y: 120 }
    data:
      subtype: agent
      category: agent
      label: Review and revise
      config:
        agentId: sulla-desktop
        agentName: Sulla
        additionalPrompt: Return PASS when the result meets the criteria; otherwise revise it.
        orchestratorInstructions: "Review this input: {{trigger}}. This is iteration {{loop.index}}. Return the revised text and end with PASS only when it meets the request."
        successCriteria: The result satisfies the input request.
        completionContract: Return the result as plain text.
  - id: node-4
    type: workflow
    position: { x: 800, y: 120 }
    data:
      subtype: response
      category: io
      label: Final response
      config:
        responseTemplate: "{{node-3.result}}"
edges:
  - id: edge-1
    source: node-1
    target: node-2
    sourceHandle: out
    targetHandle: loop-entry
  - id: edge-2
    source: node-2
    target: node-3
    sourceHandle: loop-start
    targetHandle: in
  - id: edge-3
    source: node-3
    target: node-2
    sourceHandle: out
    targetHandle: loop-back
  - id: edge-4
    source: node-2
    target: node-4
    sourceHandle: loop-exit
    targetHandle: in
viewport: { x: 0, y: 0, zoom: 1 }
```

5. Save it outside Files while checking it. Validate: `sulla meta/validate_sulla_workflow '{"filePath":"/mnt/worktrees/<job>/routine.yaml"}'`.
6. Dry-run: `sulla meta/dry_run_workflow '{"filePath":"/mnt/worktrees/<job>/routine.yaml"}'`. A dry run reports ambiguous runtime branches but executes nothing.
7. Import and publish it with the workflow build skill. Run it with `sulla meta/execute_workflow '{"workflowId":"bounded-agent-review","message":"<text and criteria>"}'`.
8. Inspect the live result with `sulla workflow/routine_report '{"slug":"bounded-agent-review","last_k":1}'`. If it fails, fix it and restart from a checkpoint instead of replaying successful work.

**Add decisions:** A router selects one `route-N` edge. A condition selects `condition-true` or `condition-false`. A `user-input` node pauses for a human answer; put it before an approval-gated action.

**Don't:** Build an unbounded cycle, rely on prose that never emits a stable pass token, or use a model check when a function can return a boolean.
