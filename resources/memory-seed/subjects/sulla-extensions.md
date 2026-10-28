---
slug: sulla-extensions
kind: system
name: Sulla Extensions
parent: sulla
aliases: [extensions, Extension Contract, hooks, filters, integrations]
---

## Overview
Extension Contract v1 is the stable boundary for installed add-ons. Every kind may declare `sullaApi: ^1.0.0`, requested hooks, and declarative UI contributions. Hooks run with bounded timeouts, secret-redacted payloads, and existing Sulla permissions. Integration packages additionally declare signed manifests, endpoint paths, auth metadata, and integrity.

## Facts
- Supported hook names are `before_tool_call`, `after_tool_call`, `before_model_call`, `after_model_response`, `on_user_message`, `on_memory_write`, `on_workflow_node_start`, `on_workflow_node_finish`, `on_agent_job_start`, and `on_agent_job_finish`.
- `before_tool_call` and `before_model_call` are filters; they may replace a value or return `{ denied: true, reason }`.
- Hook errors, rejections, and timeouts are audited and isolated; core continues with the last valid value.
- UI slots are `sidebar_entry`, `settings_tab`, and `chat_card`; contributions require `id`, `label`, and `component`.
- Integration manifests use `apiVersion: sulla/v1`, `kind: integration`, `id`, `version`, `sullaApi`, `permissions`, `entry`, `integrity`, `signature`, and declared `proxyPaths`.
- Integration code receives only `runtime.proxy({ method, path, body })`; vault credentials are brokered and never passed to package code.

## Rules
- DO: Request only the hooks, permissions, URLs, paths, and scopes needed. Why: grants are explicit and expanded access requires a new grant.
- DO: Treat hook payloads as immutable, secret-redacted snapshots. Why: extensions cannot bypass vault, Files, tool, network, or integration permissions.
- DON'T: import vault credentials or read environment secrets in an integration entry. Why: the loader intentionally provides only the proxy API.
- DON'T: change core renderer routes to add UI. Why: UI contributions are declarative and rendered by the registry.
