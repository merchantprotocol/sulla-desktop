# Sulla Workflows — Working Examples

These pass `validate_sulla_workflow`. Set the row status with `workflow/import_workflow` (`status`), not inside the YAML.

## Pattern 1: Simple Linear (Trigger → Agent → Response)

```yaml
id: workflow-simple-linear
name: Simple Linear
description: Answer a request with one research agent.
version: 1
createdAt: "2026-04-23T00:00:00.000Z"
updatedAt: "2026-04-23T00:00:00.000Z"

nodes:
  - id: node-001
    type: workflow
    position: { x: 400, y: 0 }
    data:
      subtype: manual
      category: trigger
      label: User Request
      config:
        triggerType: manual
        triggerDescription: "Launched manually with a request"

  - id: node-002
    type: workflow
    position: { x: 400, y: 180 }
    data:
      subtype: agent
      category: agent
      label: Research Agent
      config:
        agentId: null
        agentName: "Researcher"
        additionalPrompt: ""
        orchestratorInstructions: |
          The user asked: {{trigger}}
          Research this topic and return a concise summary.
        successCriteria: "Summary returned"
        completionContract: "Exit when done"

  - id: node-003
    type: workflow
    position: { x: 400, y: 360 }
    data:
      subtype: response
      category: io
      label: Send Response
      config:
        responseTemplate: "{{Research Agent}}"

edges:
  - id: e-1
    source: node-001
    target: node-002
    animated: true
  - id: e-2
    source: node-002
    target: node-003
    animated: true

viewport: { x: 0, y: 0, zoom: 1 }
```

---

## Pattern 2: Parallel + Merge

```yaml
id: workflow-parallel-merge
name: Parallel Analysis
description: Run two agents at once and send both results.
version: 1

nodes:
  - id: node-001
    type: workflow
    position: { x: 400, y: 0 }
    data:
      subtype: manual
      category: trigger
      label: Request
      config:
        triggerType: manual
        triggerDescription: "Parallel analysis request"

  - id: node-002
    type: workflow
    position: { x: 400, y: 160 }
    data:
      subtype: parallel
      category: flow-control
      label: Run in Parallel
      config: {}

  - id: node-003
    type: workflow
    position: { x: 200, y: 340 }
    data:
      subtype: agent
      category: agent
      label: Branch A
      config:
        agentId: null
        agentName: "Agent A"
        additionalPrompt: ""
        orchestratorInstructions: "Do task A based on: {{trigger}}"
        successCriteria: "Task A complete"
        completionContract: "Exit when done"

  - id: node-004
    type: workflow
    position: { x: 600, y: 340 }
    data:
      subtype: agent
      category: agent
      label: Branch B
      config:
        agentId: null
        agentName: "Agent B"
        additionalPrompt: ""
        orchestratorInstructions: "Do task B based on: {{trigger}}"
        successCriteria: "Task B complete"
        completionContract: "Exit when done"

  - id: node-005
    type: workflow
    position: { x: 400, y: 520 }
    data:
      subtype: merge
      category: flow-control
      label: Collect Results
      config:
        strategy: wait-all

  - id: node-006
    type: workflow
    position: { x: 400, y: 700 }
    data:
      subtype: response
      category: io
      label: Done
      config:
        responseTemplate: |
          A: {{Branch A}}
          B: {{Branch B}}

edges:
  - { id: e-1, source: node-001, target: node-002, animated: true }
  - { id: e-2, source: node-002, target: node-003, animated: true }
  - { id: e-3, source: node-002, target: node-004, animated: true }
  - { id: e-4, source: node-003, target: node-005, animated: true }
  - { id: e-5, source: node-004, target: node-005, animated: true }
  - { id: e-6, source: node-005, target: node-006, animated: true }

viewport: { x: 0, y: 0, zoom: 1 }
```

---

## Pattern 3: Scheduled + Function

```yaml
id: workflow-scheduled-function
name: Daily Function Run
description: Read a cache with a function, then write today's post.
version: 1
enabled: true

nodes:
  - id: node-001
    type: workflow
    position: { x: 400, y: 0 }
    data:
      subtype: schedule
      category: trigger
      label: Daily 7am
      config:
        triggerType: schedule
        triggerDescription: "Fires daily at 7am Pacific"
        frequency: daily
        hour: 7
        minute: 0
        timezone: "America/Los_Angeles"

  - id: node-002
    type: workflow
    position: { x: 400, y: 180 }
    data:
      subtype: function
      category: agent
      label: Read Cache
      config:
        functionRef: "social-cache-read"
        inputs:
          max_age_days: "7"

  - id: node-003
    type: workflow
    position: { x: 400, y: 360 }
    data:
      subtype: agent
      category: agent
      label: Generate Content
      config:
        agentId: null
        agentName: "Content Writer"
        additionalPrompt: ""
        orchestratorInstructions: |
          Cache result: {{Read Cache}}
          If needs_refresh is true, research fresh content.
          Generate today's post.
        successCriteria: "Post generated"
        completionContract: "Exit when post is written"

  - id: node-004
    type: workflow
    position: { x: 400, y: 540 }
    data:
      subtype: response
      category: io
      label: Done
      config:
        responseTemplate: "{{Generate Content}}"

edges:
  - { id: e-1, source: node-001, target: node-002, animated: true }
  - { id: e-2, source: node-002, target: node-003, animated: true }
  - { id: e-3, source: node-003, target: node-004, animated: true }

viewport: { x: 0, y: 0, zoom: 1 }
```

---

## Pattern 4: Router

```yaml
id: workflow-router
name: Request Router
description: Send each request to one of two handlers.
version: 1

nodes:
  - id: node-001
    type: workflow
    position: { x: 400, y: 0 }
    data:
      subtype: manual
      category: trigger
      label: Incoming
      config: { triggerType: manual, triggerDescription: "Route by type" }

  - id: node-002
    type: workflow
    position: { x: 400, y: 180 }
    data:
      subtype: router
      category: routing
      label: Route Type
      config:
        classificationPrompt: "Classify: {{trigger}}"
        routes:
          - { label: "TypeA", description: "First type" }
          - { label: "TypeB", description: "Second type" }

  - id: node-003
    type: workflow
    position: { x: 200, y: 360 }
    data:
      subtype: agent
      category: agent
      label: Handle A
      config:
        agentId: null
        agentName: "Handler A"
        additionalPrompt: ""
        orchestratorInstructions: "Handle type A: {{trigger}}"
        successCriteria: "Done"
        completionContract: "Exit when done"

  - id: node-004
    type: workflow
    position: { x: 600, y: 360 }
    data:
      subtype: agent
      category: agent
      label: Handle B
      config:
        agentId: null
        agentName: "Handler B"
        additionalPrompt: ""
        orchestratorInstructions: "Handle type B: {{trigger}}"
        successCriteria: "Done"
        completionContract: "Exit when done"

edges:
  - { id: e-1, source: node-001, target: node-002 }
  - { id: e-2, source: node-002, target: node-003, sourceHandle: route-0 }
  - { id: e-3, source: node-002, target: node-004, sourceHandle: route-1 }
```
