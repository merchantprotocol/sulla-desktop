# Sulla Desktop — Path Reference

## File Manager and agent paths

Use `/mnt/sulla-files` for the File Manager namespace. See
[files-first.md](files-first.md) for the approved layout and system areas.
Agent Git worktrees live at `/mnt/worktrees/<repo>-<branch-slug>`. Lima binds
`/mnt/data/worktrees` (persistent ext4 storage) at `/mnt/worktrees`.
These development checkouts are outside Files and are not indexed by it.

`~/sulla` is an application storage path, not a shared host-home mount.
`paths.sullaHome` is `<home>/sulla`; `paths.sullaConfig` is `<home>/.sulla`.
Agent definitions, including prompts, are served from `agent_definitions`;
folder exports are not the prompt authority.

## App resources path

`utils/paths.ts` resolves `paths.resources` to
`<process.resourcesPath>/resources`, falling back to `<cwd>/resources`.
For a packaged macOS app this is
`Sulla Desktop.app/Contents/Resources/resources/`.
The exact Linux installation prefix is installer-dependent, not `/usr/lib/sulla`
by contract. App resources are mounted read-only into Lima at the same path.
Agents should use `/mnt/sulla-files/Docs` for the Files-published docs.

## Electron application paths

| Purpose | macOS | Linux |
|---------|-------|-------|
| App home | `~/Library/Application Support/rancher-desktop` | `${XDG_DATA_HOME:-~/.local/share}/rancher-desktop` |
| Config | `~/Library/Preferences/rancher-desktop` | `${XDG_CONFIG_HOME:-~/.config}/rancher-desktop` |
| Logs | `~/Library/Logs/rancher-desktop` | `${XDG_DATA_HOME:-~/.local/share}/rancher-desktop/logs` |
| Lima | `~/.rd/lima` | `${XDG_DATA_HOME:-~/.local/share}/rancher-desktop/lima` |

The host home and external volumes are not mounted into Lima. Only app-owned
transport/cache roots cross that boundary (`backend/lima.ts:getMounts`).
Postgres data uses the Docker named volume `sulla_postgres_data`, not a
host `data/sulla-postgres` directory.

## Lima VM internal paths

| Path | Contents |
|------|----------|
| `/usr/local/bin/sulla` | Sulla CLI |
| `/mnt/sulla-files` | Files FUSE namespace |
| `/mnt/worktrees` | Persistent agent Git worktrees |
| `/mnt/data/sulla/runtime/functions/catalog` | Runtime function catalog |
| `/mnt/data/sulla/runtime/functions/invocations` | Runtime invocation snapshots |

CommandRunner keeps the guest-owned HOME and sets
`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` for VM execution.

## Function runtime ports

| Runtime | Desktop endpoint |
|---------|------------------|
| Python | `http://127.0.0.1:30118` |
| Shell | `http://127.0.0.1:30119` |
| Node.js | `http://127.0.0.1:30120` |

Each runtime listens on container port 8080. Bindings are defined in
`assets/sulla-docker-compose.yaml`; Lima forwards VM ports to the host.

## Database connections

| Service | Host | Port | DB | User |
|---------|------|------|----|------|
| PostgreSQL | 127.0.0.1 | 30116 | sulla | sulla |
| Redis | 127.0.0.1 | 30117 | — | — |

Redis runs with `--save "" --appendonly no`.

## Sources

- `pkg/rancher-desktop/utils/paths.ts`
- `pkg/rancher-desktop/backend/lima.ts`
- `pkg/rancher-desktop/assets/lima-config.yaml`
- `pkg/rancher-desktop/assets/sulla-docker-compose.yaml`
- `pkg/rancher-desktop/agent/tools/util/CommandRunner.ts`
