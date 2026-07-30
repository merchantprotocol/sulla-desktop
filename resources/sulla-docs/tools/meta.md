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

### `meta/exechost` — Host shell (LAST RESORT ONLY)
```bash
sulla meta/exechost '{
  "command": "open -a Docker",
  "cwd":     "/Users/jonathonbyrdziak",
  "timeout": 60000
}'
```

| Field | Default | Notes |
|-------|---------|-------|
| `command` (or `cmd`) | required | Shell command. Runs on the **host macOS**, not Lima. |
| `cwd` | none | Absolute working dir on the host |
| `timeout` | 60000 (1 min) | ms |
| `stdin` | none | Piped to the command |

**VM-first rule (non-negotiable):**
- Everyday work stays in the Lima VM via regular `exec` / `file_search` / `read_file` / `write_file`.
- The host home directory is mounted into the VM at the **same absolute path**, so project files, installs, builds, tests, and sulla CLI calls do **not** need host execution.
- Use `exechost` **only** when the parent host MUST be used:
  - Host-only binaries / GUI apps (e.g. macOS app bundles under `/Applications`)
  - Host Docker Desktop or other host-only daemons unavailable inside Lima
  - User-installed host tools that truly cannot be installed or used in the VM
  - Explicit user request to run something on the host
- Do **not** use `exechost` for routine search/edit/build/test just because files live under the host home path.
- Prefer reaching host-side services from inside the VM at gateway IP `192.168.5.2` when network access is enough.
- Requires Preferences → Application → Administrative Access → "Allow access to the host machine". Fails closed when disabled.
- Prefer `exechost` over AppleScript→Terminal when host execution is truly required (silent, no Terminal window).

### `meta/browse_tools` — Discover tools
```bash
sulla meta/browse_tools '{"category":"github"}'
sulla meta/browse_tools '{"query":"send message"}'
sulla meta/browse_tools '{}'                          # everything
```

Returns ready-to-run command examples with parameter schemas + credential status. **Always check this before assuming a tool exists** — there are 130+ tools and naming changes happen.

⚠️ The returned strings must be wrapped in `exec()`. They are not directly callable. The output is documentation, not execution.

### `meta/file_search` — Full-text search over files
```bash
sulla meta/file_search '{"query":"workflow scheduler","dirPath":"/Users/.../sulla","limit":20}'
sulla meta/file_search '{"query":"how do I run a function"}'           # primary dir = home, sulla-docs auto-included
sulla meta/file_search '{"query":"...","includeSullaDocs":false}'      # search only dirPath
```

Full-text keyword search (BM25-ranked) across both filenames and contents. Faster and broader than `grep` for multi-word keyword queries ("error handling HTTP timeout"). For exact strings use grep instead. It's keyword matching, not semantic/vector search — pick the words that would actually appear in the file.

