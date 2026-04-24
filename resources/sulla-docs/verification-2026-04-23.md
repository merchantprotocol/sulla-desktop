# Documentation Verification — 2026-04-23

Live-tested against the running Sulla Desktop backend (token + localhost). Notes what was verified, what was wrong, and what was fixed.

**How to run this verification yourself:**
```bash
export SULLA_HOST=localhost
export SULLA_API_TOKEN="$(cat ~/Library/Application\ Support/rancher-desktop/chat-api-token.json | jq -r .token)"
sulla <category> --help
sulla <category>/<tool> '{...}'
```

---

## Summary

Ran 50+ live tool calls against the backend. Verified ports, tables, tool signatures, file paths, and credential model. Identified 10 material errors across docs, fixed all of them.

---

## What was verified ✓

### Backend & ports
- **Tools API on port 3000** (auth required via `chat-api-token.json`)
- **Extension API on port 6107** (Basic auth)
- **Terminal WS on port 6108**
- **Lima-exposed services** on host:
  - `30116` Postgres ✓
  - `30117` Redis ✓
  - `30118` python_runtime ✓
  - `30119` shell_runtime ✓
  - `30120` node_runtime ✓
- **Host-Docker extensions (on this verification machine):**
  - `30208` twenty-crm-postgres ✓ healthy
  - twenty-crm-server ⚠️ restart loop

### Tool categories (18 + 2 hidden = 20 total)

CLI's `sulla --help` lists 18 categories. The backend additionally exposes `function` and `observation` (verified via `sulla function --help` and `sulla observation --help`).

**`workflow` is NOT a backend category** — `sulla workflow --help` returns "Unknown category." Workflow tools are registered under `meta`.

### Tool counts (verified live)

| Category | Count | Notes |
|----------|-------|-------|
| meta | 8 | includes spawn_agent, execute_workflow |
| observation | 3 | includes write_file (surprise) |
| browser | 23 | |
| github | 25 | |
| docker | 9 | |
| lima | 6 | |
| kubectl | 3 | |
| rdctl | 10 | |
| calendar | 7 | |
| vault | 7 | |
| extensions | 4 | |
| redis | 12 | |
| pg | 6 | |
| slack | 7 | |
| n8n | 5 | **service not installed** |
| agents | 1 | only check_agent_jobs — spawn_agent is under meta |
| bridge | 2 | |
| notify | 1 | |
| applescript | 1 | |
| function | 2 | |

### Postgres (verified)
- **18 tables** confirmed via `information_schema.tables`:
  - All 16 I documented + `sulla_migrations` + `sulla_seeders`
- `workflows` table has **10 columns** including `version` and `source_template_slug` (I originally had 9)
- `calendar_events` has 12 cols including `status` enum ✓
- Postgres 16.13 on aarch64 Alpine
- 2 workflows in DB, both `status='draft'`

### Redis (verified)
- `sulla:bridge:human_presence` hash with 6 fields: available, currentView, currentActivity, activeChannel, idleMinutes, lastSeen ✓
- `bridge/get_human_presence` returns formatted presence ✓
- No other active keys observed

### Browser tools (verified)
- `browser/tab '{"action":"upsert","url":"about:blank","assetId":"test"}'` works ✓
- Params confirmed: `assetId` (NOT `tabId`), `handle` (NOT `selector`) ✓
- Response includes inline dehydrated DOM ✓

### Vault (verified)
- `vault_list_accounts '{"account_type":"github"}'` returned `jonathonbyrdziaks_token` account ★ ACTIVE ✓
- `vault_list` (websites) returned empty (no saved website credentials yet) ✓

