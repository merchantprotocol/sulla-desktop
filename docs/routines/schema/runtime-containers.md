# Runtime Containers

How Sulla routines actually execute. This document spells out what each Docker container is for, how they load and invoke routines, and why this design beats both the "in-process" (n8n) and "container-per-invocation" (Airbyte) models.

---

## 1. Why containers at all?

A routine is code written by an agent or a human. That code has to run somewhere. The options were:

1. **In-process (n8n model):** load the code into the main Sulla process.
   - ❌ Locks us into one language (JavaScript).
   - ❌ A bad routine (memory leak, infinite loop) takes down the whole engine.
   - ❌ Sandboxing untrusted code in-process is hard (vm2 has CVEs; isolated-vm has limits).
2. **Container-per-invocation (Airbyte model):** spawn a fresh container for every routine call.
   - ✅ Perfect isolation.
   - ❌ 100ms–2s cold start per invocation, terrible for anything running >10x/minute.
   - ❌ High RAM overhead (each container is a full process tree).
3. **Runtime containers (Sulla model):** one long-lived container per language, hot-loads routines into isolated namespaces.
   - ✅ Polyglot (Python, Node, shell, agent).
   - ✅ Invocation is function-call-fast once the routine is loaded.
   - ✅ Routine code is sandboxed *by the container itself* — it can only see what the container lets it see.
   - ✅ Hot-reload during development: save the file → runtime picks it up → next invocation runs the new code.

The runtime-container model is how **Jupyter kernels**, **AWS Lambda warm pools**, and **Cloudflare Workers isolates** work. Proven pattern, just extended to routines.

---

## 2. The fleet

Sulla Desktop ships four runtime containers. Each is launched by Sulla Desktop on the user's local Docker daemon (OrbStack / Docker Desktop / Rancher Desktop — it's just containers).

```
┌───────────────────────────────────────────────────────────────────┐
│                       Sulla Desktop (Electron)                    │
│                                                                   │
│   WorkflowPlaybook    ──────────────►    RoutineRegistry          │
│         │                                      │                  │
│         │       Resolves routineRef,           │                  │
│         │       routes to runtime via IPC      │                  │
│         ▼                                      ▼                  │
│   ┌────────────────────────────────────────────────────────────┐  │
│   │              Unix socket / gRPC bus                        │  │
│   └────────────────────────────────────────────────────────────┘  │
│         │               │               │               │         │
└─────────┼───────────────┼───────────────┼───────────────┼─────────┘
          │               │               │               │
    ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼──────┐
    │  python-  │   │   node-   │   │  shell-   │   │   agent-   │
    │  runtime  │   │  runtime  │   │  runtime  │   │  runtime   │
    └───────────┘   └───────────┘   └───────────┘   └────────────┘
```

### 2.1 `python-runtime`

**What it's for:** most routines. Data transforms, API clients (Stripe, Twenty, GitHub), scraping, ML inference, file parsing, math-heavy work.

**What's inside:**
- Base image: `python:3.12-slim` (Debian-slim, not Alpine — Alpine breaks many PyPI wheels).
- Supervisor: a FastAPI server listening on a Unix socket inside the container.
- Pre-installed: `uv` (fast dep resolver), `pydantic`, `httpx`, `pyyaml`, `jinja2`, plus the Sulla runtime SDK.
- Per-routine deps: each routine ships a `functions/requirements.txt` (or pyproject.toml). The supervisor installs them into a per-routine venv on first load and caches by content hash.

**Isolation:** each routine loads into its own `importlib` namespace with a dedicated `sys.path` pointing at its venv. Memory limits applied via Python's `resource` module.

### 2.2 `node-runtime`

**What it's for:** routines that want the JS/TS ecosystem — web parsing (cheerio, playwright), n8n-compatible node code, anything with a better npm package than Python alternative.

**What's inside:**
- Base image: `node:20-slim`.
- Supervisor: a tiny Fastify server on a Unix socket.
- Pre-installed: `tsx` (for TypeScript), `zod`, the Sulla runtime SDK.
- Per-routine deps: each routine ships a `functions/package.json`. Installed into per-routine `node_modules` on first load, cached by lockfile hash.

