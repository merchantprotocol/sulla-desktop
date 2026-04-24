# Function Authoring & Lifecycle

Companion to `schema.md` (full YAML spec), `runtimes.md` (handler signatures), and `examples.md` (working code). This is the **how-to** for building, running, debugging, editing, and deleting custom functions.

## Where functions live

```
~/sulla/functions/<slug>/
  function.yaml                  # required — manifest
  main.py | main.js | main.sh    # handler code (per runtime)
  requirements.txt               # python deps (pip)
  package.json                   # node deps (npm) — required even if no deps
  packages.txt                   # shell deps (apk)
```

The slug must match the directory name, the `id` (as `function-<slug>`), and the `slug` field in `function.yaml`.

Functions are **not** registered anywhere — they're discovered by scanning `~/sulla/functions/` at list time.

## Tools

| Tool | Purpose |
|------|---------|
| `sulla function/function_list` | Enumerate functions in `~/sulla/functions/`. No params. |
| `sulla function/function_run` | Execute one. Params: `slug`, `inputs?`, `version?` |

Everything else (create, edit, delete, view source) is **file-based** — agent uses Read/Write/Edit on the function dir directly.

## Build a function

The canonical flow is **draft → validate → test-run → done**. Skipping validation is the top cause of functions that "look fine" and then break the first time someone triggers them.

1. **Gather:** what does the function take in, what does it return, what runtime is best (Python for data work, Node for HTTP/JS, Shell for system glue)?
2. **Pick a slug** (kebab-case, no spaces, e.g., `csv-to-json`)
3. **Create the dir:** `mkdir -p ~/sulla/functions/<slug>` — or let the scaffolder do it:
   ```bash
   sulla marketplace/scaffold '{"kind":"function","slug":"csv-to-json","name":"CSV to JSON","description":"…","runtime":"python"}'
   ```
   Scaffold produces a manifest + handler + deps file so you only fill in the body.
4. **Write `function.yaml`** with the required fields:
   ```yaml
   apiVersion: sulla/v1
   kind: Function
   id: function-<slug>
   slug: <slug>
   schemaversion: 1
   name: Display Name
   description: One-line summary
   spec:
     runtime: python              # python | node | shell
     entrypoint: main.py::handler # main.py::handler (py/node) or main.sh (shell)
     inputs:
       n:
         type: integer
         description: "How many to compute"
         default: 10
         required: false
     outputs:
       result:
         type: array
         description: "Computed values"
     timeout: 60s
     permissions:
       network: []                # [] = none, ["*"] = all, ["host.com"] = allowlist
   ```
5. **Write the handler** (signature per runtime — see `runtimes.md`):
   - Python: `def handler(inputs: dict) -> dict:`
   - Node: `export async function handler(inputs) { ... }` (ESM, `"type": "module"` in package.json)
   - Shell: read JSON from stdin, write JSON to stdout, exit 0 = success
6. **Add deps** (only if needed): `requirements.txt`, `package.json`, or `packages.txt` (apk format)
7. **Validate** (see next section) — non-negotiable before step 8
8. **Test-run:** `sulla function/function_run '{"slug":"<slug>"}'` (use defaults) or with explicit inputs. A clean validator pass doesn't prove the handler actually works — only a real invocation does.

## Validate

Every function the agent writes gets validated before the user is told it's ready. See `agent-patterns/validation.md` for the overall policy; this is the function-specific call.

```bash
sulla marketplace/validate '{"kind":"function","slug":"<slug>"}'
```

What it checks:
- `function.yaml` exists and parses
- `slug`, `id` (must be `function-<slug>`), and the directory name all agree
- `spec.runtime` is one of `python` | `node` | `shell`
- `spec.entrypoint` references a file that actually exists on disk
- `spec.inputs` and `spec.outputs` have valid shapes
- `spec.permissions.network` / `filesystem` / `env` follow the permission schema
- Runtime-specific deps file is consistent with `spec.runtime` (e.g. Python needs no `package.json`; Node needs `"type": "module"`)

Returns `{ errors: [], warnings: [] }`. **Errors mean the function won't load — fix and re-validate before telling the user it's done.** Warnings (e.g. missing `FUNCTION.md` doc) are safe to surface and defer.

Validation is structural only. After the validator is clean, run `function_run` with a minimal input to prove the handler actually works and returns the shape declared in `spec.outputs`. The validator can't catch a missing `return` statement or a key typo in the output dict — only an invocation can.

## Run

```bash
sulla function/function_run '{"slug":"csv-to-json"}'                          # defaults
sulla function/function_run '{"slug":"csv-to-json","inputs":{"path":"data.csv"}}'
```