**Always also searches the bundled `sulla-docs/` reference** (the docs you're reading right now) unless you pass `includeSullaDocs: false`. Results are grouped per directory so you can see which hits came from where. This means most "where do I do X?" queries get authoritative tool docs returned for free without remembering paths.

Tiered engine: small directories (up to ~2,000 text files) are scanned live on every search, so results are always fresh with no index to maintain. Larger directories use an incremental on-disk FTS index (tokens only, no file bodies) built automatically in a crash-isolated helper process — the first search in a big dir triggers indexing, subsequent searches are fast. Index passes are budgeted, so very large trees may take a few passes to reach full coverage; results include a coverage note whenever the index is partial (pass `reindex:true` or narrow `dirPath` to deepen it). Sensitive paths (`.ssh`, `.gnupg`, `.aws`, etc.) and cloud-placeholder (online-only) files are never scanned or indexed.

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

### `meta/ask_user_question` — Pause mid-turn and ask the user
```bash
sulla meta/ask_user_question '{
  "questions": [{
    "question": "Delete the draft routine `blog-publisher-v2`?",
    "header":   "Confirm",
    "options": [
      { "label": "Approve", "description": "rm -rf ~/sulla/routines/blog-publisher-v2" },
      { "label": "Deny" }
    ]
  }]
}'
```

Renders an interactive card in the chat transcript and **blocks the calling
tool** until the user picks an option (or types a free-form answer, or the
timeout elapses). This is the single "pause and ask the human" tool — use it
for both multiple-choice questions and yes/no go-aheads (offer `Approve` /
`Deny` options for a consent gate). Under Claude Code, call the
`mcp__sulla-native__ask_user_question` MCP tool instead.

| Field | Default | Notes |
|-------|---------|-------|
| `questions` | required | 1–4 questions. Each has `question` (headline), optional `header` (≤~12 char chip), optional `multiSelect`, and 2–4 `options` (each `{ label, description? }`). |
| `timeoutMs` | 300000 (5 min) | Min 5000, max 1800000. On timeout no selection is made — treat as a soft deny / proceed with best judgment. |

**Returns:** a deterministic summary of the selected option(s) per question,
or a "no selection / timed out" note.

**Use it when:**
- You're about to take a destructive action (delete a file/routine/credential,
  rm -rf, drop a table, force-push) — offer `Approve` / `Deny`.
- You're about to call an outbound write (post to Slack/Gmail/CRM, publish
  to the marketplace, push to a production status).
- The user's intent is ambiguous and you want them to pick between options
  instead of guessing.
- You're running inside a workflow and hit a point where the user should
  sign off before you continue.

**Don't use it for:**
- Read-only work (the user didn't sign up to click through every file read).
- Every tool call — that's noise. Save it for actions that are risky,
  destructive, or irreversible, or genuine forks in the plan.

**Semantics vs. `<AGENT_BLOCKED>` wrapper:**
- `ask_user_question` is **mid-turn** — the tool waits, then you continue
  in the same response with the user's answer in hand.
- `<AGENT_BLOCKED>` is **end-of-turn** — you stop and hand the turn back,
  waiting for the next user message to resume.

Pick mid-turn when you need a go/no-go or a pick before proceeding in the
current action. Pick end-of-turn when you genuinely can't proceed without
more information or a larger decision.

See [`agent-patterns/user-consent.md`](../agent-patterns/user-consent.md) for
when to gate and how to phrase the question.

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
- **`exec` runs in Lima, not on host.** Default to it for everyday work. Home files are mounted into the VM at the same path.
- **`exechost` is LAST RESORT.** Use only when the parent host MUST be used (host-only binaries/GUI apps, host Docker Desktop, tools unavailable in the VM, or explicit user request). Never for routine search/edit/build/test.
- **Prefer VM → host network (`192.168.5.2`) over host shell** when you only need to reach a host-side service.
- **`write_file` is home-dir only.** Don't attempt to write into `/tmp/`, `/etc/`, or anywhere outside `~`. Tested and confirmed: returns "Write operations are restricted to the home directory" otherwise.
- **Observational memory is finite.** Don't fill it with verbose status updates — save only durable, surprising, or non-obvious facts.
- **`browse_tools` is the source of truth for tool existence.** When in doubt, check it before calling. Don't hallucinate tool names.
- **Backend ignores category in URL.** Tools resolve by NAME alone. So `sulla anything/spawn_agent` works as `sulla meta/spawn_agent`. But the canonical name (what `sulla <cat> --help` lists) is what you should use.

## Reference

- Tool dirs: `pkg/rancher-desktop/agent/tools/meta/`, `pkg/rancher-desktop/agent/tools/observation/`
- Manifests: `pkg/rancher-desktop/agent/tools/meta/manifests.ts`, `pkg/rancher-desktop/agent/tools/observation/manifests.ts`
- exec implementation: `pkg/rancher-desktop/agent/tools/meta/exec.ts`
- Memory storage: `SullaSettingsModel` (see `tools/pg.md`)