**Isolation:** `vm.createContext` per routine gives a fresh global namespace. Worker threads used for CPU-heavy work to keep the supervisor responsive.

### 2.3 `shell-runtime`

**What it's for:** thin wrappers around existing CLI tools. `ffmpeg` invocations, `git` operations, `kubectl` commands, anything where "the right tool" is already on the command line.

**What's inside:**
- Base image: `alpine:3.20` with a curated set of tools: `bash`, `curl`, `jq`, `git`, `ffmpeg`, `imagemagick`, `openssl`.
- Supervisor: a small Go binary that accepts IPC requests and forks a subprocess per invocation.
- Per-routine deps: routines can declare extra packages in `functions/apk.txt`. Supervisor installs on first load, cached.

**Isolation:** each invocation is a subprocess with its own process group. The shell-runtime is effectively container-per-invocation *within* the long-lived container — cheap enough because forking bash is microseconds, not seconds.

### 2.4 `agent-runtime`

**What it's for:** routines whose "code" is an LLM prompt. Custom agents. Natural-language data extraction. Summarization with a specific style. Decision nodes that need reasoning.

**What's inside:**
- Base image: `node:20-slim`.
- Supervisor: Fastify server that bridges to the Sulla LLM gateway.
- The routine's entrypoint is a prompt file (`functions/prompt.md`) with a system prompt, tool list, and I/O contract.
- Supervisor handles: injecting inputs as the user message, streaming the LLM response, parsing structured outputs against the `spec.outputs` schema.

**Why separate from `node-runtime`:** different concurrency profile (LLM calls are IO-bound with long waits), different cost model (token-metered), different retry semantics (model errors vs code errors).

---

## 3. Anatomy of a runtime container

Every runtime container shares the same internal shape:

```
python-runtime (container)
├── /opt/sulla/
│   ├── supervisor               # The long-running server
│   ├── runtime-sdk/             # Helper libs exposed to routines
│   └── cache/                   # Per-routine deps, signature-keyed
├── /var/routines/               # Bind-mounted from host ~/sulla/routines/
│   ├── fetch-stripe-invoice/
│   ├── generate-invoice-pdf/
│   └── ...
└── /run/sulla.sock              # Unix socket for IPC with Sulla Desktop
```

### 3.1 The supervisor process

Every runtime has exactly one supervisor. It is:

- **Stateless between restarts** — all state (loaded routines, caches) is reconstructible from the bind-mounted `routines/` dir and the on-disk dep cache.
- **Self-healing** — if a routine invocation segfaults the supervisor, systemd-style restart brings it back in <2s. Loaded routines re-load lazily on first invocation after restart.
- **Always listening on the Unix socket** — IPC is local and fast. No TCP, no auth overhead.

### 3.2 IPC protocol

The workflow engine talks to supervisors via a small RPC API (gRPC over Unix socket):

| RPC                   | Request                              | Response                     |
|-----------------------|--------------------------------------|------------------------------|
| `Load(routineRef)`    | `{ name, version, path }`            | `{ loaded: bool, error? }`   |
| `Invoke(routineRef,`  | `{ name, version, inputs, timeout }` | `{ outputs, logs, metrics }` |
| ` inputs)`            |                                      |                              |
| `Unload(routineRef)`  | `{ name, version }`                  | `{ unloaded: bool }`         |
| `Health()`            | `{}`                                 | `{ routines[], memory, uptime }` |
| `Watch(routineRef)`   | stream                               | stream of reload events      |

### 3.3 Per-routine namespace isolation

Inside a runtime container, multiple routines coexist without seeing each other:

| Runtime  | Isolation primitive                          | Leaks you have to think about              |
|----------|----------------------------------------------|--------------------------------------------|
| python   | `importlib` module namespace + separate venv | Module-level globals; monkey-patched libs  |
| node     | `vm.createContext` per routine + node_modules | Prototype pollution; require.cache         |
| shell    | Subprocess per invocation                    | Env vars (cleared between invocations)     |
| agent    | Separate conversation state per invocation   | Shared LLM gateway quotas                  |

Routines never import each other. Cross-routine composition happens in workflows, not inside the runtime. This is a hard rule — it keeps each routine a clean leaf in the graph.

