# Desktop service contracts for Sulla Server

This document is the Phase 0 boundary for consumers of Sulla Desktop service images. It records the existing interfaces; it does not add a Server product mode or change runtime behavior. Server must consume the published packages and immutable image metadata, never files under `pkg/sulla-desktop`.

## Stable package contracts

| Package | Contract | Legacy Desktop path |
|---|---|---|
| `@sulla/workflow-engine` | Serialized workflow definition/state, pure playbook traversal and concurrency policy | `agent/workflow/{WorkflowPlaybook,types,workflowConcurrency}` and editor workflow types re-export it |
| `@sulla/runtime-protocol` | v1 capability claims, HS256 issue/verify/derive/revocation and scope matching | `runtime/capabilityToken` re-exports it |
| `@sulla/relay-protocol` | v1 relay request/result/stream envelopes and error vocabulary | `runtime/relayProtocol` re-exports it |

The old paths remain compatibility shims for Desktop callers. New service code must import package source or its published package, not an Electron-tree path.

## HTTP API surfaces

All `/internal/*` routes are service-to-service only. The gateway must not expose them. `/healthz` is unauthenticated readiness/liveness; all other authentication remains exactly as implemented by the service.

| Service | Public contract groups | Internal contract | Authentication boundary |
|---|---|---|---|
| Accounts | `/.well-known/sulla-server`, authority/OIDC, organizations, memberships, invitations, sessions and Desktop enrollment under `/v1` | bootstrap/admin/service-token operations | Desktop bootstrap token in desktop mode; Keycloak/OIDC sessions plus configured service/admin credentials in server mode |
| Vault | accounts/onboarding, collections, items, groups, org membership, audit, sync and broker routes under `/v1` | broker and bootstrap calls are privileged | local JWT/bootstrap identity in desktop mode; Accounts issuer/subject/org resolution in server mode |
| Files | collections, folders, files/chunks/versions, links/shares, trash and residency under `/v1` | FUSE, local roots/watch and cloud-sync routes are Desktop integration surfaces | local TLS/token/device identity in desktop mode; Accounts web/service identity in server mode |
| Agents | `/v1/agents`, `/v1/runs` and run message/stop operations | `/internal/workflow-runs{,/status}` | local token/identity in desktop mode; Accounts tenant identity and Workflows secret in server mode |
| Workflows | `/v1/workflows`, `/v1/runs`, schedules, resume/restart/stop | `/internal/agents/runs{,/status}` and `/internal/tools/:category/:tool` | local API token in desktop mode; Accounts tenant identity plus service credentials in server mode |
| Tools | catalog help and `/v1/tools/internal/:category/:tool/call` | the call route is internal despite its historical URL | capability token with `sulla-tools` audience; unsupported local capabilities fail closed or use a configured Desktop executor |
| Relay | authenticated device tunnel plus device tool forwarding | Redis presence/routing is not a public API | relay service/device tickets; request context uses `@sulla/relay-protocol` |

Route additions are backward compatible within protocol version 1. Removing or changing request/response semantics requires a protocol version and compatibility-range update.

## Desktop/server mode matrix

| Component | Selector | Desktop | Server |
|---|---|---|---|
| Accounts | `SULLA_ACCOUNTS_MODE` (default `desktop`) | local bootstrap/private authority; hosted web routes off | Keycloak authority/native/web clients, hosted users, org admin and enrollment |
| Vault | `SULLA_VAULT_MODE` (default `desktop`) | local JWT and owner bootstrap | durable JWT plus Accounts identity/org mapping |
| Files | `SULLA_FILES_MODE` (only exact `server`) | selected local roots, watcher and local token/TLS | stored-only service, Accounts auth, default collections, share relay and required master key |
| Agents | `SULLA_AGENT_SERVICE_MODE` (default `desktop`) | local definitions and Desktop identity | tenant-scoped definitions/runs, Accounts and Workflows credentials |
| Workflows | `SULLA_WORKFLOW_MODE` (default `desktop`); `SULLA_WORKFLOW_ROLE=manager|runner` | local token and Desktop launcher | tenant grants, allowed scopes and Server Agents launcher |
| Agent runner | `SULLA_AGENT_MODE=transport` is transport, not product mode | Desktop-managed ephemeral runner | same base runner with Server-scoped identity |
| Tools | no product-mode flag | local catalog and Desktop executor | same image/config; local server-safe tools, optional enrolled Desktop executor, otherwise fail closed |
| Relay | no product-mode flag | outbound tunnel client | Redis-backed relay terminates authenticated device tunnels |
| Console / installer | Server composition selects these | absent | Server-only; no global Desktop-to-Server switch |

Server composition must set every relevant selector explicitly. Existing defaults, URLs, IDs, schemas, ports, secrets and volumes are outside Phase 0 and remain unchanged.

## Compatibility artifacts

`contracts/server-split/compatibility.schema.json` defines the Server-consumed manifest. Every image reference is a registry repository plus an OCI `sha256:<64 lowercase hex>` digest; tags and mutable references are rejected. `base-image-metadata.schema.json` defines the per-image artifact emitted by Desktop image CI. The compatibility manifest records package versions, API protocols and schema ranges alongside those exact digests.
