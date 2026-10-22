# Function Authoring & Lifecycle

Companion to `schema.md` (full YAML spec), `runtimes.md` (handler signatures), and `examples.md` (working code). This is the **how-to** for building, running, debugging, and editing custom functions.

## Where functions live

Functions are stored in Postgres (`function_definitions`). `function_list` and `function_run` read from there. Each function also has a folder that is its File Manager copy:

```
~/sulla/functions/<slug>/          # File Manager: Use Cases/functions/<slug>/
  function.yaml                    # required — manifest
  main.py | main.js | main.sh      # handler code (per runtime)
  requirements.txt                 # python deps (pip), if any
  package.json                     # node deps (npm), if any
  packages.txt                     # shell deps (apk), if any
```

The slug must match the `slug` field in `function.yaml`, the folder name, and the `id` (as `function-<slug>`). Files are the source of truth and the database is the runtime index. See [`environment/files-first.md`](../environment/files-first.md).

## Tools

| Command | Purpose |
|---------|---------|
| `sulla function/list '{}'` | List functions in Postgres: slug, name, runtime, entrypoint, inputs, outputs |
| `sulla function/run '{"slug":"..."}'` | Run one. Params: `slug` (required), `inputs` (optional object), `version` (optional, default `1.0.0`) |
| `sulla function/runs '{}'` | Query run history from `function_runs`. Params: `slug`, `only_failures`, `since`, `limit`, `verbose` |

Everything else (create, edit, view source) is **file-based.** Use the Read/Write tools on the function folder.

## Build a function

The canonical flow is **draft → validate → test-run → done**. Skipping validation is the top cause of functions that "look fine" and then break the first time someone triggers them.

1. **Gather:** what does the function take in, what does it return, what runtime is best (Python for data work, Node for HTTP/JS, Shell for system glue)?
2. **Pick a slug** (kebab-case, no spaces, e.g., `csv-to-json`)
3. **Scaffold** the starter files:
   ```bash
   sulla marketplace/scaffold '{"kind":"function","slug":"csv-to-json","name":"CSV to JSON","description":"…","runtime":"python"}'
   ```
   The scaffold writes `function.yaml`, a handler, and a deps file so you only fill in the body. For node it also writes `package.json` with `"type": "module"`.
4. **Write `function.yaml`:**
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
       network: []                # declared only; function_run does not enforce it
   ```
5. **Write the handler** (signature per runtime, see `runtimes.md`):
   - Python: `def handler(inputs: dict) -> dict:`
   - Node: `export async function handler(inputs) { ... }` (ESM, `"type": "module"` in package.json)
   - Shell: read JSON from stdin, write JSON to stdout, exit 0 = success
6. **Add deps** only if needed: `requirements.txt`, `package.json`, or `packages.txt`
7. **Validate** (next section). Don't skip this.
8. **Test-run:** `sulla function/run '{"slug":"<slug>"}'` (defaults) or with explicit `inputs`. Validation doesn't prove the handler works. Only an invocation does.

## Validate

```bash
sulla marketplace/validate '{"kind":"function","slug":"<slug>"}'
```

Errors mean the function won't load. Fix them and re-validate before telling the user it's ready. Warnings are safe to surface and defer. Validation is structural only.

After validation passes, run `function/run` with a minimal input. That's the only check that the handler returns the shape declared in `spec.outputs`. Validation can't catch a missing `return` or a key typo in the output dict.

## Run

```bash
sulla function/run '{"slug":"csv-to-json"}'                                  # defaults
sulla function/run '{"slug":"csv-to-json","inputs":{"path":"data.csv"}}'
```

What `function/run` does is listed in [`runtimes.md`](runtimes.md#how-invocation-works). Inputs are passed through as given. `function/run` does not check them against `spec.inputs`.

It returns `successBoolean` and `responseString`. The string holds the full trace (runtime, load status, inputs, and outputs). Outputs are also returned as a parsed object.

`function/run` passes `version` to the runtime. The default is `1.0.0`. Pass a new `version` after code changes so the runtime doesn't reuse an old load.

## Debug a failed function

Errors come back in `responseString`, prefixed by the stage that failed:

| Message prefix | Meaning |
|----------------|---------|
| `Function "<slug>" was not found in Postgres` | Slug is wrong, or the files haven't been indexed. Run `function/list`. |
| `Database lookup failed` | Postgres query failed |
| `Unknown runtime "..."` | `spec.runtime` is not `python`, `node`, or `shell` |
| `Dependency installation failed` | The runtime rejected the deps file |
| `Load failed` | Handler file missing, syntax error, or import error |
| `Vault lookup failed` | An integration value couldn't be read |
| `Invocation failed` | The handler threw, returned bad output, or the call failed |

**Run history:** every `function/run` writes a row to `function_runs`:
```bash
sulla function/runs '{"slug":"csv-to-json","only_failures":true,"verbose":true}'
```

**Debug flow:**
1. `function/list`: confirm the function exists
2. `function/run` with the same inputs, and read the full trace
3. `function/runs` with `verbose: true` for the saved inputs and outputs
4. Open the handler. Common bugs: missing return, output shape doesn't match `spec.outputs`, missing import
5. Check that `entrypoint` names a function that exists in the file
6. For dependency failures, read the deps file in the function folder and look for typos or version conflicts

If you need detail beyond the trace, return it from the handler, for example under a `_debug` key.

## Test

No dedicated test tool. Strategy:
- Functions with no required inputs: `function/run '{"slug":"<slug>"}'` uses defaults
- Otherwise, pass minimal valid inputs

## Edit

Edit the files in the function folder, then bump `version` in the next `function/run` call so the runtime reloads:
- Handler code: `main.py` / `main.js` / `main.sh`
- Schema: `function.yaml`
- Deps: `requirements.txt` / `package.json` / `packages.txt`

Without a version bump, the runtime may reuse the old cached handler.

## Delete

No delete tool exists. Ask the user before removing a function folder. Workflows that reference the slug will fail until it's back.

## Permissions and secrets

```yaml
spec:
  permissions:                           # declared; not enforced by function/run
    network: []
  integrations:
    - slug: slack
      env:
        SLACK_TOKEN: bot_token           # env var -> vault property
```

When `integrations` is set, `function/run` injects the vault values as env vars before invoking the handler. It does this only if that integration's `llm_access` setting allows secrets in agent code. If not, it skips the injection and logs a warning. Handler code reads them with `os.environ["SLACK_TOKEN"]` (Python) or `process.env.SLACK_TOKEN` (Node).

## Runtimes — health check

`function/list` doesn't touch the runtimes. To check them:
- Python: `http://127.0.0.1:30118/health`
- Shell: `http://127.0.0.1:30119/health`
- Node: `http://127.0.0.1:30120/health`

If a runtime is down, tell the user. Don't try to restart the containers from the agent. `ServiceLifecycleManager` owns them. See `environment/docker.md`.

## What the agent does NOT have

- No "create function from template" tool. Scaffold the files, then write the body by hand.
- No async or fire-and-forget invocation. `function/run` blocks until the handler returns.
- No streaming output. You get one response when the function completes.

## Reference

- Tool manifests: `pkg/rancher-desktop/agent/tools/function/manifests.ts`
- Run impl: `pkg/rancher-desktop/agent/tools/function/function_run.ts`
- List impl: `pkg/rancher-desktop/agent/tools/function/function_list.ts`
- Runtime URLs: `pkg/rancher-desktop/agent/tools/function/constants.ts`
- Schema: [`schema.md`](schema.md)
- Handler signatures: [`runtimes.md`](runtimes.md)
- Working examples: [`examples.md`](examples.md)
