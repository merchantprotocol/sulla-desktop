# Sulla Tools — Overview & Critical Patterns

## Invocation Pattern

```bash
exec({ command: "sulla <category>/<tool> '<json_params>'" })
```

**This is the ONLY correct way to call CLI tools.**

Examples:
```bash
exec({ command: "sulla github/git_status '{}'" })
exec({ command: "sulla browser/tab '{\"action\":\"upsert\",\"url\":\"https://example.com\"}'" })
exec({ command: "sulla function/function_run '{\"slug\":\"my-func\",\"inputs\":{\"n\":10}}'" })
exec({ command: "sulla pg/query '{\"sql\":\"SELECT * FROM users LIMIT 5\"}'" })
exec({ command: "sulla slack/send_message '{\"channel\":\"C01234\",\"text\":\"hello\"}'" })
```

---

## Anti-Patterns

### `execute_workflow` is for workflows, not CLI tools
`execute_workflow` runs **named Sulla workflows** by ID. If your intent is to execute a workflow, that's the right tool — use it.

The mistake is reaching for `execute_workflow` when you actually want a CLI tool like `browser/tab` or `github/git_push`. CLI tools are not workflows and will fail under `execute_workflow`.

```
WRONG (if your goal is a CLI call):
  execute_workflow({ workflowId: "browser/tab", ... })

RIGHT (for a CLI call):
  exec({ command: "sulla browser/tab '...'" })

RIGHT (for an actual workflow):
  execute_workflow({ workflowId: "daily-digest", inputs: {...} })
```

### `browser/tab` actions
`remove` closes a tab. Anything else (including `upsert` or `open`) is treated as upsert — it opens or navigates the tab. Prefer `upsert` for clarity, but `open` is not an error.

### Never hardcode credentials
Always resolve from vault. Never put API keys in code or prompts.

### `browse_tools` returns strings, not executions
`browse_tools` lists tools — it does not run them. Wrap the returned command in `exec()` to actually invoke it.

---

## Tool Categories

| Category | Tools | Primary Use |
|----------|-------|------------|
| `meta` | exec, browse_tools, file_search, read_file, write_file, add_observational_memory, remove_observational_memory | System, file ops, tool discovery |
| `browser` | tab, screenshot, eval_js, snapshot, text, form, click, fill, scroll, manage_cookies, background_browse | Web automation |
| `github` | git_push, git_pull, git_commit, git_add, git_status, git_log, git_diff, git_branch, github_create_pr, github_create_issue | Git & GitHub |
| `function` | function_list, function_run | Custom function execution |
| `docker` | docker_ps, docker_logs, docker_run, docker_exec, docker_stop, docker_rm, docker_build | Container management |
| `slack` | slack_send_message, slack_search_users, slack_thread, slack_connection_health | Messaging |
| `notify` | notify_user | Desktop notifications |
| `redis` | redis_get, redis_set, redis_hget, redis_hset, redis_hgetall, redis_lpop, redis_rpush, redis_expire | Key-value store |
| `pg` | pg_query, pg_queryall, pg_queryone, pg_execute, pg_transaction | PostgreSQL |
| `calendar` | calendar_create, calendar_get, calendar_list, calendar_list_upcoming, calendar_update, calendar_cancel | Events |
| `workflow` | execute_workflow, validate_sulla_workflow, restart_from_checkpoint | Workflow execution |
| `vault` | vault_read_secrets, vault_is_enabled, vault_list_accounts, vault_set_credential, vault_list | Credentials |
| `agents` | spawn_agent, check_agent_jobs | Sub-agent spawning |
| `applescript` | applescript_execute | macOS app automation |
| `extensions` | list_extension_catalog, list_installed_extensions, install_extension, uninstall_extension, start_extension, stop_extension, get_extension_status | Recipe lifecycle |
| `marketplace` | search, info, download, scaffold, validate, publish, unpublish, list_local, list_published, update | Generic artifact lifecycle (6 kinds: skill / function / workflow / agent / recipe / integration) |
| `bridge` | update_human_presence, get_human_presence | Agent presence/state |
| `ui` | open_tab | Open Sulla Desktop views from chat |
| `capture` | teleprompter_*, mic_start/stop, speaker_start/stop, audio_state, list_screens, screenshot | Capture Studio control (headless) |
| `observation` | add_observational_memory, remove_observational_memory, write_file | Long-term memory + file writes |

---

## Proxy API Calls (External Integrations)

For external services with an account in the vault:
```bash
sulla <account_id>/<slug> '{"method":"GET","path":"/api/endpoint","body":{...}}'
```

Credentials are auto-injected from the vault — do not pass them manually.

---

## Discover Available Tools

```bash
exec({ command: "sulla meta/browse_tools '{\"query\":\"browser\"}'" })
```

Returns a list of tools with their slugs and parameter schemas. Verify a tool exists before using it.

---

## Authentication (Vault)

Check if an integration is connected:
```bash
exec({ command: "sulla vault/vault_is_enabled '{\"account_type\":\"github\"}'" })
```

Read credentials:
```bash
exec({ command: "sulla vault/vault_read_secrets '{\"account_type\":\"slack\",\"include_secrets\":true}'" })
```

Common `account_type` values: `github`, `slack`, `anthropic`, `openai`, `twenty`, `intuit`
