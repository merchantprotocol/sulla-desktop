# Sulla Workflows — Node Types

Every node has `data.subtype` and `data.category`. The validator (`validate_sulla_workflow`) rejects a subtype under the wrong category. Required config fields below are the ones the validator enforces.

The editor palette offers only `manual`, `schedule`, and the node types listed below. Other trigger subtypes (`chat-app`, `calendar`, `heartbeat`, `sulla-desktop`, `workbench`, `chat-completions`) still validate so older routines load, but don't author new ones.

---

## TRIGGER Nodes (category: trigger)

Every workflow needs at least one trigger.

### manual
```yaml
subtype: manual
category: trigger
config:
  triggerType: manual
  triggerDescription: "Runs when manually launched from Routines"
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

---

## AGENT Nodes (category: agent)

### agent — spawn a sub-agent
```yaml
subtype: agent
category: agent
config:
  agentId: null                  # Agent slug or null (uses default)
  agentName: "My Agent"          # Display name
  additionalPrompt: ""           # Required key; extra system instructions
  orchestratorInstructions: |    # What the agent should do (supports {{templates}})
    Research {{trigger}} and return a summary.
    Use exec to run: sulla github/git_status '{}'
  successCriteria: "Summary returned"
  completionContract: "Exit when done"
```
All six keys are required. Optional: `inheritParentToolPolicy`, and `maxAgents` (only `1` is accepted).

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
  functionRef: "social-cache-read"   # Slug of a function in the functions table
  inputs:
    max_age_days: "7"
  integrationAccounts: {}            # Optional: integration slug -> accountId, or null to let the orchestrator pick
  timeoutOverride: null              # Optional, e.g. "60s"
```
Only `functionRef` is required. The runtime (python, node, shell) comes from the function's own `function.yaml`, not from this node. See [`functions/schema.md`](../functions/schema.md).

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
Required: `toolName`, `defaults`. Use `toolName: browser_controller` directly for browser work. Nested CLI calls don't carry the graph's browser capability.

### integration-call — call an integration endpoint
```yaml
subtype: integration-call
category: agent
config:
  integrationSlug: "anthropic"
  endpointName: "messages-create"
  accountId: "acct-123"
  defaults:
    model: "claude-haiku-5-5"
  preCallDescription: "Summarize the upstream output with a small model."
```
Required: all five keys above. The orchestrator sees `preCallDescription` before the call runs.

---

## ROUTING Nodes (category: routing)

### router — LLM picks a route
```yaml
subtype: router
category: routing
config:
  classificationPrompt: "Classify the input from {{previous-node}}"
  routes:
    - label: "Support"
      description: "Customer support inquiry"
    - label: "Sales"
      description: "Pricing question"
```
Routes are numbered by position. The first route is `route-0`, the second `route-1`, and so on. Edges must use those `sourceHandle` values.

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
Each outgoing edge is a branch. No `sourceHandle` is needed. Only children that are `agent`, `integration-call`, or `tool-call` nodes run as a concurrent batch. Routers, conditions, waits, and other nodes run one after another.

### merge — collect parallel outputs
```yaml
subtype: merge
category: flow-control
config:
  strategy: "wait-all"           # wait-all | first
```
`{{Merge Node.result}}` resolves to the JSON text of `{strategy, merged: [{nodeId, label, result}, ...]}`. Reference a branch directly with `{{Branch Label}}` when you need one branch's output.

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
  orchestratorPrompt: ""         # Used by ask-orchestrator
```
Required: `maxIterations`, `condition`, `conditionMode`. Inside the body, use `{{loop.index}}`, `{{loop.currentItem}}`, `{{loop.currentItem.result}}`, `{{loop.currentItem.label}}`, and `{{loop.currentItem.nodeId}}`. The `loop.currentItem` values resolve only while the loop has a current item, which is the `for-each` case.

Edges use `targetHandle: loop-entry` (entry), `targetHandle: loop-back` (re-entry), `sourceHandle: loop-start` (body), and `sourceHandle: loop-exit` (after the loop).

### sub-workflow — call another workflow
```yaml
subtype: sub-workflow
category: flow-control
config:
  workflowId: "workflow-analysis"
  awaitResponse: true
  agentId: null                  # Optional: agent that orchestrates the child
  orchestratorPrompt: ""         # Optional: instructions when agentId is set
```
Required: `workflowId`, `awaitResponse`.

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
The `responseTemplate` key is required. If its value is empty, the node passes through upstream output.

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
Cannot be inside a loop or a parallel branch. The run fails if it is.

### desktop-notification — shortcut for notify_user
```yaml
subtype: desktop-notification
category: io
config:
  toolName: notify_user
  defaults:
    title: "Task Complete"
    message: "{{upstream-node}} finished"
```
Required: `toolName`, `defaults`. The playbook always calls `notify_user`.
</content>
