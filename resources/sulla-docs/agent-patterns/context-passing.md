# Agent Patterns — Context & Data Flow

## How Node Outputs Flow Downstream

The workflow playbook maintains a `nodeOutputs` map. When a node completes, its result is stored keyed by `nodeId`. Every subsequent node receives all prior outputs as context.

**Upstream context format (auto-appended to agent instructions):**
```
[Research Agent]: Summary of findings...
[Load Context]: {"audience": {...}, "product": {...}}
[Trigger]: User said: "write me a blog post"
```

---

## Template Resolution

Templates in `orchestratorInstructions`, `prompt`, `responseTemplate`, etc. are resolved before the node executes:

```
{{trigger}}                 → original workflow trigger payload
{{Node Label}}              → output.result from node with that label
{{node-id}}                 → output.result from node with that ID
{{Node Label.result}}       → explicit .result field (same as above)
{{Node Label.threadId}}     → thread ID of the sub-agent run
{{loop.index}}              → current loop iteration (0-based)
{{loop.currentItem}}        → current for-each item
{{loop.currentItem.result}} → result field of current for-each item
```

**Matching is by node label first, then by node ID.** Keep labels stable — renaming a node breaks all downstream references.

Unresolved variables remain literal: `{{MissingNode}}` → `{{MissingNode}}`

---

## Output Structure

Each completed node produces:
```typescript
{
  nodeId: string,
  label: string,
  subtype: string,           // agent, function, response, etc.
  category: string,
  result: unknown,           // The agent's output, function return value, etc.
  completedAt: string,       // ISO 8601
  threadId?: string          // For sub-agent runs
}
```

For **agent** nodes: `result` is the full text the agent returned in its `<AGENT_DONE>` block.
For **function** nodes: `result` is the outputs object from the function handler.
For **orchestrator-prompt** nodes: `result` is the orchestrator's response text.
For **merge** nodes: `result` is `[{nodeId, label, result}, ...]` — array of all merged outputs.

---

## Merge Node Output

After a `parallel` + `merge` pattern:

```yaml
# In a downstream node:
orchestratorInstructions: |
  Merge result: {{Collect Results}}
  
  This is an array. Each entry has: nodeId, label, result.
  Synthesize all three analyses into one executive summary.
```

Or access by original node label:
```yaml
responseTemplate: |
  Twitter: {{Twitter Writer}}
  LinkedIn: {{LinkedIn Writer}}
  Instagram: {{Instagram Writer}}
```

---

## Function Node Output

Function outputs are returned as a flat object. Access them directly:

```yaml
# Function node "Read Cache" returns: { exists: true, needs_refresh: false, cache: {...} }

orchestratorInstructions: |
  Cache result: {{Read Cache}}
  
  The result object has fields: exists, needs_refresh, age_days, cache.
  If needs_refresh is true, research fresh ICP data.
  Otherwise use the cache object directly.
```

---

## Passing Data to a Sub-Workflow

When using `sub-workflow` nodes, the parent's trigger and prior outputs are passed to the child workflow as its trigger payload.

---

## Loop Context

Inside a loop body:
```yaml
orchestratorInstructions: |
  Processing item {{loop.index}} of the list.
  Current item: {{loop.currentItem}}
  
  Transform this item and return the result.
```

For `for-each` mode, `{{loop.currentItem}}` is each element from the upstream merge output.
For `iterations` mode, `{{loop.index}}` is the counter (0-based).

---

## Debugging Context Issues

If a template isn't resolving:
1. Check the node label matches exactly (case-sensitive, space-sensitive)
2. Check the node is actually upstream (connected via edges)
3. Check the upstream node completed successfully (AGENT_DONE, not BLOCKED)
4. Use `{{node-id}}` instead of `{{Node Label}}` as a fallback
