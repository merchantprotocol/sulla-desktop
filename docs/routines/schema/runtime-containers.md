# Runtime Containers

How Sulla functions actually execute. This doc spells out what each runtime container is for, how they load and invoke functions, and why this design beats both the "in-process" (n8n) and "container-per-invocation" (Airbyte) models.

> **Terminology.** Runtime containers execute **functions**, not routines. Routines are DAGs orchestrated by the in-process workflow playbook (the DAG walker). When a routine hits a function node, the walker HTTP-POSTs the appropriate runtime's `/invoke` endpoint. See [../../functions/schema/README.md](../../functions/schema/README.md) for the function model and [./workflow-integration.md](./workflow-integration.md) for how routines and functions fit together.

---

## 1. Why containers at all?

A function is code written by an agent or a human. That code has to run somewhere. The options were:

1. **In-process (n8n model):** load the code into the main Sulla process.
   - ❌ Locks us into one language (JavaScript).
   - ❌ A bad function (memory leak, infinite loop) takes down the whole engine.
   - ❌ Sandboxing untrusted code in-process is hard (vm2 has CVEs; isolated-vm has limits).
2. **Container-per-invocation (Airbyte model):** spawn a fresh container for every function call.
   - ✅ Perfect isolation.
   - ❌ 100ms–2s cold start per invocation, terrible for anything running >10x/minute.
   - ❌ High RAM overhead (each container is a full process tree).
3. **Runtime containers (Sulla model):** one long-lived container per language, hot-loads functions into isolated namespaces.
   - ✅ Polyglot (Python, shell, Node).
   - ✅ Invocation is function-call-fast once the function is loaded.
   - ✅ Function code is sandboxed *by the container itself* — it can only see what the container lets it see.
   - ✅ Hot-reload during development: save the file → runtime picks it up → next invocation runs the new code.

The runtime-container model is how **Jupyter kernels**, **AWS Lambda warm pools**, and **Cloudflare Workers isolates** work. Proven pattern, just extended to user-written functions.

---

## 2. The fleet

Sulla Desktop ships three runtime containers. Each is launched on the user's local Docker daemon (OrbStack / Docker Desktop / Rancher Desktop — it's just containers). Each binds **only to 127.0.0.1** — there is no remote exposure.

| Runtime          | Port (localhost) | Bind-mount                            | What it executes                      |
|------------------|------------------|---------------------------------------|---------------------------------------|
| `python-runtime` | `30118`          | `~/sulla/functions/` → `/var/functions` (ro) | Python functions (`main.py`)         |
| `shell-runtime`  | `30119`          | `~/sulla/functions/` → `/var/functions` (ro) | Shell functions (`main.sh`)          |
| `node-runtime`   | `30120`          | `~/sulla/functions/` → `/var/functions` (ro) | Node/TypeScript functions (`main.js`/`main.ts`) |

```
┌───────────────────────────────────────────────────────────────────┐
│                       Sulla Desktop (Electron)                    │
│                                                                   │
│   WorkflowPlaybook (DAG walker) ──► hits a function node          │
│                                             │                     │
│                                             ▼                     │
│                     POST http://127.0.0.1:<port>/invoke           │
└───────────────────────────────────────────────────────────────────┘
          │                      │                     │
    ┌─────▼─────┐          ┌─────▼─────┐         ┌─────▼─────┐
    │  python-  │          │  shell-   │         │   node-   │
    │  runtime  │          │  runtime  │         │  runtime  │
    │   :30118  │          │   :30119  │         │   :30120  │
    └───────────┘          └───────────┘         └───────────┘
```

The runtime container's runtime is declared in the function's own `function.yaml` (`spec.runtime: python|shell|node`). The routine node doesn't pick it — the walker reads the function manifest and routes accordingly.

### 2.1 `python-runtime` — port 30118

**What it's for:** most functions. Data transforms, API clients (Stripe, Twenty, GitHub), scraping, ML inference, file parsing, math-heavy work.

**What's inside:**
- Base image: `python:3.12-slim` (Debian-slim, not Alpine — Alpine breaks many PyPI wheels).
- Supervisor: a FastAPI server bound to `0.0.0.0:30118` inside the container (published to `127.0.0.1:30118` on the host).
- Pre-installed: `uv` (fast dep resolver), `pydantic`, `httpx`, `pyyaml`, `jinja2`, plus the Sulla function SDK.
- Per-function deps: each function ships a `requirements.txt` (or `pyproject.toml`). The supervisor installs them into a per-function venv on first load and caches by content hash.

**Isolation:** each function loads into its own `importlib` namespace with a dedicated `sys.path` pointing at its venv. Memory limits applied via Python's `resource` module.

### 2.2 `shell-runtime` — port 30119

**What it's for:** thin wrappers around existing CLI tools. `ffmpeg` invocations, `git` operations, `kubectl` commands, anything where "the right tool" is already on the command line.

**What's inside:**
- Base image: `alpine:3.20` with a curated set of tools: `bash`, `curl`, `jq`, `git`, `ffmpeg`, `imagemagick`, `openssl`.
- Supervisor: a small Go binary listening on `:30119` that accepts HTTP requests and forks a subprocess per invocation.
- Per-function deps: functions can declare extra packages in `apk.txt`. Supervisor installs on first load, cached.

