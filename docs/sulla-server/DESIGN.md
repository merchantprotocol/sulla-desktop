# Sulla Server: what we decided (2026-10-15)

## 1. The big picture

```mermaid
flowchart LR
  subgraph Desktops["Sulla Desktops (unchanged; features appear when joined)"]
    D1["Desktop: Jonathon"]
    D2["Desktop: teammate"]
  end

  subgraph Server["Sulla Server (self-hosted, or Sulla Cloud = one we host)"]
    ADMIN["Admin area<br/>(user + desktop list, admins only)"]
    API["Tool catalog = the API<br/>vault + keys live ONLY here"]
    CTRL["Controller<br/>(launches / kills pods)"]
    RELAY["Relay<br/>(streams pod output to Desktop)"]
    WF["Workflows<br/>(only always-on thing, no heartbeat)"]
    DB[("Postgres<br/>synced from Desktops")]
    subgraph Pods["Agent pods (one per chat tab)"]
      P1["Pod: CLI + git + sulla<br/>checkout inside, dies 30 min idle"]
      P2["Pod: subagent"]
    end
    subgraph Recipes["Recipes (Docker apps)"]
      CRM["CRM"]
      CALL["Call center"]
    end
  end

  NET["Org network"]

  D1 -- "join password from admin" --> ADMIN
  D1 -- "launch / talk to MY pods" --> CTRL
  D1 -- "data sync up" --> DB
  CTRL --> P1
  P1 -- "subagent request (counts against owner)" --> CTRL
  CTRL --> P2
  P1 -- "sulla CLI" --> API
  P1 -- "output" --> RELAY --> D1
  NET --> CRM
  NET --> CALL
  D1 -- "push / pull workflow or recipe" --> WF
```

## 2. Joining a server

```mermaid
sequenceDiagram
  participant U as User's Desktop
  participant A as Network admin
  participant S as Sulla Server
  U->>S: Finds the server
  A->>U: Gives join password
  U->>S: Join with password
  S-->>U: Now part of the org (shows in admin user list)
  Note over U: Server features appear in Desktop.<br/>Without a server, Desktop works exactly as today.
```

## 3. Vault (our own, Bitwarden-style)

```mermaid
flowchart TB
  V["Your vault (locked on your device)"]
  V --> PS["Personal secrets<br/>logins, notes, cards<br/>server can NOT read · agents can NOT use"]
  V --> AC["Agent credentials<br/>you flip 'agents can use'<br/>tool catalog injects them · pods never see them"]
  ORG["Org vault: shared folders<br/>view / use-by-agents / edit / manage"] --> AC
```

- An agent pod acts as the person who launched it, never with more access than they have.
- Every time an agent uses a credential, it's logged.

## 4. Decided in one list
- Product line: Sulla Server first → Sulla Enterprise later, built on top.
- No billing anywhere on the server.
- Recipes run on the server and the org network can reach them; org-wide ones are an admin decision.
- Workflows and recipes move Desktop ⇄ server.
- Git checkout lives inside the pod; only pushed work survives.
- No heartbeat on the server; scheduled work = workflows.
- Each user can run their own Claude/Codex subscription on the server; orgs can add shared API keys.
- Memory is personal by default, shared on purpose.
- Per-user browser profiles and GitHub connections on the server.
- Pods get internet by default; internal network access is an admin setting.
- Upgrades back up first; nightly backups.
- Workbench is being removed from Desktop.
