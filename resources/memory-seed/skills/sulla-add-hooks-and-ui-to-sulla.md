---
slug: sulla-add-hooks-and-ui-to-sulla
label: Add Extension Contract hooks, filters, and UI to Sulla
trigger_when: When an installed function should observe or filter agent activity, deny a tool or model call, react to workflow or job events, or add a declarative sidebar, settings, or chat contribution.
trigger_actions: [add hook, build filter, deny tool call, add extension UI, contribute settings tab]
trigger_phrases: [before_tool_call, extension hook, hook filter, sidebar entry, settings tab, chat card, UI contribution]
scope: [sulla-extensions, sulla-plugins]
---

**When:** Extension Contract v1 hooks and UI are loaded from installed function manifests. Use a function because it owns the executable handler. A skill, workflow, or recipe may only declare a hook by referencing an installed function with `function: <slug>`.

**Do:**
1. Scaffold a function and add `sullaApi: ^1.0.0`. Declare only supported hooks: `before_tool_call`, `after_tool_call`, `before_model_call`, `after_model_response`, `on_user_message`, `on_memory_write`, `on_workflow_node_start`, `on_workflow_node_finish`, `on_agent_job_start`, and `on_agent_job_finish`.
2. Use this complete manifest fragment:

```yaml
apiVersion: sulla/v1
sullaApi: ^1.0.0
kind: Function
id: function-call-guard
slug: call-guard
name: Call guard
description: Applies a narrow policy before tool calls.
schemaversion: 1
hooks:
  - {name: before_tool_call, priority: 5, timeoutMs: 500}
ui:
  - {slot: settings_tab, id: call-guard-settings, label: Call guard, component: call-guard-settings, order: 20}
spec:
  runtime: python
  entrypoint: main.py::handler
  inputs: {hook: {type: string}, payload: {type: object}}
  outputs: {result: {type: object}}
  timeout: 2s
  permissions: {network: []}
```

3. `before_tool_call` and `before_model_call` are filters. Return `{"result":{"value":<replacement>}}` to replace the non-secret payload, `{"result":{"denied":true,"reason":"..."}}` to deny, or an empty object to pass through. The other hooks are actions; observe the payload and return no replacement.
4. Lower numeric priority runs earlier; the default is 10. Keep `timeoutMs` small. The runtime default is 1,000 ms, clamps to at least 1 ms, and continues core execution after a hook error or timeout.
5. Every hook is deny-by-default until the human grants that exact extension-and-hook pair. Grants persist separately. Never design a hook that silently assumes permission.
6. Treat hook input as a read-only snapshot. Keys matching `secret`, `token`, `password`, `credential`, `api_key`/`api-key`, `private_key`/`private-key`, `authorization`, or `cookie` are replaced with `[REDACTED]`. Circular values become `[Circular]`.
7. A filter cannot replace protected values. If it returns `[REDACTED]`, injects a protected key, or changes one, the runtime restores the core value. Never infer, log, persist, or echo protected fields.
8. UI slots are exactly `sidebar_entry`, `settings_tab`, and `chat_card`. Each contribution needs `slot`, `id`, `label`, and `component`; `icon` and `order` are optional. Contributions are declarative registry entries. Do not patch core renderer routes.
9. Validate with `sulla marketplace/validate '{"kind":"function","slug":"call-guard"}'`. Publish the Files drafts and wait for Decide approval. Grant only the hook under test.
10. Test filters with safe synthetic payloads: allowed value, replacement, explicit denial, handler error, timeout, and protected-key injection. Test actions for observation without mutation. Confirm audit outcomes show `ok`, `denied`, `error`, `timeout`, or `permission_denied` without secret data.
11. Open the app and verify each declared contribution appears in its exact slot, has the expected ordering, and disappears when the function is disabled or removed. Check that core navigation still works.
12. Prepare marketplace submission and use the approval step in `sulla-build-a-plugin`; hooks and UI permissions must be visible in the submission review.

**Check:** Validation passes, ungranted hooks do nothing, granted hooks run in priority order, secrets stay protected, failures do not break core execution, and UI appears only in declared slots.

**Don't:** use hooks to bypass approvals, broaden tool permissions, extract secrets, mutate action payloads, register unknown hook or slot names, or add renderer routes for plugin UI.
