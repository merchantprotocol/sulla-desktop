# Sulla Desktop — Path Reference

## ~/sulla/ Directory Tree

Created by `bootstrapSullaHome()` at every app startup.

```
~/sulla/
├── resources/                  # Cloned from merchantprotocol/sulla-resources (GitHub)
│   ├── skills/                 # Default skill instructions (SKILL.md)
│   ├── agents/                 # Default agent configs
│   ├── workflows/
│   │   ├── draft/
│   │   ├── production/
│   │   └── archive/
│   ├── integrations/           # Default integration docs
│   └── docs/                   # Documentation (if present)
│
├── skills/                     # User-defined skills
├── agents/                     # User-defined agent configs
├── workflows/
│   ├── draft/                  # Work-in-progress workflows
│   ├── production/             # Active, auto-triggered workflows
│   └── archive/                # Disabled workflows
├── integrations/               # User integration configs & auth
├── functions/                  # User-defined custom functions
│   └── <slug>/
│       ├── function.yaml
│       └── main.py|js|sh
├── recipes/                    # Marketplace extension configs
├── routines/                   # Routine template repos (each is a git repo)
├── projects/                   # Project workspaces and PRDs
├── logs/                       # Execution logs
├── training/                   # Training data
├── conversations/              # Saved conversation history
├── identity/                   # Persistent identity & goals
│   ├── human/                  # identity.md, goals.md
│   ├── business/               # identity.md, goals.md, marketing.md
│   ├── world/                  # identity.md, goals.md
│   └── agent/                  # identity.md, goals.md
└── content/                    # Generated content (social posts, blog drafts, etc.)
```

---

## App Resources Path

| Context | Path |
|---------|------|
| Development | `/Users/<user>/Sites/sulla/sulla-desktop/resources/` |
| Packaged macOS | `Sulla Desktop.app/Contents/Resources/resources/` |
| Packaged Linux | `/usr/lib/sulla/resources/` |
| Inside Lima | Same absolute path as host (virtiofs mount) |

**`resources/sulla-docs/`** — This directory. Shipped with the app, mounted into Lima automatically. Agents search here for system documentation.

---

## Electron App Data Path

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/rancher-desktop/` |
| Linux | `~/.config/rancher-desktop/` |

Subdirectories:
- `lima/` — Lima VM disk image and config
- `data/sulla-postgres/` — PostgreSQL persistent data volume
- `logs/` — App logs

---

## Lima VM Internal Paths

| Path | Contents |
|------|---------|
| `/usr/local/bin/sulla` | The `sulla` CLI tool |
| `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` | Full PATH for exec commands |
| `~/sulla/` | Same files as Mac (shared mount) |
| `~/Library/...` | Same as Mac app data (shared mount) |

---

## Function Runtime Ports

| Runtime | Port |
|---------|------|
| Python | `http://127.0.0.1:30118` |
| Shell | `http://127.0.0.1:30119` |
| Node.js | `http://127.0.0.1:30120` |

---

## Database Connections

| Service | Host | Port | DB | User |
|---------|------|------|----|------|
| PostgreSQL | 127.0.0.1 | 30116 | sulla | sulla |
| Redis | 127.0.0.1 | 30117 | — | — |

Redis has no persistence (`--save "" --appendonly no`).