**Isolation:** each invocation is a subprocess with its own process group. The shell-runtime is effectively container-per-invocation *within* the long-lived container — cheap enough because forking bash is microseconds, not seconds.

### 2.3 `node-runtime` — port 30120

**What it's for:** functions that want the JS/TS ecosystem — web parsing (cheerio, playwright), n8n-compatible node code, anything with a better npm package than Python alternative.

**What's inside:**
- Base image: `node:20-slim`.
- Supervisor: a Fastify server on `:30120`.
- Pre-installed: `tsx` (for TypeScript), `zod`, the Sulla function SDK.
- Per-function deps: each function ships a `package.json`. Installed into per-function `node_modules` on first load, cached by lockfile hash.

**Isolation:** `vm.createContext` per function gives a fresh global namespace. Worker threads used for CPU-heavy work to keep the supervisor responsive.

---

## 3. Anatomy of a runtime container

Every runtime container shares the same internal shape:

```
python-runtime (container)
├── /opt/sulla/
│   ├── supervisor               # The long-running server
│   ├── runtime-sdk/             # Helper libs exposed to functions
│   └── cache/                   # Per-function deps, hash-keyed
├── /var/functions/              # Bind-mounted from host ~/sulla/functions/ (read-only)
│   ├── fetch-stripe-invoice/
│   ├── dedupe-emails/
│   └── ...
└── (HTTP) 127.0.0.1:30118       # Supervisor bound here, host-accessible via localhost only
```

### 3.1 The supervisor process

Every runtime has exactly one supervisor. It is:

- **Stateless between restarts** — all state (loaded functions, caches) is reconstructible from the bind-mounted `functions/` dir and the on-disk dep cache.
- **Self-healing** — if a function invocation segfaults the supervisor, Docker restart policy brings it back in <2s. Loaded functions re-load lazily on first invocation after restart.
- **Always listening on its port** — IPC is HTTP on localhost. Cheap, language-agnostic, easy to debug with `curl`.

### 3.2 HTTP protocol

The workflow playbook talks to supervisors via a small HTTP API:

| Method | Path                      | Request body                                | Response                       |
|--------|---------------------------|---------------------------------------------|--------------------------------|
| POST   | `/invoke`                 | `{ functionRef, inputs, env, timeout }`     | `{ outputs, logs, metrics }`   |
| POST   | `/load`                   | `{ functionRef }`                           | `{ loaded: bool, error? }`     |
| POST   | `/unload`                 | `{ functionRef }`                           | `{ unloaded: bool }`           |
| GET    | `/health`                 |                                             | `{ functions[], memory, uptime }` |

`functionRef` is the function slug (directory name under `~/sulla/functions/`). Runtimes resolve the manifest at `/var/functions/<slug>/function.yaml` to locate the entrypoint.

### 3.3 Per-function namespace isolation

Inside a runtime container, multiple functions coexist without seeing each other:

| Runtime  | Isolation primitive                          | Leaks you have to think about              |
|----------|----------------------------------------------|--------------------------------------------|
| python   | `importlib` module namespace + separate venv | Module-level globals; monkey-patched libs  |
| shell    | Subprocess per invocation                    | Env vars (cleared between invocations)     |
| node     | `vm.createContext` per function + node_modules | Prototype pollution; require.cache         |

Functions never import each other. Cross-function composition happens in routines (the DAG), not inside a runtime. This is a hard rule — it keeps each function a clean leaf.

---

## 4. Hot reload

The whole point of long-lived runtimes is **iteration speed**.

1. Agent or human edits `~/sulla/functions/dedupe-emails/main.py`.
2. A file watcher in the supervisor fires on the write.
3. Supervisor reloads the function namespace — next invocation runs the new code.
4. Reload is namespace-scoped. Other functions in the same runtime are untouched.

Reload time: typically 50–200ms for Python (importlib.reload), 10–50ms for Node (vm recompile). Effectively instant compared to container rebuild (30s+).

Functions are **always mutable** — they have no "published/immutable" state. Git history is their versioning. If a function needs to be hardened against change, protect it at the git-repo level.

---

## 5. Dependency management

Each function declares its own deps. The runtime handles install + caching.

### Python

```
~/sulla/functions/fetch-stripe-invoice/
├── function.yaml
├── main.py
└── requirements.txt
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

**Why content-addressable caching matters:** two different functions that depend on the same packages share a single venv/node_modules on disk. Storage stays bounded even with hundreds of functions.

---

## 6. Permission enforcement

`function.yaml` declares `spec.permissions`. The runtime container enforces them. Permissions that are not declared are denied by default.

### 6.1 Network

```yaml
spec:
  permissions:
    network:
      - api.stripe.com
      - "*.googleapis.com"
```

Enforcement: the runtime container routes all egress through a filtering proxy (envoy or a small Go proxy). Requests to hosts not on the allowlist are rejected with a clear error. The function sees a network-level failure, not a successful call.

Empty or missing `network` = no outbound network access at all.

### 6.2 Environment & secrets

```yaml
spec:
  permissions:
    env:
      - STRIPE_KEY
    secrets:
      - stripe/api_key