---

## 4. Hot reload

The whole point of long-lived runtimes is **iteration speed**.

1. Agent edits `fetch-stripe-invoice/functions/main.py`.
2. A file watcher in the supervisor fires on the write.
3. Supervisor checks the routine's `_status`:
   - `draft` → reload immediately. Next invocation runs the new code.
   - `production` (published) → **refuse the reload.** Published routines are immutable; the file watcher logs a warning and alerts Sulla Desktop.
4. Reload is namespace-scoped. Other routines in the same runtime are untouched.

Reload time: typically 50–200ms for Python (importlib.reload), 10–50ms for Node (vm recompile). Effectively instant compared to container rebuild (30s+).

---

## 5. Execution tiers

Two tiers, selected by the routine's `trust` field:

### 5.1 Shared runtime (`trust: user` or `trust: verified`)

- Routine loads into the long-lived runtime container's namespace.
- Fast invocation, warm runtime, low RAM overhead.
- Appropriate for: user's own routines, reviewed team routines, Sulla-maintained defaults.

### 5.2 Isolated-per-invocation (`trust: marketplace`)

- Engine spawns a fresh `python-runtime` / `node-runtime` container *just for this invocation*, with only this one routine loaded.
- Container is destroyed after the invocation returns.
- Slower (100ms–2s cold start), higher RAM, but bulletproof isolation.
- Appropriate for: routines fetched from the public marketplace, untrusted code, anything whose author is not the operator.

Same routine format, same IPC protocol — the engine just picks a different execution path. No change to the routine author.

---

## 6. Dependency management

Each routine declares its own deps. The runtime handles install + caching.

### Python

```
fetch-stripe-invoice/
└── functions/
    ├── main.py
    └── requirements.txt       # Or pyproject.toml
```

Supervisor on first load:

1. Hashes `requirements.txt` (content-addressable).
2. Checks `/opt/sulla/cache/venvs/<hash>/` — if exists, activate it.
3. If not, runs `uv pip install -r requirements.txt --target=/opt/sulla/cache/venvs/<hash>/`, then activates.
4. Subsequent loads with the same deps: cache hit, <100ms.

### Node

Same pattern with `package.json` + `package-lock.json` → `/opt/sulla/cache/node_modules/<lockfile-hash>/`.

### Shell

`apk.txt` lists extra alpine packages. Installed on first load, cached in a layered overlay.

### Agent

No deps — prompt files are self-contained. The LLM gateway client is provided by the runtime.

**Why content-addressable caching matters:** two different routines that happen to depend on the same packages share a single venv/node_modules on disk. Storage stays bounded even with hundreds of routines.

---

## 7. Permission enforcement

`routine.yaml` declares `spec.permissions`. The runtime container enforces them. Permissions that are not declared are denied by default.

### 7.1 Network

```yaml
spec:
  permissions:
    network:
      - api.stripe.com
      - "*.googleapis.com"
```

Enforcement: the runtime container routes all egress through a filtering proxy (envoy or a small Go proxy). Requests to hosts not on the allowlist are rejected with a clear error. The routine sees a network-level failure, not a successful call.

Empty or missing `network` = no outbound network access at all.

### 7.2 Environment & secrets

```yaml
spec:
  permissions:
    env:
      - STRIPE_KEY
    secrets:
      - stripe/api_key
```

Enforcement: the runtime injects only the declared env vars into the routine's namespace. Secrets are resolved from the Sulla vault at invocation time and passed as env vars, never persisted to disk inside the runtime. When the invocation ends, the env is cleared (or the namespace discarded).

### 7.3 Filesystem

```yaml
spec:
  permissions:
    filesystem:
      - { path: "/data/reports", mode: write }
```

Enforcement: the runtime container bind-mounts declared paths from the host into the routine's namespace. Undeclared paths are invisible. The routine's own directory (`/var/routines/<name>/`) is always available read-only.

### 7.4 No shell-out, no raw syscalls

