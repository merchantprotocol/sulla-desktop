# Docker & Sulla VM

## Execution scopes

Docker tools call `runCommand('docker', args)`. With no agent-container runtime,
CommandRunner spawns the local binary in the Desktop process environment.
With an active agent-container runtime, it executes the command in that
container via Sulla VM `docker exec`. The tools do not universally select either
host Docker or the Sulla VM service daemon. Check the execution context before
interpreting container listings; an absent container is not proof it is stopped.

The core services are composed by `backend/sullaRuntimeBackend.ts` inside Sulla VM. To query that
daemon explicitly, use `meta/exec` with a VM `docker` command. Do not restart or
remove core services merely because a different Docker context cannot see them.

## Host files and VM storage

The host home is not mounted into Sulla VM. `getMounts()` in `backend/sullaRuntimeBackend.ts`
exposes app-owned cache/log/resource and transport directories only. Managed
files are available through `/mnt/sulla-files`. Worktrees use `/mnt/worktrees`
on the persistent data disk. A Docker build context must exist in the tool's
actual execution environment; a host path is not automatically a VM path.

## Base Sulla VM containers

`assets/sulla-docker-compose.yaml` defines:

| Container | Image | Published port |
|-----------|-------|----------------|
| `sulla_postgres` | `postgres:16-alpine` | 30116 → 5432 |
| `sulla_redis` | `redis:7-alpine` | 30117 → 6379 |
| `sulla_python_runtime` | `ghcr.io/merchantprotocol/sulla-python-runtime:latest` | 30118 → 8080 |
| `sulla_shell_runtime` | `ghcr.io/merchantprotocol/sulla-shell-runtime:latest` | 30119 → 8080 |
| `sulla_node_runtime` | `ghcr.io/merchantprotocol/sulla-node-runtime:latest` | 30120 → 8080 |

Runtime bindings use VM loopback. Functions mount
`/mnt/data/sulla/runtime/functions/catalog` at `/var/functions:ro` and
`/mnt/data/sulla/runtime/functions/invocations` at `/var/db-functions:ro`.
Postgres uses `sulla_postgres_data`. Redis persistence is disabled.

`backend/sullaRuntimeBackend.ts` augments the compose definition with `sulla_accounts`,
`sulla_vault`, `sulla_workflow_manager`, `sulla_relay`,
`sulla_tools`, `sulla_files` and `sulla_files_fuse`. Managed service images are
resolved by the backend's image-selection code, with environment overrides and
source-build support; do not assume every installed service uses `latest`.
Files and workflow containers share the Files mount, not host home directories.

ServiceLifecycleManager in `sulla.ts` handles application service startup and
connection readiness. The Sulla VM backend owns Docker compose reconciliation.

## Tools

Read `agent/tools/docker/manifests.ts` or use `meta/browse_tools` for exact
parameters. The category includes `docker_ps`, `docker_images`, `docker_pull`,
`docker_run`, `docker_exec`, `docker_logs`, `docker_stop`, `docker_rm`, and
`docker_build`.

```bash
sulla docker/docker_ps '{"all":true}'
sulla docker/docker_logs '{"container":"container-name","tail":200}'
```

There are no VM-management tools; use `meta/exec` to run commands in the VM.

## Diagnostics

Use `pg/pg_query` with `SELECT 1` for Postgres connectivity. A function catalog
listing is not a runtime health probe. Runtime health endpoints are `/health`
on their published HTTP ports. For container logs, select the correct daemon
first. Never use uninstall/reinstall as a routine extension restart: it can
remove user data.

## Sources

- `pkg/rancher-desktop/agent/tools/docker/`
- `pkg/rancher-desktop/agent/tools/lima/`
- `pkg/rancher-desktop/agent/tools/util/CommandRunner.ts`
- `pkg/rancher-desktop/assets/sulla-docker-compose.yaml`
- `pkg/rancher-desktop/backend/sullaRuntimeBackend.ts`
- `pkg/rancher-desktop/sulla.ts`
