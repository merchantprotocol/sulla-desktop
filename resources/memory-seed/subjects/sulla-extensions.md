---
slug: sulla-extensions
kind: system
name: Sulla Extensions
parent: sulla
aliases: [extensions, Extension Contract, hooks, filters, integrations, recipes]
---

## Overview
Sulla Extensions are the runtime-facing plugin paths. Database-backed functions implement Extension Contract v1 hooks and declarative UI contributions; recipe extensions are container stacks managed by the extension service. Hooks run with exact user grants, secret-redacted payloads, bounded timeouts, and audit events. Signed integration packages are a separate executable package boundary with a brokered proxy API and exact permissions. For kind selection and the full build path, use `sulla-plugins` and `sulla-build-a-plugin`.

## Facts
- Supported hook names are `before_tool_call`, `after_tool_call`, `before_model_call`, `after_model_response`, `on_user_message`, `on_memory_write`, `on_workflow_node_start`, `on_workflow_node_finish`, `on_agent_job_start`, and `on_agent_job_finish`.
- `before_tool_call` and `before_model_call` are filters; a filter may return a replacement value or `{ denied: true, reason }`; other hooks are actions.
- Hook payloads redact keys matching secret, token, password, credential, API key, private key, authorization, or cookie; protected values cannot be replaced by a hook.
- Hook execution defaults to a 1,000 ms timeout, audits success, denial, errors, timeouts, and permission denial, and keeps core execution running after failures.
- UI slots are `sidebar_entry`, `settings_tab`, and `chat_card`; each contribution needs `id`, `label`, and `component`.
- Extension hook declarations are loaded from installed function manifests; hook grants are persisted per extension and hook and default to denied.
- Recipe extensions expose install, start, stop, status, and uninstall operations; stopping requires explicit confirmation and preserves data on disk by default.
- Signed integration package manifests use `apiVersion: sulla/v1`, `kind: integration`, `id`, semver `version`, `sullaApi`, `permissions`, `entry`, `integrity`, Ed25519 `signature`, `auth`, `baseUrls`, and optional `proxyPaths`.
- Signed integration entry code receives only `runtime.proxy({ method, path, body })`; the loader checks the path against declared proxy paths and never passes vault credentials to package code.

## Rules
- DO: Request only the hooks, permissions, URLs, paths, and scopes needed. Why: grants are exact and changes require a new grant.
- DO: Treat hook payloads as immutable, secret-redacted snapshots. Why: extensions cannot use hooks to extract or replace protected values.
- DO: Use a recipe for a containerized service; use an installed function for a bounded hook or UI contribution. Why: they have different runtimes and lifecycle tools.
- DON'T: import vault credentials or read environment secrets in an integration entry. Why: the loader intentionally exposes only the proxy API.
- DON'T: change core renderer routes to add UI. Why: UI contributions are declarative and rendered by the registry.
- DON'T: start, stop, or uninstall an extension without checking its status and impact. Why: stopping breaks dependent flows and uninstall may affect the service.