Routines cannot `os.system`, `subprocess.run`, or equivalent. The Sulla runtime SDK provides a sanctioned `run_command` helper that routes shell invocations through the `shell-runtime` with its own permission declarations. Bypassing this fails the permission check at load time (static analysis of the routine's imports).

---

## 8. Lifecycle

### 8.1 Startup

When Sulla Desktop launches:

1. It checks which runtime containers should be running (based on which routines are `enabled` and which runtimes they use).
2. Missing containers are started via the Docker SDK. Running containers are pinged for health.
3. Runtime containers are **lazy** — they don't pre-load all routines. First invocation of a routine triggers its `Load` RPC.

### 8.2 Warm pools

For very hot routines (high invocation frequency), the engine can pre-warm them on startup by issuing `Load` ahead of time. Controlled by `spec.warm: true` in `routine.yaml` (future addition; not v1).

### 8.3 Idle shutdown

Runtime containers idle-shutdown after N minutes of no activity (default 30m, configurable). Next invocation wakes them. Cold start for the container itself is ~2s (one-time); subsequent routine invocations are the fast hot-load path.

### 8.4 Crash recovery

If a routine crashes the supervisor:

1. Docker's restart policy brings the container back (<2s).
2. The in-flight invocation is marked failed; the workflow engine handles it like any node failure.
3. Loaded-routine state is lost but reconstructs lazily on next invocation.

If a routine is a **repeat offender** (crashes 3x in 5 minutes), the engine auto-disables it (`enabled: false` flag set in-memory, not on disk) and alerts the user. This prevents a crash-looping routine from flooding the container with restart events.

---

## 9. Comparison to alternatives

| Aspect              | n8n (in-process)       | Airbyte (per-invocation) | Sulla (runtime containers)          |
|---------------------|------------------------|--------------------------|-------------------------------------|
| Languages           | JavaScript only        | Any (per connector)      | Python, Node, shell, agent          |
| Cold start          | ~0ms                   | 100ms–2s                 | ~0ms once loaded; 100ms first load  |
| Isolation           | Weak (shared process)  | Strong (full container)  | Strong (namespace + sandbox)        |
| Hot reload          | Yes (dev only)         | No (rebuild image)       | Yes, always                         |
| Untrusted code      | Unsafe                 | Safe                     | Safe (marketplace tier)             |
| Resource overhead   | Low                    | High                     | Low-medium                          |
| Dep conflicts       | Global npm tree        | Per-connector            | Per-routine venv/node_modules       |

The Sulla model picks up the wins from both ends without inheriting their worst tradeoffs.

---

## 10. Build order

Ship them in this order. Each works standalone:

1. **`python-runtime`** — highest-value, covers ~70% of routines we'll write first. Proves the whole model.
2. **`shell-runtime`** — simplest (no language embedding), unlocks CLI-wrapping routines immediately.
3. **`node-runtime`** — needed for anything requiring the npm ecosystem.
4. **`agent-runtime`** — depends on the LLM gateway being stable; comes last.

Each runtime container is its own repo or subdirectory under `sulla-desktop/runtimes/<name>/`. Each has:

```
runtimes/python-runtime/
├── Dockerfile
├── supervisor/                   # FastAPI app
│   ├── main.py
│   ├── loader.py                # importlib-based routine loading
│   ├── invoker.py               # handler invocation + output validation
│   ├── permissions.py           # network proxy config, env injection, fs bind
│   └── ipc.py                   # Unix socket server
├── sdk/                         # Helpers exposed to routines
│   ├── __init__.py
│   ├── logger.py
│   ├── secrets.py
│   └── shell.py                 # Sanctioned shell-out via shell-runtime
└── tests/
```

---

## 11. Open questions

- **OCI registry vs git:** should published routines be distributed as OCI images (signed, cached, CDN'd) or git tags (diff-friendly, auditable source)? Leaning OCI for distribution + git for source-of-truth.
- **Runtime versions:** if a routine needs Python 3.13 and another needs 3.11, do we run two Python runtime containers or support multiple venvs inside one? Proposed: one container per minor version, selected by `spec.compatibility`.
- **GPU-bound routines:** should there be a `cuda-runtime` for ML inference? Not v1, but the architecture allows it.
- **Credential injection timing:** inject secrets into the routine's env *per invocation* (safer, slower) or *per load* (faster, riskier if the runtime is compromised)? Leaning per-invocation with the runtime holding a vault token, not the secrets themselves.