Flow inside `function_run`:
1. Read `~/sulla/functions/<slug>/function.yaml`
2. Validate `inputs` against `spec.inputs` (types, required, enum, min/max)
3. If a deps file exists, POST to runtime `/install`
4. POST to runtime `/load`
5. POST to runtime `/invoke` with the inputs JSON
6. Return `{successBoolean, responseString}` — responseString contains a full execution trace and the parsed outputs

The runtime caches the loaded function by `slug + version` (default version `1.0.0`). Bump `version` in the call to force a reload after code changes.

## Debug a failed function

Errors come back in `responseString` with a category prefix:

| Category | Source |
|----------|--------|
| `function.yaml not found` | dir or manifest missing |
| `Failed to parse function.yaml` | YAML syntax error |
| `Unknown runtime ...` | runtime field is invalid |
| `Dependency installation failed: HTTP X: ...` | requirements.txt / package.json / packages.txt rejected by runtime |
| `Load failed: HTTP X: ...` | handler file missing, syntax error, import error |
| `Invocation failed: HTTP X: ...` | handler threw, returned wrong shape, or timed out |

**There's no persistent log file.** Container stdout/stderr is captured in the HTTP response from the runtime. If you need richer logs, write them as part of the handler's return value (e.g., include a `_debug` key) or write to a file the agent can read after.

**Debug flow:**
1. `function_list` — confirm function exists and parses
2. `function_run` with same inputs — read the full trace
3. Open the handler — common bugs: missing return, wrong shape vs `spec.outputs`, missing import
4. Check `entrypoint` matches the actual function name in the file
5. For dep failures: `cat ~/sulla/functions/<slug>/requirements.txt` and look for typos / version conflicts

## Test

No dedicated test tool. Strategy:
- Functions with no required inputs: `function_run '{"slug":"<slug>"}'` to use defaults
- Otherwise: pass minimal valid inputs
- For schema-only checks: read `spec.inputs`/`spec.outputs` from the YAML and reason about it

## Edit

No "edit function" tool — modify the files directly:
- Change handler code: edit `main.py` / `main.js` / `main.sh`
- Change schema: edit `function.yaml`
- Change deps: edit `requirements.txt` / `package.json` / `packages.txt`

The runtime caches by `slug + version`. After code changes, **bump `version`** (or pass an explicit `version` to `function_run`) to force a reload. If you don't, the runtime may reuse the stale cached handler.

## Delete

No tool. Remove the dir:
```bash
rm -rf ~/sulla/functions/<slug>
```
Confirm with the user first — function dirs sometimes have their own `.git` history.

## Permissions

```yaml
spec:
  permissions:
    network: []                          # [] no network | ["*"] all | ["api.example.com"] allowlist
    filesystem:
      - path: /home/user/data
        mode: read                       # read | write
    env: ["SLACK_TOKEN"]                 # env vars to expose to handler
  integrations:
    - slug: slack
      env:
        SLACK_TOKEN: bot_token            # maps env var → vault property
```

When `integrations` is set, the runtime injects vault secrets as env vars before invoking the handler. Handler accesses via `os.environ["SLACK_TOKEN"]` (Python) or `process.env.SLACK_TOKEN` (Node). The agent never sees the secret.

## Runtimes — health check

If `function_list` returns successfully, the runtimes are reachable. If a specific runtime hangs:
- Python: `http://127.0.0.1:30118`
- Shell: `http://127.0.0.1:30119`
- Node: `http://127.0.0.1:30120`

Check container status: `sulla docker/docker_ps '{}'` — look for `python_runtime`, `shell_runtime`, `node_runtime`. If missing, ServiceLifecycleManager owns them — tell the user, don't try to restart from the agent (see `environment/docker.md`).

## What the agent does NOT have

- No "create function from template" tool — author by hand
- No async / fire-and-forget invocation — `function_run` blocks until the handler returns
- No streaming output — single response when the function completes
- No persistent run history (each invocation is independent)

## Reference

- Tool manifests: `pkg/rancher-desktop/agent/tools/function/manifests.ts`
- Run impl: `pkg/rancher-desktop/agent/tools/function/function_run.ts`
- List impl: `pkg/rancher-desktop/agent/tools/function/function_list.ts`
- Runtime constants: `pkg/rancher-desktop/agent/tools/function/constants.ts`
- Path resolver: `resolveSullaFunctionsDir()` in `pkg/rancher-desktop/agent/utils/sullaPaths.ts`
- Schema: `functions/schema.md`
- Handler signatures: `functions/runtimes.md`
- Working examples: `functions/examples.md`
