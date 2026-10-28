---
slug: sulla-repo-services
kind: system
name: Sulla bundled services
parent: sulla-repository
aliases: [service containers, bundled services, services directory]
---

## Overview
The `services/` tree contains containerized backend services used by Desktop and Sulla Server. Each service has its own Dockerfile and may have an entrypoint, compose snippet, README, or package manifest. Read the service's own files before changing deployment behavior.

## Facts
- `sulla-accounts` handles account identity and Keycloak configuration.
- `sulla-agent` and `sulla-agents` provide agent execution containers and supervision.
- `sulla-console` provides the server console.
- `sulla-files` stores and serves Files data; `sulla-files-fuse` exposes the Files FUSE mount.
- `sulla-postgres` packages the Postgres database service.
- `sulla-relay` provides the Cloudflare-compatible WebSocket relay.
- `sulla-threat-proxy` provides URL threat filtering.
- `sulla-tools` provides the tool-side runtime.
- `sulla-vault` owns encrypted credential operations and the vault broker.
- `sulla-workflows` runs workflow-related service operations.
