# Tool Call Display Improvements

**Status:** Assessment complete, ready for implementation
**Priority:** High — directly affects user trust and comprehension of agent activity
**Date:** 2026-03-15

---

## Problem Statement

Users see tool calls in the chat but lack sufficient context about what each tool is doing. Bash/exec tools show the command being run (`IN: npm install`), but all other tools display only a raw internal name like `pg_query` with no preview of what's happening. Users must expand the card and parse raw JSON to understand the action.

---

## Current State

### Components Involved

- `pkg/rancher-desktop/pages/Agent.vue` (lines 53-146) — Main chat tool card rendering
- `pkg/rancher-desktop/pages/editor/EditorChat.vue` (lines 85-169) — Editor panel chat tool card rendering
- `pkg/rancher-desktop/agent/database/models/AgentPersonaModel.ts` (lines 629-695) — Tool card creation from WebSocket events
- `pkg/rancher-desktop/agent/database/registry/AgentPersonaRegistry.ts` (lines 18-26) — `ChatMessage.toolCard` type definition

### What Users See Today

| Tool Type | Collapsed View | Expanded View |
|-----------|---------------|---------------|
| **Bash/exec tools** | Status dot + "Bash" + description (if any) + `IN: <command>` + `OUT: 0/1` | Full output text |
| **All other tools** | Status dot + raw tool name (e.g. `pg_query`) + description (if any) | Raw JSON dump of `args` + raw JSON dump of `result` |

### Identified Problems

1. **Non-exec tools show almost nothing in collapsed state** — No IN/OUT lines, no summary. Just a raw internal name and a colored dot.

2. **Raw tool names instead of human-friendly labels** — The system already has `TOOL_VERB_MAP` in `AgentPersonaModel.ts` (lines 72-121) with 50+ mappings (e.g. `pg_query` -> "Reading", `git_commit` -> "Committing", `docker_build` -> "Building image"). This map is **only used for the activity status indicator**, never for tool card labels.

3. **`description` field is rarely populated** — Extracted from `args.description` (line 653), but most tools don't include a `description` argument. Only exec/bash tools tend to have it, so most tool cards have no description.

4. **No contextual preview for non-exec tools** — Key information is buried in `args` and only visible when expanded:
   - `pg_query` — file path hidden
   - `git_commit` — commit message hidden
   - `pg_query` — SQL query hidden
   - `docker_build` — image name hidden
   - `github_create_pr` — PR title hidden

5. **Expanded view dumps raw JSON** — No formatting, no key-value highlighting, no summarization. Large results become walls of text in a 200-300px scrollable box.

6. **Code duplication** — Tool card template (~120 lines), helpers (~30 lines), and CSS (~120 lines) are fully duplicated between Agent.vue and EditorChat.vue.

---

## Recommendations

### Phase 1: Extract Component (Zero Risk)

**Extract `ToolCardCC.vue`** — Move the duplicated tool card template, helpers, and CSS into a single shared component. Both Agent.vue and EditorChat.vue import it.

Files to change:
- Create `pkg/rancher-desktop/components/ToolCardCC.vue`
- Update `pkg/rancher-desktop/pages/Agent.vue` — replace inline tool card with component
- Update `pkg/rancher-desktop/pages/editor/EditorChat.vue` — replace inline tool card with component

### Phase 2: Human-Friendly Labels (Low Effort, High Impact)

**Use `TOOL_VERB_MAP` for card labels** — Instead of showing `pg_query`, show "Read File" or "Reading". The mapping data already exists at `AgentPersonaModel.ts:72-121`.

Approach:
- Create a `TOOL_LABEL_MAP` (or extend verb map) that maps tool names to display-friendly labels
- Move the label function into the shared component or a shared utility
- Replace `toolCardLabel()` to use this map with fallback to the current `EXEC_TOOL_NAMES` logic

### Phase 3: Per-Tool Preview Lines (Medium Effort, Highest User Impact)

