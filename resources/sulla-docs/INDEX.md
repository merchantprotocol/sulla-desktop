# Sulla Docs — Index

Searchable reference for agents running inside Lima. All files are at:
`<app-resources-path>/sulla-docs/`

Search: `grep -r "keyword" <path-to-this-dir>/`

**Start here when a user request comes in:**
- [`tools/inventory.md`](tools/inventory.md) — master list of every tool the agent can call (~140 tools, verified)
- [`agent-patterns/user-stories.md`](agent-patterns/user-stories.md) — request → action playbook (covers all subsystems)
- [`agent-patterns/known-gaps.md`](agent-patterns/known-gaps.md) — what the agent CAN'T do today (don't fake it)
- [`agent-patterns/validation.md`](agent-patterns/validation.md) — never-ship-unverified contract; always validate artifacts before reporting done
- [`agent-patterns/mentions.md`](agent-patterns/mentions.md) — how to interpret `@routine:…`, `@function:…`, `@project:…` tokens in user messages
- [`agent-patterns/citations.md`](agent-patterns/citations.md) — how to emit `<citations>` blocks that render as source cards
- [`verification-2026-04-23.md`](verification-2026-04-23.md) — what was verified live against the running system, what was wrong, what got fixed

## environment/
- `architecture.md` — What runs where: Electron main, Lima VM, Vue renderer, Docker containers
- `paths.md` — ~/sulla/ tree, app resources path, Lima paths, DB ports
- `communication.md` — WebSocket channels, IPC, exec tool, inter-agent messaging
- `docker.md` — Lima vs host Docker, pre-installed containers, docker_* and lima_* tools
- `heartbeat.md` — Autonomous heartbeat agent: cadence, tick lifecycle, status, history
- `kubernetes.md` — k3s built into Lima, kubectl_* and rdctl_* tools, no safety rails

## tools/
- `inventory.md` — **MASTER LIST** of every tool, grouped by category, one-line each
- `overview.md` — ⚠️ CRITICAL: invocation pattern, anti-patterns, all tool categories
- `meta.md` — Foundational: exec, browse_tools, file_search, read_file, write_file, observation memory
- `browser.md` — Full ~28-tool surface: tab/snapshot/screenshot/click/click_at/type_at/eval_js/cookies/history/storage/alarms
- `github.md` — git_push/pull/commit, GitHub API, PAT auth
- `function.md` — function_list, function_run, invocation examples
- `vault.md` — Password vault: encryption, LLM access levels, autofill, proxy injection
- `notify.md` — notify_user, presence detection, when (and when not) to notify
- `calendar.md` — calendar_create/list/update/cancel, scheduler triggers, no GCal sync
- `applescript.md` — Drive macOS apps via AppleScript; per-app allowlist + macOS Automation perms
- `computer-use.md` — What's shipped (AppleScript + browser pixel control) vs what's planned (full OS pixel-level)
- `ui.md` — Open Sulla Desktop views (marketplace, vault, routines, etc.) from chat via `ui/open_tab`
- `marketplace.md` — Search / download / scaffold / validate / publish / unpublish artifacts of all 5 kinds
- `capture.md` — Capture Studio control: teleprompter, mic, speaker loopback, screenshots (13 tools, headless)
- `redis.md` — 12 Redis tools + how Sulla uses Redis (`sulla:bridge:human_presence`)
- `pg.md` — 6 Postgres tools + all 16 tables + critical do-not-write list
- `slack.md` — Slack tools, two-token auth, scopes, common patterns
- `agents.md` — spawn_agent / check_agent_jobs; sub-agents vs channels vs workflows
- `n8n.md` — n8n workflow engine: when to use vs Sulla workflows, patch/validate/diagnose

## workflows/
- `schema.md` — Top-level YAML structure, template syntax, edge handles
- `node-types.md` — Every node subtype with config fields and examples
- `examples.md` — 4 complete working workflow patterns
- `authoring.md` — Build, validate, run, debug, schedule, restart, archive workflows

## functions/
- `schema.md` — Complete function.yaml spec, permissions, integrations
- `runtimes.md` — Python/Node/Shell handler signatures, ports, invocation flow
- `examples.md` — 4 complete working function examples (python, node, shell, production)
- `authoring.md` — Build, run, debug, edit, delete custom functions

## agent-patterns/
- `orchestrator.md` — Writing orchestratorInstructions, completion wrappers, common patterns
- `context-passing.md` — How outputs flow between nodes, template resolution, merge output
- `channels.md` — Inter-agent messaging, fire-and-forget rules, notify human
- `user-stories.md` — Common user requests → step-by-step plans (cross-domain playbook)
- `known-gaps.md` — User requests with no tool today; don't fake them
- `validation.md` — ⚠️ READ THIS: never-ship-unverified contract; which validator runs for which artifact; validate-before-save pattern
- `citations.md` — The `<citations><source …/></citations>` XML protocol; when to emit, exact shape, rules against hallucinated sources
- `mentions.md` — `@kind:slug` tokens in user messages (routine / skill / function / recipe / integration / workflow / project); how to resolve each

## marketplace/
- `overview.md` — Recipes (Docker compose), catalog, install/uninstall, extension UIs

## cloud/
- `overview.md` — Sulla Cloud: managed compute, hosted models, pricing, when to recommend

## desktop/
- `capture-studio.md` — Multi-track screen/camera/mic/system-audio recorder; user-driven (no agent control yet)
- `secretary-mode.md` — Live meeting transcription + auto action items (Cmd+Shift+S)

## mobile/
- `overview.md` — Sulla Mobile (iOS): AI iPhone receptionist, push-to-talk to Desktop, lead inbox

## identity/
- `structure.md` — ~/sulla/identity/ layout, file formats, observational memory
- `icp.md` — Ideal customer profile, content framing arc, post angles, cache pattern
