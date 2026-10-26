# `@` Mentions — How Users Reference Artifacts

When a user types `@` in the chat composer, an autocomplete popover surfaces things they have **on this machine** — in their Library or My Work. The agent receives the selected token verbatim inside the user's message. This doc explains what those tokens mean and how to resolve them.

## Token format

Every mention is `@<kind>:<identifier>`:

| Kind | Identifier | Source on disk |
|------|-----------|----------------|
| `@routine:<slug>` | slug | `~/sulla/routines/<slug>/routine.yaml` |
| `@skill:<slug>` | slug | `~/sulla/skills/<slug>/SKILL.md` (or `resources/skills/…`) |
| `@function:<slug>` | slug | `~/sulla/functions/<slug>/function.yaml` |
| `@recipe:<slug>` | slug | `~/sulla/recipes/<slug>/manifest.yaml` |
| `@integration:<slug>` | slug | `~/sulla/integrations/<slug>/` or `resources/integrations/…` |
| `@workflow:<id>` | DB id | `workflows` table row (status: draft / production / archive) |

The composer only offers tokens for artifacts that **already exist locally**. If a mention is in the user's message, the referenced item was real at composer time. It may have been deleted since — always verify before acting on it.

## What's NOT in the mention surface

Deliberately absent:
- Source files (`.ts`, `.vue`, codebase paths). Users aren't meant to reference engine internals.
- Memory ids (`@mem:…`). Engine-internal.
- Agent names (`@heartbeat`, etc.). Use the channel-message system instead (`<channel:heartbeat>…</channel:heartbeat>`).
- Calendar events, CRM leads, goals, contacts. Not wired (yet).

If a user pastes a filename or memory id after `@`, treat it as literal text — they aren't using the mention system.

## How to resolve a mention

When you see `@kind:identifier` in a user message, use the matching inspect tool. Read the manifest first, then act.

### `@routine:<slug>`
```bash
cat ~/sulla/routines/<slug>/routine.yaml
```
For non-destructive inspection, read the YAML. For "run it", use `meta/execute_workflow`, and only for a slug listed under "Available workflows". Otherwise import it first with `workflow/import_workflow`, which defaults to `production`, so pass `"status":"draft"`.

### `@skill:<slug>`
```bash
cat ~/sulla/skills/<slug>/SKILL.md
# or pull from resources/ if the user hasn't forked:
cat ~/sulla/resources/skills/<slug>/SKILL.md
```
A skill is a prompt+protocol the agent loads to gain a capability. Reading the SKILL.md is usually enough to know what it does.

### `@function:<slug>`
```bash
sulla function/list '{}'                       # confirm presence + metadata
cat ~/sulla/functions/<slug>/function.yaml
# run it:
sulla function/run '{"slug":"<slug>","inputs":{…}}'
```

### `@recipe:<slug>`
```bash
cat ~/sulla/recipes/<slug>/manifest.yaml
cat ~/sulla/recipes/<slug>/docker-compose.yml
# start the stack:
sulla extensions/start_extension '{"id":"<id-from-manifest>"}'
```

### `@integration:<slug>`
```bash
cat ~/sulla/integrations/<slug>/integration.yaml
# test the connection (if connected):
sulla <account_id>/<slug> '{"method":"GET","path":"/ping"}'
```
The integration manifest tells you the available endpoints, auth type, and vault keys.

### `@workflow:<id>`
```bash
# Inspect via Postgres:
sulla pg/query '{"sql":"SELECT * FROM workflows WHERE id = $1","params":["<id>"]}'
# List recent runs, or checkpoints for one run:
sulla meta/restart_from_checkpoint '{"workflowId":"<id>"}'
sulla meta/restart_from_checkpoint '{"executionId":"<id>"}'
```

### `@project:<slug>`

Read Projects/<slug>/PROJECT.md and TASKS.md with Files tools.


## Intent inference

A mention in a user message is a noun reference — the verb is in the surrounding prose. Examples:

| User message | Intent |
|--------------|--------|
| "run @function:csv-to-json on last week's export" | Invoke the function with that input |
| "what does @routine:daily-planning do?" | Read the YAML, summarize |
| "@project:first-client-acquisition — where are we?" | `search_project_items` + `get_project_item`; PRD only if you need the spec |
| "pair @function:pdf-extract with @routine:blog-publisher" | Plan a workflow/routine that chains them |
| "update @workflow:wf-123 to run at 9am instead of 7am" | Edit the schedule trigger config |

If the verb is ambiguous, ask one clarifying question before acting — don't guess whether "use @function:x" means "run it now" or "reference it in a new workflow you're building."

## Hard rules

- **Always verify the artifact still exists** before acting. `function/list`, reading the manifest, or a `SELECT` on `workflows` will tell you.
- **Never manufacture a mention in your reply.** You can talk about an artifact by name in prose, but don't emit `@kind:slug` tokens yourself — those are for the user's input.
- **A mention is a hint, not a command.** The user may have typed `@function:x` as context while asking something unrelated. Read the whole message before jumping to the tool call.

## Reference

- Composable: `pkg/sulla-desktop/pages/chat/composables/useArtifactMentions.ts`
- Backing IPC handlers: `main/sullaLibraryEvents.ts`, `sullaFunctionEvents.ts`, `sullaRoutineTemplateEvents.ts`, `sullaWorkflowEvents.ts`, `sullaProjectEvents.ts`
- Token type: `pages/chat/models/Command.ts` (`MentionTarget.kind`)
- Popover: `pages/chat/components/composer/CommandPopover.vue`


Projects are plain files. See [Projects in Files](../environment/projects-in-files.md).
