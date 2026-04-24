# Sulla Workflows — Node Types

## TRIGGER Nodes (category: trigger)

Every workflow needs at least one trigger.

### manual
```yaml
subtype: manual
category: trigger
config:
  triggerType: manual
  triggerDescription: "Runs when manually launched from AgentRoutines"
```

### schedule
```yaml
subtype: schedule
category: trigger
config:
  triggerType: schedule
  triggerDescription: "Daily at 7am Pacific"
  frequency: daily              # every-minutes | hourly | daily | weekly | monthly
  intervalMinutes: 5            # For every-minutes
  hour: 7                       # 0-23
  minute: 0                     # 0-59
  dayOfWeek: 1                  # 0=Sun...6=Sat (weekly)
  dayOfMonth: 1                 # 1-31 (monthly)
  timezone: "America/Los_Angeles"
```

### chat-app
```yaml
subtype: chat-app
category: trigger
config:
  triggerType: chat-app
  triggerDescription: "Triggered by user message"
```

---

## AGENT Nodes (category: agent)

### agent — spawn a sub-agent
```yaml
subtype: agent
category: agent
config:
  agentId: null                  # Agent slug or null (uses default)
  agentName: "My Agent"          # Display name
  additionalPrompt: ""           # Extra system instructions
  orchestratorInstructions: |    # What the agent should do (supports {{templates}})
    Research {{trigger}} and return a summary.
    Use exec to run: sulla github/git_status '{}'
  successCriteria: "Summary returned"
  completionContract: "Exit when done"
```

### orchestrator-prompt — message the orchestrating agent directly
```yaml
subtype: orchestrator-prompt
category: agent
config:
  prompt: |
    Review the output from {{Research Agent}}.
    Return: approved | needs_revision
```

### function — call a custom function
```yaml
subtype: function
category: agent
config:
  functionRef: "social-cache-read"   # Slug from ~/sulla/functions/
  inputs:
    max_age_days: "7"
  timeoutOverride: null
```

### tool-call — call a native tool directly
```yaml
subtype: tool-call
category: agent
config:
  toolName: notify_user
  defaults:
    title: "Done"
    message: "{{upstream-node}} completed"
```

### desktop-notification — shortcut for notify_user
```yaml
subtype: desktop-notification
category: agent
config:
  defaults:
    title: "Task Complete"
    message: "{{upstream-node}} finished"
```

---

## ROUTING Nodes (category: routing)

### router — LLM picks a route
```yaml
subtype: router
category: routing
config:
  classificationPrompt: "Classify the input from {{previous-node}}"
  routes:
    - id: route-0
      label: "Support"
      description: "Customer support inquiry"
    - id: route-1
      label: "Sales"
      description: "Pricing question"
```
Edges must use `sourceHandle: route-0`, `route-1`, etc.

### condition — boolean branch
```yaml
subtype: condition
category: routing
config:
  rules:
    - field: "status"
      operator: "equals"         # equals|contains|greaterThan|lessThan
      value: "active"
  combinator: "and"              # and | or
```
Edges use `sourceHandle: condition-true` or `condition-false`.

---

## FLOW-CONTROL Nodes (category: flow-control)

### parallel — run branches concurrently
```yaml
subtype: parallel
category: flow-control
config: {}
```
Edges use `sourceHandle: branch-0`, `branch-1`, etc. Only agent/integration nodes can be parallelized — no routers, conditions, waits.

### merge — collect parallel outputs
```yaml
subtype: merge
category: flow-control
config:
  strategy: "wait-all"           # wait-all | first
```
Output available as `{{Merge Node.result}}` — array of `{nodeId, label, result}`.

### wait — pause execution
```yaml
subtype: wait
category: flow-control
config:
  delayAmount: 30
  delayUnit: "seconds"           # seconds | minutes | hours
```

### loop — iterate
```yaml
subtype: loop
category: flow-control
config:
  loopMode: "iterations"         # iterations | for-each | ask-orchestrator
  maxIterations: 10
  condition: ""
  conditionMode: "template"      # template | llm
  orchestratorPrompt: ""
```
Edges use `targetHandle: loop-entry` (entry), `targetHandle: loop-back` (re-entry), `sourceHandle: loop-start` (body), `sourceHandle: loop-exit` (after loop).

### sub-workflow — call another workflow
```yaml
subtype: sub-workflow
category: flow-control
config:
  workflowId: "workflow-analysis"
  awaitResponse: true
  agentId: null
```

---

## IO Nodes (category: io)

### response — send output to user
```yaml
subtype: response
category: io
config:
  responseTemplate: |
    Results:
    {{Research Agent}}
    Analysis: {{Synthesis Node}}
```
If `responseTemplate` is empty, passes through upstream output.

### user-input — pause for user input
```yaml
subtype: user-input
category: io
config:
  promptText: "Do you approve? (yes/no)"
```

### transfer — hand off to another workflow
```yaml
subtype: transfer
category: io
config:
  targetWorkflowId: "workflow-specialist"
```
Cannot be inside a loop or parallel branch.
