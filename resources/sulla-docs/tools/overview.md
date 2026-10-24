# Sulla Tools — Overview & Critical Patterns

## Invocation Pattern

```bash
exec({ command: "sulla <category>/<tool> '<json_params>'" })
```

For large JSON, pass `-` to read stdin or `@/path/file.json` to stream a file without putting the payload in argv.

**This is the ONLY correct way to call CLI tools.**

Examples:
```bash
exec({ command: "sulla github/git_status '{}'" })
exec({ command: "sulla browser/tab '{\"action\":\"upsert\",\"url\":\"https://example.com\"}'" })
exec({ command: "sulla function/run '{\"slug\":\"my-func\",\"inputs\":{\"n\":10}}'" })
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

### `exechost` is last resort, not everyday shell
Default to regular `exec` (Lima VM) for search, edit, install, build, test, and sulla CLI. The host home directory is mounted into the VM at the same path. Use `meta/exechost` only when the parent host MUST be used (host-only apps/daemons, tools unavailable in the VM, or explicit user request). Prefer VM network access to host services at `192.168.5.2` when that is enough.

### `browse_tools` returns strings, not executions
`browse_tools` lists tools — it does not run them. Wrap the returned command in `exec()` to actually invoke it.

---

## Tool Categories

| Category | Tools | Primary Use |
|----------|-------|------------|
| `meta` | exec, exechost (last resort), browse_tools, file_search, read_file, ask_user_question, workflow helpers | System, file ops, tool discovery |
| `browser` | tab, screenshot, eval_js, snapshot, text, form, click, fill, scroll, manage_cookies, background_browse | Web automation |
| `github` | git_push, git_pull, git_commit, git_add, git_status, git_log, git_diff, git_branch, github_create_pr, github_create_issue | Git & GitHub |
| `function` | list, run, runs | Custom function execution |
| `docker` | docker_ps, docker_logs, docker_run, docker_exec, docker_stop, docker_rm, docker_build | Container management |
| `slack` | send_message, update, thread, search_users, user, unreact, connection_health | Messaging |
| `notify` | user, history | Desktop and mobile notifications |
| `redis` | get, set, del, incr, decr, expire, ttl, hget, hset, hgetall, lpop, rpush | Key-value store |
| `pg` | query, queryall, queryone, count, execute, transaction | PostgreSQL |
| `calendar` | create, get, list, list_upcoming, update, cancel, delete | Local events |
| `workflow` | import_workflow, refresh_schedules, catch_up_schedules, set_workflow_status, routine_report, display_workflow | Workflow lifecycle and schedules |
| `vault` | read_secrets, is_enabled, list_accounts, set_credential, set_active_account, list, autofill, delete_credential | Credentials |
| `models` | providers, list, usage | AI provider and model inventory (read-only) |
| `settings` | get, set | Sulla Desktop settings (use these, not raw Redis) |
| `skills` | skill_list, skill_get, skill_save, skill_disable | Skills stored in the database |
| `agents` | list_agents, check_agent_jobs, stop_agent_job, conversation tools | Agent registry and async job management |
| `applescript` | execute, audit_log | macOS app automation |
| `extensions` | list_extension_catalog, list_installed_extensions, install_extension, uninstall_extension, start_extension, stop_extension, get_extension_status | Recipe lifecycle |
| `marketplace` | search, info, download, scaffold, validate, publish, unpublish, list_local, list_published, update, diff | Artifact lifecycle for Use Cases (the marketplace) |
| `bridge` | update_human_presence, get_human_presence | Agent presence/state |
| `ui` | open_tab | Open Sulla Desktop views from chat (incl. `projects`) |
| `capture` | teleprompter_*, mic_start/stop, speaker_start/stop, audio_state, list_screens, screenshot | Capture Studio control (headless) |
| `observation` | add/search/list/remove observational memory; add/search/list/remove identity observations; update_identity_section | Memory and domain-keyed identity observations |


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
exec({ command: "sulla vault/is_enabled '{\"account_type\":\"github\"}'" })
```

Read credentials (masked by default; only pass `include_secrets:true` when the user asked for the secret):
```bash
exec({ command: "sulla vault/read_secrets '{\"account_type\":\"slack\"}'" })
```

Common `account_type` values: `github`, `slack`, `anthropic`, `openai`, `twenty`, `intuit`


Projects are plain files. See [Projects in Files](../environment/projects-in-files.md).
