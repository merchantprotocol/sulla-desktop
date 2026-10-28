# Sulla Extension Contract v1

Extension Contract v1 is the stable boundary between Sulla core and installed add-ons. Existing add-ons without this envelope remain loadable; every newly scaffolded or published add-on must declare `sullaApi: ^1.0.0`.

## Manifest envelope

Every kind uses its existing primary document and adds the same fields. Skills put them in `SKILL.md` YAML frontmatter; functions use `function.yaml`; workflows use `routine.yaml` (or `workflow.yaml` in Files); recipes use `manifest.yaml` or `installation.yaml`; agents use their exported manifest; integrations use their package manifest.

```yaml
sullaApi: ^1.0.0
hooks:
  - name: before_tool_call
    priority: 10
ui:
  - slot: sidebar_entry
    id: my-extension
    label: My extension
    component: my-extension/sidebar
```

`hooks` is the complete permission request, not an implicit grant. At install or update, Sulla shows the requested hooks. Runtime registration succeeds only for hooks the user granted. An update requesting another hook requires another grant. Priority is a non-negative integer; lower values run first and the default is 10. Add-ons must not depend on registration order for equal priorities.

The generic envelope applies to `skill`, `function`, `workflow`, `recipe`, `integration`, and `agent`; kind-specific fields and files remain unchanged. A missing `sullaApi` is accepted only by the legacy compatibility path and produces validation guidance. Unknown API major versions, hooks, or UI slots fail validation.

## API and compatibility

`1.x` is the first public extension API. Add-ons should use a compatible semver range such as `^1.0.0`. A major version may remove or change behavior. Minor versions only add optional fields, hooks, tools, or response fields. Patch versions fix behavior without intentionally changing the contract.

The CLI is the programmatic tool API: `sulla <category>/<tool> '<json>'`. Its schemas and returned envelope are part of the declared `sullaApi` major. Tool names, required inputs, permission behavior, and documented result fields do not break within a major. New optional inputs and result fields may be added. Add-ons must ignore unknown result fields.

Sulla announces a deprecated contract, tool, field, hook, or behavior in release notes and docs for at least 12 months before removal or an incompatible change. During that window it continues working and emits an actionable warning with its replacement. Security fixes may immediately disable behavior that exposes secrets or bypasses user permission; the release notes must identify the exception and migration.

## Runtime behavior

Actions observe an event and cannot change the core value. Filters receive an immutable, secret-redacted snapshot and may return a replacement value or `{ denied: true, reason }`. Function add-ons answer through their outputs: return `{ "value": ... }` to replace the value, `{ "denied": true, "reason": "..." }` to block, or anything else (for example `{}`) to pass through unchanged. See `examples/use-cases/outbound-send-guard/`. Each callback has a bounded timeout. A throw, rejection, or timeout is audited and isolated; core continues with the last valid value. A permission denial skips the callback and is audited. Hook payloads recursively redact vault and credential-shaped fields before entering extension code. Hooks do not bypass tool, Files, integration, network, or vault permissions.

## Hook reference

| Hook | Type | Payload and purpose |
|---|---|---|
| `before_tool_call` | filter | `{ toolName, args, toolRunId }`; may replace `args` or deny |
| `after_tool_call` | action | tool identity, redacted args, success, result or error |
| `before_model_call` | filter | messages, system prompt and model; may transform or deny |
| `after_model_response` | action | normalized model response and model identity |
| `on_user_message` | action | newly accepted user message and thread id |
| `on_memory_write` | action | proposed/committed memory metadata, never vault values |
| `on_workflow_node_start` | action | execution, workflow and node metadata |
| `on_workflow_node_finish` | action | node outcome and bounded result metadata |
| `on_agent_job_start` | action | job and agent metadata |
| `on_agent_job_finish` | action | job outcome and bounded result metadata |

Core owns the singleton registry. Subsystems dispatch through `runAction` and `runFilter`; extensions register handlers only after manifest validation and grant resolution.

## UI contributions

UI is declarative. The renderer reads contributions from the UI registry; extensions do not patch renderer routes or components. Contract v1 slots are `sidebar_entry`, `settings_tab`, and `chat_card`. Each entry requires `id`, `label`, and a packaged `component` reference; `icon` and numeric `order` are optional. UI contributions inherit extension permissions and cannot receive vault secrets.

## Auditing

Each callback produces an audit event with extension id, hook, outcome (`ok`, `denied`, `error`, `timeout`, or `permission_denied`), and duration. Payloads and secret values are not logged. Audit failure itself never changes the core path.

## Renderer contributions

The main process exposes registered contributions through `ipcRenderer.invoke('extensions-ui:list', slot?)`. The registry supports `sidebar_entry`, `settings_tab`, and `chat_card`. Renderer wiring into the left rail is next; consumers must treat this API as read-only and render only known slots.
