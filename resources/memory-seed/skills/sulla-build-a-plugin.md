---
slug: sulla-build-a-plugin
label: Build a Sulla plugin end to end
trigger_when: When someone asks to build, install, test, package, or submit any Sulla plugin, plug-in, add-on, extension, skill, function, workflow, agent, recipe, integration, or memory pack.
trigger_actions: [choose plugin kind, scaffold plugin, validate plugin, install plugin, test plugin, package plugin, submit plugin]
trigger_phrases: [build a plugin, build an add-on, plug-in for Sulla, extend Sulla, create an extension, publish my plugin]
scope: [sulla-plugins, sulla-use-cases, sulla-marketplace]
---

**When:** Build the smallest kind that solves the human's goal.

**Choose:**
- **Skill:** reusable Markdown instructions; no executable code.
- **Function:** deterministic Python, Node, or shell with typed inputs and outputs.
- **Workflow:** triggers, schedules, tools, functions, agents, branches, waits, retries, or approvals.
- **Agent:** a named specialist with its own prompt, model, and tool policy. Agents are local-only for marketplace publishing today.
- **Recipe:** a long-running Docker Compose service, often with a web UI.
- **Integration:** auth plus declared REST or MCP endpoints. Use a signed integration package only for executable catalog code behind a brokered proxy.
- **Extension Contract function:** granted hooks, filters, or declarative UI contributions.
- **Memory pack:** installable subjects and skills that teach agents domain knowledge.

**Do:**
1. Search before building: `sulla marketplace/search '{"query":"<human goal>","limit":25}'`. Inspect candidates with `sulla marketplace/info '{"kind":"<kind>","slug":"<slug>"}'`.
2. Pick a lowercase kebab-case slug. Scaffold a database draft: `sulla marketplace/scaffold '{"kind":"function","slug":"my-helper","name":"My helper","description":"Does one narrow job","runtime":"python"}'`. Kinds are `skill`, `function`, `workflow`, `agent`, `recipe`, and `integration`; function runtimes are `python`, `node`, or `shell`.
3. Alternatively copy the matching starter from `examples/extensions/hello-skill`, `hello-function-python`, `hello-function-node`, `hello-workflow`, or `hello-recipe`. Store human-authored drafts in `/mnt/sulla-files/Use Cases/<kind-plural>/<slug>/`. Do not create a second copy if a draft already exists.
4. Fill the kind's complete minimum manifest:

```yaml
# skill: SKILL.md frontmatter
---
sullaApi: ^1.0.0
hooks: []
---
# My skill
Use this when ...
```

```yaml
# function: function.yaml
apiVersion: sulla/v1
sullaApi: ^1.0.0
hooks: []
kind: Function
id: function-my-helper
slug: my-helper
name: My helper
description: Does one narrow job.
schemaversion: 1
spec:
  runtime: python
  entrypoint: main.py::handler
  inputs: {text: {type: string, required: true}}
  outputs: {result: {type: string}}
  timeout: 10s
  permissions: {network: []}
```

```yaml
# workflow: routine.yaml
sullaApi: ^1.0.0
hooks: []
id: my-flow
name: My flow
description: Runs one manual step.
version: "1"
enabled: true
nodes:
  - id: trigger-1
    type: workflow
    position: {x: 100, y: 100}
    data: {subtype: manual, category: trigger, label: Manual, config: {}}
edges: []
viewport: {x: 0, y: 0, zoom: 1}
```

```yaml
# exported agent manifest, sulla/v3
apiVersion: sulla/v3
kind: Agent
manifestVersion: 1
metadata: {slug: research-helper, title: Research helper, description: Researches one question., version: 1.0.0}
spec:
  prompt: "Research the assigned question and cite evidence."
  tools: [browser]
  skills: []
  config: {}
  promptFiles: {}
```