```

Enforcement: the routine's function node binds each declared env var to a specific vault account (`FunctionNodeConfig.vaultAccounts`). The walker resolves the secret, sends it in the `/invoke` request body's `env` field, and the supervisor injects it into the function's namespace for that one invocation. When the invocation ends, the env is cleared.

### 6.3 Filesystem

```yaml
spec:
  permissions:
    filesystem:
      - { path: "/data/reports", mode: write }
```

Enforcement: the runtime container bind-mounts declared paths from the host into the function's namespace. Undeclared paths are invisible. The function's own directory (`/var/functions/<slug>/`) is always available read-only.

### 6.4 No shell-out, no raw syscalls

Python/Node functions cannot `os.system`, `subprocess.run`, or equivalent. The Sulla function SDK provides a sanctioned `run_command` helper that routes shell invocations through the `shell-runtime` with its own permission declarations. Bypassing this fails the permission check at load time (static analysis of the function's imports).

---

## 7. Lifecycle

### 7.1 Startup

When Sulla Desktop launches:

1. It checks which runtime containers should be running (based on which functions are referenced by enabled routines and which runtimes they need).
2. Missing containers are started via the Docker SDK. Running containers are pinged for health at `/health`.
3. Runtime containers are **lazy** — they don't pre-load all functions. First invocation of a function triggers its `/load`.

### 7.2 Idle shutdown

Runtime containers idle-shutdown after N minutes of no activity (default 30m, configurable). Next invocation wakes them. Cold start for the container itself is ~2s (one-time); subsequent function invocations are the fast hot-load path.

### 7.3 Crash recovery

If a function crashes the supervisor:

1. Docker's restart policy brings the container back (<2s).
2. The in-flight invocation is marked failed; the workflow playbook handles it like any node failure.
3. Loaded-function state is lost but reconstructs lazily on next invocation.

If a function is a **repeat offender** (crashes 3x in 5 minutes), the playbook can auto-disable the function node (`enabled: false` on the node config, not on disk) and alert the user. This prevents a crash-looping function from flooding the container with restart events.

---

## 8. Comparison to alternatives

| Aspect              | n8n (in-process)       | Airbyte (per-invocation) | Sulla (runtime containers)          |
|---------------------|------------------------|--------------------------|-------------------------------------|
| Languages           | JavaScript only        | Any (per connector)      | Python, shell, Node                 |
| Cold start          | ~0ms                   | 100ms–2s                 | ~0ms once loaded; 100ms first load  |
| Isolation           | Weak (shared process)  | Strong (full container)  | Strong (namespace + sandbox)        |
| Hot reload          | Yes (dev only)         | No (rebuild image)       | Yes, always                         |
| Resource overhead   | Low                    | High                     | Low-medium                          |
| Dep conflicts       | Global npm tree        | Per-connector            | Per-function venv/node_modules      |

The Sulla model picks up the wins from both ends without inheriting their worst tradeoffs.

---

## 9. Build order

Ship them in this order. Each works standalone:

1. **`python-runtime`** — highest-value, covers ~70% of functions we'll write first. Proves the whole model.
2. **`shell-runtime`** — simplest (no language embedding), unlocks CLI-wrapping functions immediately.
3. **`node-runtime`** — needed for anything requiring the npm ecosystem.

Each runtime container lives in the standalone [`sulla-runtimes`](../../../../sulla-runtimes/) repository. CI builds publish dual-arch images to `ghcr.io/merchantprotocol/sulla-<name>`. The HTTP contract (`/health`, `/load`, `/invoke`, `/unload`, `/routines`) is stable.

```
sulla-runtimes/python-runtime/
├── Dockerfile
├── supervisor/                   # FastAPI app
│   ├── main.py
│   ├── loader.py                # importlib-based function loading
│   ├── invoker.py               # handler invocation + output validation
│   ├── permissions.py           # network proxy config, env injection, fs bind
│   └── http.py                  # HTTP server on :30118
├── sdk/                         # Helpers exposed to functions
│   ├── __init__.py
│   ├── logger.py
│   ├── secrets.py
│   └── shell.py                 # Sanctioned shell-out via shell-runtime
└── tests/
```

---

## 10. Open questions

- **Runtime versions:** if a function needs Python 3.13 and another needs 3.11, do we run two Python runtime containers or support multiple venvs inside one? Proposed: one container per minor version, selected by `spec.compatibility`.
- **GPU-bound functions:** should there be a `cuda-runtime` for ML inference? Not v1, but the architecture allows it (port 30121+).
- **Credential injection timing:** inject secrets into the function's env *per invocation* (safer, slower) or *per load* (faster, riskier if the runtime is compromised)? Leaning per-invocation with the runtime holding a vault token, not the secrets themselves.
- **Agent-style prompt functions:** an earlier design had a fourth `agent-runtime` where the entrypoint was an LLM prompt file. That is currently handled by the `agent` node subtype in a routine (it talks to the LLM gateway directly), not by a runtime container. Revisit if we want prompts-as-functions.
