# Sulla Workflows — Working Examples

## Pattern 1: Simple Linear (Trigger → Agent → Response)

```yaml
id: workflow-simple-linear
name: Simple Linear
version: 1
createdAt: "2026-04-23T00:00:00.000Z"
updatedAt: "2026-04-23T00:00:00.000Z"
_status: production

nodes:
  - id: node-trigger
    type: workflow
    position: { x: 400, y: 0 }
    data:
      subtype: chat-app
      category: trigger
      label: User Request
      config:
        triggerType: chat-app
        triggerDescription: "Triggered by user chat message"

  - id: node-agent
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

  - id: node-response
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
    source: node-trigger
    target: node-agent
    animated: true
  - id: e-2
    source: node-agent
    target: node-response
    animated: true

viewport: { x: 0, y: 0, zoom: 1 }
```

---

## Pattern 2: Parallel + Merge

```yaml
id: workflow-parallel-merge
name: Parallel Analysis
version: 1
_status: production

nodes:
  - id: node-trigger
    type: workflow
    position: { x: 400, y: 0 }
    data:
      subtype: chat-app
      category: trigger
      label: Request
      config:
        triggerType: chat-app
        triggerDescription: "Parallel analysis request"

  - id: node-parallel
    type: workflow
    position: { x: 400, y: 160 }
    data:
      subtype: parallel
      category: flow-control
      label: Run in Parallel
      config: {}

  - id: node-branch-a
    type: workflow
    position: { x: 200, y: 340 }
    data:
      subtype: agent
      category: agent
      label: Branch A
      config:
        agentId: null
        agentName: "Agent A"
        orchestratorInstructions: "Do task A based on: {{trigger}}"
        successCriteria: "Task A complete"
        completionContract: "Exit when done"

  - id: node-branch-b
    type: workflow
    position: { x: 600, y: 340 }
    data:
      subtype: agent
      category: agent
      label: Branch B
      config:
        agentId: null
        agentName: "Agent B"
        orchestratorInstructions: "Do task B based on: {{trigger}}"
        successCriteria: "Task B complete"
        completionContract: "Exit when done"

  - id: node-merge
    type: workflow
    position: { x: 400, y: 520 }
    data:
      subtype: merge
      category: flow-control
      label: Collect Results
      config:
        strategy: wait-all

  - id: node-response
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
  - { id: e-1, source: node-trigger, target: node-parallel, animated: true }
  - { id: e-2, source: node-parallel, target: node-branch-a, sourceHandle: branch-0, animated: true }
  - { id: e-3, source: node-parallel, target: node-branch-b, sourceHandle: branch-1, animated: true }
  - { id: e-4, source: node-branch-a, target: node-merge, animated: true }
  - { id: e-5, source: node-branch-b, target: node-merge, animated: true }
  - { id: e-6, source: node-merge, target: node-response, animated: true }

viewport: { x: 0, y: 0, zoom: 1 }
```

---

## Pattern 3: Scheduled + Function

```yaml
id: workflow-scheduled-function
name: Daily Function Run
version: 1
_status: production
enabled: true

nodes:
  - id: node-trigger
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

  - id: node-function
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

  - id: node-agent
    type: workflow
    position: { x: 400, y: 360 }
    data:
      subtype: agent
      category: agent
      label: Generate Content
      config:
        agentId: null
        agentName: "Content Writer"
        orchestratorInstructions: |
          Cache result: {{Read Cache}}
          If needs_refresh is true, research fresh content.
          Generate today's post.
        successCriteria: "Post generated"
        completionContract: "Exit when post is written"

  - id: node-response
    type: workflow
    position: { x: 400, y: 540 }
    data:
      subtype: response
      category: io
      label: Done
      config:
        responseTemplate: "{{Generate Content}}"

edges:
  - { id: e-1, source: node-trigger, target: node-function, animated: true }
  - { id: e-2, source: node-function, target: node-agent, animated: true }
  - { id: e-3, source: node-agent, target: node-response, animated: true }

viewport: { x: 0, y: 0, zoom: 1 }
```

---

## Pattern 4: Router

```yaml
id: workflow-router
name: Request Router
version: 1

nodes:
  - id: node-trigger
    type: workflow
    position: { x: 400, y: 0 }
    data:
      subtype: chat-app
      category: trigger
      label: Incoming
      config: { triggerType: chat-app, triggerDescription: "Route by type" }

  - id: node-router
    type: workflow
    position: { x: 400, y: 180 }
    data:
      subtype: router
      category: routing
      label: Route Type
      config:
        classificationPrompt: "Classify: {{trigger}}"
        routes:
          - { id: route-0, label: "TypeA", description: "First type" }
          - { id: route-1, label: "TypeB", description: "Second type" }

  - id: node-a
    type: workflow
    position: { x: 200, y: 360 }
    data:
      subtype: agent
      category: agent
      label: Handle A
      config:
        agentId: null
        agentName: "Handler A"
        orchestratorInstructions: "Handle type A: {{trigger}}"
        successCriteria: "Done"
        completionContract: "Exit when done"

  - id: node-b
    type: workflow
    position: { x: 600, y: 360 }
    data:
      subtype: agent
      category: agent
      label: Handle B
      config:
        agentId: null
        agentName: "Handler B"
        orchestratorInstructions: "Handle type B: {{trigger}}"
        successCriteria: "Done"
        completionContract: "Exit when done"

edges:
  - { id: e-1, source: node-trigger, target: node-router }
  - { id: e-2, source: node-router, target: node-a, sourceHandle: route-0 }
  - { id: e-3, source: node-router, target: node-b, sourceHandle: route-1 }
```