**Add contextual IN-line previews for non-exec tools** — Map each tool type to the key argument that should be surfaced:

| Tool | Args Key to Surface | Example Preview |
|------|-------------------|-----------------|
| `pg_query` | `path` | `IN: /src/utils/config.ts` |
| `slack_send_message` | `path` | `IN: /src/utils/config.ts` |
| `git_commit` | `message` | `IN: "fix: resolve null pointer"` |
| `git_checkout` | `branch` | `IN: feature/new-api` |
| `pg_query` | `query` or `sql` | `IN: SELECT * FROM users WHERE...` |
| `docker_build` | `tag` or `image` | `IN: my-image:latest` |
| `github_create_pr` | `title` | `IN: "Add caching layer"` |
| `slack_send_message` | `channel` | `IN: #engineering` |
| `execute_workflow` | `workflowId` or `name` | `IN: data-pipeline-v2` |
| `meta_search` | `query` | `IN: "authentication middleware"` |

Implementation:
- Create a `toolCardPreview(toolCard)` function that returns `string | null`
- Map `toolName` -> which `args` key to extract
- Truncate long values (e.g. SQL queries) to ~80 chars with ellipsis
- Show the preview line in the same `tool-card-cc-cmd` style as bash commands

### Phase 4: Result Summaries (Medium Effort, Good Polish)

**Add one-line result summary for completed tools** — Instead of just a dot color change, show a text summary:

| Tool | Summary Format |
|------|---------------|
| `pg_query` | `OUT: 247 lines` |
| `slack_send_message` | `OUT: written` |
| `git_commit` | `OUT: abc1234` |
| `git_status` | `OUT: 3 modified, 1 untracked` |
| `pg_query` | `OUT: 12 rows` |
| `docker_build` | `OUT: sha256:abc123...` |
| `github_create_pr` | `OUT: PR #142` |
| Generic success | `OUT: done` |
| Generic failure | `OUT: failed` |

Implementation:
- Create a `toolCardResultSummary(toolCard)` function
- Parse known result shapes for each tool type
- Fall back to `done` / `failed` for unknown tools

### Phase 5: Structured Expanded Views (Higher Effort, Nice-to-Have)

**Render structured output instead of raw JSON for known tool types:**

- `pg_query` results — syntax-highlighted code block
- `pg_query` results — simple HTML table
- `git_diff` results — diff-highlighted output
- `docker_ps` results — formatted container list
- All others — keep current JSON dump but with better formatting (key highlighting, collapsible nested objects)

---

## Data Flow Reference

```
BaseNode.emitToolCallEvent()
  -> WebSocket { phase: 'tool_call', toolRunId, toolName, args }
    -> AgentPersonaModel receives progress event
      -> Creates ChatMessage with toolCard { toolRunId, toolName, description, status: 'running', args }
        -> Agent.vue / EditorChat.vue renders tool-card-cc

BaseNode.emitToolResultEvent()
  -> WebSocket { phase: 'tool_result', toolRunId, success, error, result }
    -> AgentPersonaModel updates existing toolCard { status, error, result }
      -> Vue reactivity re-renders the card
```

---

## Key Files

| File | Purpose |
|------|---------|
| `pkg/rancher-desktop/pages/Agent.vue` | Main chat — tool card template + helpers + CSS |
| `pkg/rancher-desktop/pages/editor/EditorChat.vue` | Editor chat — duplicated tool card template + helpers + CSS |
| `pkg/rancher-desktop/agent/database/models/AgentPersonaModel.ts` | `TOOL_VERB_MAP` (lines 72-121), toolCard creation (lines 629-695) |
| `pkg/rancher-desktop/agent/database/registry/AgentPersonaRegistry.ts` | `ChatMessage` / `toolCard` type definitions |
| `pkg/rancher-desktop/agent/nodes/BaseNode.ts` | `emitToolCallEvent()` / `emitToolResultEvent()` — source of tool data |
| `pkg/rancher-desktop/agent/tools/registry.ts` | Tool registry with categories and metadata |