```yaml
# recipe: installation.yaml
slug: my-service
name: My service
description: Runs a local service.
version: "1.0.0"
compose: {composeFile: docker-compose.yml}
setup: []
commands:
  start: docker compose -f ${COMPOSE_FILE} up -d
  stop: docker compose -f ${COMPOSE_FILE} down
  status: docker compose -f ${COMPOSE_FILE} ps
```

```yaml
# ordinary integration auth: my-api.v1-auth.yaml
api: {name: my-api, version: "1", provider: "", base_url: "https://api.example.com", transport: rest}
auth: {type: apiKey, header: X-API-Key}
```

```yaml
# ordinary integration endpoint: records.v1.yaml
endpoint:
  name: records
  description: Lists records.
  path: /v1/records
  method: GET
  auth: required
```

```yaml
# memory pack: SKILL.md frontmatter
---
slug: my-memory
memory_pack: true
---
# My memory pack
```

`memory/manifest.json`:

```json
{"version": 1}
```

5. Implement only declared behavior. Keep credentials out of source and fixtures. Use exact typed inputs, bounded output, finite workflow loops, fixed image versions, persistent recipe data, and least privilege.
6. Validate the saved artifact: `sulla marketplace/validate '{"kind":"function","slug":"my-helper"}'`. For workflows also run `sulla meta/validate_sulla_workflow '{"filePath":"/mnt/worktrees/<job>/routine.yaml"}'` and `sulla meta/dry_run_workflow '{"filePath":"/mnt/worktrees/<job>/routine.yaml"}'`.
7. Review every changed Files version with `sulla files/history '{"path":"/mnt/sulla-files/Use Cases/functions/my-helper/function.yaml"}'`. Request activation for each reviewed draft with `sulla files/request_publish '{"file_id":"<file-id>","version_id":"<version-id>","reason":"Validated plugin ready for local testing"}'`. Wait for approval in Decide; a draft is not installed.
8. Test the active plugin through its real boundary:
   - Function: `sulla function/run '{"slug":"my-helper","inputs":{"text":"sample"}}'`, then inspect `sulla function/runs '{"slug":"my-helper","limit":1,"verbose":true}'`.
   - Workflow: `sulla meta/execute_workflow '{"workflowId":"my-flow","message":"sample"}'` and inspect the terminal result.
   - Skill: invoke its trigger phrase in a fresh turn and check the agent follows it.
   - Agent: launch it with a harmless bounded task and inspect its returned contract.
   - Recipe: follow `sulla-build-a-recipe`; confirm container status and open every declared URL.
   - Integration: use a test account, call one read endpoint through `sulla <account-id>/<slug>`, and confirm an undeclared route is unavailable.
   - Memory pack: install or sync it, start a fresh relevant turn, and confirm recall includes the pack; uninstall and confirm the pack rows disappear while core memory returns.
9. Iterate on the same slug and files. Revalidate and repeat the real runtime check after every material change.
10. Package only required manifests, entrypoints, docs, and icons. Exclude secrets, `.env`, keys, `.git`, `node_modules`, caches, logs, and build output. Use semantic versions for marketplace artifacts.
11. Prepare an exact submission summary: kind, slug, version, description, permissions, included files, tests, and privacy review. Then block on: `sulla meta/ask_user_question '{"questions":[{"header":"Submit plugin","question":"Submit this reviewed plugin to the Sulla Marketplace?","options":[{"label":"Approve","description":"Submit exactly this reviewed artifact for marketplace review."},{"label":"Deny","description":"Keep it local and submit nothing."}]}]}'`.
12. Only after **Approve**, submit: `sulla marketplace/publish '{"kind":"<kind>","slug":"<slug>","version":"1.0.0"}'`. Verify with `sulla marketplace/list_published '{}'`; success is `pending`, not live.

**Check:** Validation passes, the published local artifact works through its real runtime boundary, permissions are minimal, the bundle is clean, and any approved submission appears as `pending`.

**Don't:** publish a draft, test only by reading files, claim `pending` is live, or use marketplace submission as local installation.