### Integration proxy pattern (verified)
- Format: `sulla <account_id>/<slug> '{"method":"GET","path":"/..."}'`
- Tested: `sulla jonathonbyrdziaks_token/github '{"method":"GET","path":"/user"}'`
- Works in routing; needed `base_url` config in this case (the github integration hasn't had its URL set in this install)

### Function runtimes (verified)
- 42 functions listed by `function_list`
- Python on 30118, Node on 30120, Shell on 30119 ✓
- Runtimes responding (tools resolve correctly)

### Services / settings (verified)
- `heartbeatEnabled = "false"` (disabled by default) ✓
- `heartbeatDelayMinutes = "15"` ✓

### File path citations (verified)
22 cited source file paths tested with `ls`. All exist except one (SecretaryModeController.ts is at `pkg/rancher-desktop/controllers/`, which my docs correctly cite — the verification script had a typo).

---

## What was WRONG — fixed during this sweep

### 🔴 High-severity errors fixed

1. **`environment/docker.md` had Lima vs host Docker inverted.**
   I said docker tools target Lima. They actually target the host Docker daemon. Lima-internal services (sulla_postgres, redis, runtimes) do NOT appear in `docker_ps`. Fixed the whole "two Docker scopes" section.

2. **`tools/agents.md` said `spawn_agent` is under `agents/`.**
   Canonical is `sulla meta/spawn_agent`. Only `check_agent_jobs` lives under `agents/`. Fixed.

3. **`workflows/authoring.md` used `sulla workflow/*`.**
   `workflow` is not a backend category. Canonical is `sulla meta/execute_workflow`, etc. Fixed across authoring.md and user-stories.md.

4. **`tools/meta.md` said `write_file` is under `meta/`.**
   Canonical is `sulla observation/write_file`. (Both work because backend ignores URL category, but the `--help` canonical is observation.) Fixed.

5. **`tools/n8n.md` said n8n runs on port 30119.**
   n8n is NOT running anywhere. The 30119 default in `N8nService.ts:28` collides with shell_runtime. Fixed to explain the state and direct the agent to check `vault_is_enabled` first.

### 🟡 Medium-severity errors fixed

6. **`environment/architecture.md` omitted ports 3000 and 6107.**
   Backend Tools API is on 3000; Extension API on 6107. Added to the service init diagram.

7. **`tools/pg.md` missed `version` and `source_template_slug` columns on workflows.**
   Fixed.

8. **`tools/pg.md` claimed 16 tables; actual is 18.**
   Added `sulla_migrations` and `sulla_seeders`. Fixed.

9. **`tools/inventory.md` had wrong tool counts for several categories.**
   Rewrote with verified live counts per category.

10. **`agent-patterns/known-gaps.md` was missing environment reality check.**
    Added section listing n8n-not-running, Twenty CRM broken, heartbeat-disabled-default, and the `rdctl_shell` quoting limitation.

---

## Hidden discoveries worth remembering

### Backend ignores URL category
`/v1/tools/internal/<anything>/<tool>/call` resolves by tool **name** alone. `anything` can be literally "asdfqwerty" and it still works. This is why `sulla agents/spawn_agent` works even though the tool is canonically under `meta`. Use canonical names for clarity.

### Host CLI category whitelist is stale
`/Users/jonathonbyrdziak/.rd/bin/sulla` has a hardcoded `TOOL_CATEGORIES` list that omits `function`, `workflow`, `observation`. When those are used as the first segment, the CLI thinks it's a proxy call and fails. The **agent inside the desktop doesn't use this CLI** — it calls the registry directly — so agent invocations work. But host-based testing of `function/*` tools may fail from the shell script.

**Workaround for host testing:** hit the backend URL directly with curl.

### `rdctl_shell` is restricted
Does NOT accept pipes (`|`), redirects (`>`, `<`), chain operators (`&&`, `;`), or quoted shell wrappers. Single command + args only. Multi-step work needs multiple calls.

### Observational memory survives via `sulla_settings`
Memories are stored as JSON in the `sulla_settings` Postgres table. Cap is 50 entries; older ones prune. Dedup is substring-based — re-saving the same fact updates priority/timestamp instead of duplicating.

### Vault is DB + Electron safeStorage
Credentials encrypted with AES-256-GCM. VMK derived from master password via PBKDF2 (100k iter), wrapped by Electron `safeStorage` (OS keychain). Separate files in `~/.sulla/`: vault-salt, vault-key.enc, vault-key.backup, vault-recovery-hash, vault-verify.

---

## What I did NOT verify

- n8n tools against a running instance (none exists)
- Slack tools against a live workspace (didn't want to send test messages)
- Calendar event creation (would have created real entries)
- `spawn_agent` end-to-end (would have spun up work)
- AppleScript (would have touched user's macOS apps)
- Kubectl delete (obviously)
- `rdctl_reset` (would have wiped the cluster)

For these, the docs describe the contract but haven't been battle-tested in this sweep.

---

## How to re-verify

Run this from a shell on the host:

```bash
export SULLA_HOST=localhost
export SULLA_API_TOKEN="$(jq -r .token < ~/Library/Application\ Support/rancher-desktop/chat-api-token.json)"

# Enumerate categories
sulla --help

# Enumerate tools in a category
sulla meta --help
sulla pg --help
sulla browser --help
# ... etc

# Direct backend (bypasses CLI script's stale category list)
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SULLA_API_TOKEN" \
  -d '{}' \
  http://localhost:3000/v1/tools/internal/<category>/<tool>/call

# Inspect Postgres
sulla pg/pg_queryall '{"sql":"SELECT table_name FROM information_schema.tables WHERE table_schema = '\''public'\'' ORDER BY table_name"}'

# Inspect Redis
sulla redis/redis_hgetall '{"key":"sulla:bridge:human_presence"}'
```

If any doc in `sulla-docs/` contradicts what these commands return, the doc is wrong — trust the live system.
