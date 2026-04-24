# Docker & Lima

## The two Docker scopes

There are **two distinct Docker scopes** in play:

1. **Host Docker** — whatever Docker daemon the user has on their host machine (Docker Desktop is the common one). `sulla docker/*` tools talk to this. Installed extensions (Twenty CRM, etc.) run here.
2. **Lima-internal services** — sulla_postgres, sulla_redis, and the function runtimes run inside the Lima VM. They do NOT appear in `docker_ps`. They're exposed to the host via Lima port forwarding.

**Every `sulla docker/*` tool runs `docker` on the HOST.** That means:
- ✅ Sees: installed recipe extensions, anything the user is running in their host Docker
- ❌ Cannot see: `sulla_postgres`, `sulla_redis`, `python_runtime`, `shell_runtime`, `node_runtime` — those run inside Lima and don't appear in `docker_ps`

To verify Lima-internal services are up, query them directly (`sulla pg/pg_query`, `sulla redis/redis_get`, `sulla function/function_list`) rather than looking for them in `docker_ps`.

## How home dir mounting works

Lima boots Alpine Linux as a QEMU guest. The host macOS home directory is mounted into Lima at the **same absolute path** via virtiofs/9p. So `~/sulla/` on the Mac and `~/sulla/` inside Lima are the same files. No copying, no syncing.

This is how the agent (running in Lima) reads files the user wrote on their Mac.

## Pre-installed Lima services (NOT visible to docker_ps)

| Service | Port (host) | Purpose | Managed by |
|---------|-------------|---------|-----------|
| `sulla_postgres` | 30116 | Database (workflows, calendar, integration_values, history) | ServiceLifecycleManager |
| `sulla_redis` | 30117 | KV store (presence, queues, cache) | ServiceLifecycleManager |
| `python_runtime` | 30118 | Python custom function execution | ServiceLifecycleManager |
| `shell_runtime` | 30119 | Shell custom function execution | ServiceLifecycleManager |
| `node_runtime` | 30120 | Node.js custom function execution | ServiceLifecycleManager |

**Critical:** these are owned by ServiceLifecycleManager and are **not reachable via `sulla docker/*` tools**. To restart them, you must restart Sulla Desktop (heavy hammer). To verify they're up, query their port directly (`pg/pg_query`, `redis/redis_get`, `function/function_list`).

User-installed extensions (Twenty CRM, etc.) ARE managed by `sulla extensions/*`. They run in the host's Docker daemon and DO appear in `docker_ps`.

## Tools

### Docker

| Tool | Purpose |
|------|---------|
| `sulla docker/docker_ps` | List containers. `all:true` includes stopped. |
| `sulla docker/docker_images` | List images |
| `sulla docker/docker_pull` | Pull image from registry |
| `sulla docker/docker_run` | Start a container (typically detached) |
| `sulla docker/docker_exec` | Run a command in a running container |
| `sulla docker/docker_logs` | Tail/follow container logs |
| `sulla docker/docker_stop` | Stop a running container (graceful) |
| `sulla docker/docker_rm` | Remove a container (`force:true` to kill+remove) |
| `sulla docker/docker_build` | Build image from Dockerfile (path is inside Lima FS) |

All of these execute `docker <subcommand>` inside Lima via `runCommand('docker', args)`.

### Lima

| Tool | Purpose |
|------|---------|
| `sulla lima/lima_list` | List Lima instances (json:true for parsing) |
| `sulla lima/lima_create` | Create a new instance from a template YAML |
| `sulla lima/lima_start` | Start a stopped instance |
| `sulla lima/lima_stop` | Stop a running instance |
| `sulla lima/lima_shell` | Run a command in the Lima shell. **Without a command param, it tries interactive — useless from agent. Always pass `command`.** |
| `sulla lima/lima_delete` | Delete an instance |

Touching the primary Lima instance (the one Sulla runs in) breaks the world. Only act on Lima at the user's explicit request.

## Common requests

### "What containers are running?"
```bash
sulla docker/docker_ps '{}'             # running only
sulla docker/docker_ps '{"all":true}'   # include stopped
```

### "Show me logs from container X"
```bash
sulla docker/docker_logs '{"container":"sulla_postgres","tail":200}'
sulla docker/docker_logs '{"container":"twenty_db","follow":true}'
```

### "Why is Postgres down?"
1. `sulla pg/pg_query '{"sql":"SELECT 1"}'` — does it respond? If not, Postgres is down or Lima is asleep.
2. `docker_ps` will NOT show `sulla_postgres` (Lima-internal). Don't waste time looking.
3. **Don't restart via docker tools.** ServiceLifecycleManager owns it. The fix is restarting Sulla Desktop.

### "Restart Twenty CRM"
Twenty is an extension, not a service. Use the extensions API, not docker_stop:
```bash
# Better — via extension lifecycle:
sulla extensions/list_installed_extensions '{}'
# (no direct restart tool yet — uninstall+install is heavy. Often easier: docker_stop + docker_run on the specific container, but ONLY with user approval since it's their data.)
```

### "Run a one-off container"
```bash
sulla docker/docker_run '{"image":"alpine:3.19","command":"echo hello","options":"--rm"}'
```

### "Build me a container from this Dockerfile"
The path must exist **inside Lima's filesystem** (which is the same as host home, mounted at the same path):
```bash
sulla docker/docker_build '{"path":"/Users/jonathonbyrdziak/Sites/myapp","tag":"myapp:dev"}'
```

### "What's the IP/network setup?"
Lima exposes container ports to the host via port forwarding declared in the Lima config. The pre-installed containers map to host `localhost:30116`–`30120`. Extensions get ports declared in their `compose.yaml`.

## Hard rules

- **Sulla's core services (postgres/redis/runtimes) are NOT in docker_ps.** Don't try to `docker_stop` them — the tools can't see them anyway.
- **Confirm before destructive ops on host containers** (`docker_rm` with `force:true`, killing containers with mounted user data — Twenty CRM has the user's actual CRM data).
- **Always pass `command`** to `lima_shell` — interactive mode hangs the agent.
- **`rdctl_shell` doesn't accept pipes / redirects / `&&` in the command string.** Single command + args only.

## Reference

- Docker tool manifests: `pkg/rancher-desktop/agent/tools/docker/manifests.ts`
- Lima tool manifests: `pkg/rancher-desktop/agent/tools/lima/manifests.ts`
- ServiceLifecycleManager: `pkg/rancher-desktop/sulla.ts` (service registration)
- Memory: `~/.claude/projects/-Users-jonathonbyrdziak-Sites/memory/feedback_no_docker_kill.md`
