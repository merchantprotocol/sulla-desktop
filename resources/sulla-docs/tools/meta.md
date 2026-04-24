# Meta — Foundational Tools

The tools the agent uses constantly: shell exec, file ops, tool discovery, search, observational memory. Master these — they're the bedrock everything else sits on.

## Tool inventory

### `meta/exec` — Run shell commands inside Lima
```bash
sulla meta/exec '{
  "command": "git status",
  "cwd":     "/Users/jonathonbyrdziak/Sites/sulla",
  "timeout": 120000,
  "stdin":   "optional input piped to stdin"
}'
```

| Field | Default | Notes |
|-------|---------|-------|
| `command` (or `cmd`) | required | Shell command. Runs in Lima VM, not host. |
| `cwd` | `/root` | Working dir inside Lima |
| `timeout` | 120000 (2 min) | ms; bump for long installs (e.g., 600000 for 10 min) |
| `stdin` | none | Piped to the command |

**Output cap:** 160KB stdout+stderr combined. Exit 0 = success; non-zero = failure (stderr in `responseString`).

**Important caveats:**
- Runs in Lima, **not on the host macOS**. `~` is mounted at the same path so file paths work, but env vars from your shell don't carry over. Use `export X=Y && cmd` if you need them.
- Long-running commands keep running even on timeout — child processes aren't killed.
- This is the dispatcher for **every** other CLI tool: `sulla browser/tab '...'` actually runs as `exec({ command: "sulla browser/tab '...'" })`.

### `meta/browse_tools` — Discover tools
```bash
sulla meta/browse_tools '{"category":"github"}'
sulla meta/browse_tools '{"query":"send message"}'
sulla meta/browse_tools '{}'                          # everything
```

Returns ready-to-run command examples with parameter schemas + credential status. **Always check this before assuming a tool exists** — there are 130+ tools and naming changes happen.

⚠️ The returned strings must be wrapped in `exec()`. They are not directly callable. The output is documentation, not execution.

### `meta/file_search` — Semantic search over files
```bash
sulla meta/file_search '{"query":"workflow scheduler","dirPath":"/Users/.../sulla","limit":20}'
sulla meta/file_search '{"query":"how do I run a function"}'           # primary dir = home, sulla-docs auto-included
sulla meta/file_search '{"query":"...","includeSullaDocs":false}'      # search only dirPath
```

Vector-indexed semantic search across both filenames and contents. Faster and broader than `grep` for conceptual queries ("error handling for HTTP timeouts"). For exact strings use grep instead.

**Always also searches the bundled `sulla-docs/` reference** (the docs you're reading right now) unless you pass `includeSullaDocs: false`. Results are grouped per directory so you can see which hits came from where. This means most "where do I do X?" queries get authoritative tool docs returned for free without remembering paths.

First search in a dir triggers indexing — subsequent searches are fast.

### `meta/read_file` — Read with line ranges
```bash
sulla meta/read_file '{"path":"~/sulla/identity/human/identity.md"}'
sulla meta/read_file '{"path":"...","startLine":50,"endLine":150}'
```

- 1-indexed lines
- Returns line-numbered output + total line count
- Directories return a listing
- Path validation: blocks traversal outside the user's home directory
- No size limit — large files load fully into memory

### `observation/write_file` — Write to home directory
```bash
sulla observation/write_file '{"path":"~/sulla/notes/scratch.md","content":"..."}'
```
**Canonical category is `observation`** (per `sulla observation --help`), even though it's not a memory tool. Both `sulla observation/write_file` and `sulla meta/write_file` resolve at the backend (the URL category is ignored — tools are looked up by name only). Use `observation/` for clarity.

- Creates parent directories as needed
- Overwrites existing files
- **Restricted to the user's home directory** for safety
- No size limit

For edits to existing files, prefer the editor's `Edit` tool (smaller diffs) over rewriting via `write_file`.

## Observational memory tools

These live under category `observation` (not `meta`), but they're used the same way.

### `observation/add_observational_memory`
```bash
sulla observation/add_observational_memory '{
  "priority": "high",
  "content":  "Sulla Desktop rebuild requires user intervention — never attempt rebuild from inside the agent."
}'
```

| Field | Notes |
|-------|-------|
| `priority` | "high", "medium", "low" — or use the user's symbols 🔴 🟡 🟢. Default 🟡. |
| `content` | One sentence, dense. Verbose entries get truncated by dedup. |

Stored as JSON in `sulla_settings`. **Cap: 50 most recent memories — older ones are pruned.** Returns a 4-char ID (e.g., `a3K2`) you'll see in the system prompt's memory list.

Dedup is substring-based: re-adding the same fact updates priority/timestamp instead of creating a duplicate.

### `observation/remove_observational_memory`
```bash
sulla observation/remove_observational_memory '{"id":"a3K2"}'
```

The id comes from the system prompt's memory list (each entry shows `[id:XXXX]`).

## Patterns

### Run a one-off shell command
```bash
sulla meta/exec '{"command":"ls ~/sulla/workflows/"}'
```

### Find a file by concept
```bash
sulla meta/file_search '{"query":"workflow scheduler cron","dirPath":"/Users/jonathonbyrdziak/Sites/sulla/sulla-desktop"}'
```

### Read a specific section of a long file
```bash
sulla meta/read_file '{"path":"...","startLine":200,"endLine":350}'
```

### Discover tools for a domain
```bash
sulla meta/browse_tools '{"query":"calendar"}'
```
Read the schema, then call via `exec`.

### Save a non-obvious fact for future runs
```bash
sulla observation/add_observational_memory '{"priority":"high","content":"Twenty CRM container is fragile on restart — prefer extension reinstall over docker_stop"}'
```

## Hard rules

- **Never call CLI tools without wrapping in `exec`.** Browse_tools output is documentation, not execution.
- **`exec` runs in Lima, not on host.** Don't expect host-only paths to work (Mac App bundles, /Applications, etc. — go through AppleScript).
- **`write_file` is home-dir only.** Don't attempt to write into `/tmp/`, `/etc/`, or anywhere outside `~`. Tested and confirmed: returns "Write operations are restricted to the home directory" otherwise.
- **Observational memory is finite.** Don't fill it with verbose status updates — save only durable, surprising, or non-obvious facts.
- **`browse_tools` is the source of truth for tool existence.** When in doubt, check it before calling. Don't hallucinate tool names.
- **Backend ignores category in URL.** Tools resolve by NAME alone. So `sulla anything/spawn_agent` works as `sulla meta/spawn_agent`. But the canonical name (what `sulla <cat> --help` lists) is what you should use.

## Reference

- Tool dirs: `pkg/rancher-desktop/agent/tools/meta/`, `pkg/rancher-desktop/agent/tools/observation/`
- Manifests: `pkg/rancher-desktop/agent/tools/meta/manifests.ts`, `pkg/rancher-desktop/agent/tools/observation/manifests.ts`
- exec implementation: `pkg/rancher-desktop/agent/tools/meta/exec.ts`
- Memory storage: `SullaSettingsModel` (see `tools/pg.md`)
