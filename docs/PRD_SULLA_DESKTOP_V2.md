# Sulla Desktop v2 — Architecture & Vision

## Overview

Sulla Desktop transforms from a local-model AI assistant into a **Claude Code command center** — the bridge between your phone, your machine, and your AI. It manages a sandboxed Claude Code instance, exposes MCP servers, connects to Sulla Mobile, and acts as a persistent agent endpoint for workflows.

The local model inference (llama.cpp, Ollama) and training pipeline are removed. Claude Code running inside a Lima VM becomes the brain. Sulla Desktop becomes the body.

---

## Core Principles

1. **Claude Code is the brain.** Sulla doesn't compete with it — it gives it a body, senses, and memory.
2. **The VM is the sandbox.** Claude Code runs with `--dangerously-skip-permissions` inside a Lima VM. Full autonomy, zero risk to the host.
3. **Everything flows through sync.** Mobile ↔ Cloud ↔ Desktop. Same offline-first architecture as Sulla Mobile.
4. **One-click setup.** Install the app, scan QR from phone, done. No terminal, no JSON editing, no config files.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    SULLA DESKTOP                         │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Mobile       │  │  Agent       │  │  MCP Server   │  │
│  │  Bridge       │  │  Orchestrator│  │  Hub          │  │
│  │              │  │              │  │               │  │
│  │  WS to CF    │  │  Route tasks │  │  - Vault      │  │
│  │  QR pairing  │  │  Pre/post    │  │  - Browser    │  │
│  │  Push notifs  │  │  process     │  │  - Memory     │  │
│  │              │  │  Queue mgmt  │  │  - File watch  │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                 │                   │          │
│  ───────┴─────────────────┴───────────────────┴────────  │
│                     MCP Bridge                           │
│  ────────────────────────┬───────────────────────────── │
│                          │                               │
│  ┌───────────────────────┴───────────────────────────┐  │
│  │                  LIMA VM                            │  │
│  │                                                    │  │
│  │   Claude Code (--dangerously-skip-permissions)     │  │
│  │                                                    │  │
│  │   Mounted: ~/projects/my-app (read-write)          │  │
│  │            ~/projects/other   (read-only)          │  │
│  │                                                    │  │
│  │   Tools: git, node, python, docker                 │  │
│  │   MCP: connects to host-side servers via bridge    │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │                  DESKTOP UI                         │  │
│  │                                                    │  │
│  │  Menu bar icon (glow when active, badge for tasks) │  │
│  │  Chat view (existing BrowserTabChat)               │  │
│  │  Diff reviewer (approve/reject hunks)              │  │
│  │  MCP manager (toggle, configure, logs)             │  │
│  │  Project mount manager                             │  │
│  │  Task queue & history                              │  │
│  │  Settings (mobile link, security, team)            │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
           │                              ▲
           ▼                              │
┌─────────────────────┐       ┌──────────────────────┐
│   SULLA CLOUD       │       │   SULLA MOBILE       │
│   (CF Workers)      │◄─────►│   (iOS App)          │
│                     │       │                      │
│   D1, Sync, WS     │       │   Chat with Sulla    │
│   Agent fallback    │       │   QR code pairing    │
│   Team routing      │       │   Task submission    │
└─────────────────────┘       └──────────────────────┘
```

---

## What Gets Removed

| Component | Reason |
|-----------|--------|
| llama.cpp service (`LlamaCppService.ts`) | Replaced by Claude Code in Lima VM |
| Ollama integration | No longer needed |
| Model download manager | No local models |
| Training pipeline (`/training/`, TrainingPane, TrainingDashboard) | Spun out or dropped |
| GGUF model management | No local models |
| Capture Studio | Spun into its own standalone app |
| Teleprompter | Moves with Capture Studio |
| Computer Use agent | Replaced by Claude Code's native capabilities |

## What Gets Kept

| Component | Role in v2 |
|-----------|-----------|
| Chat UI (BrowserTabChat, SidePanelChat) | Primary interface — points at Claude Code instead of local model |
| Conversation history system | Persists across sessions, syncs to mobile |
| MCP infrastructure (MCPBridge, MCPClient) | Bridges host-side servers into Lima VM |
| Password vault (AccountEditor) | MCP server for credential access |
| Browser tabs (WebContentsView) | MCP server for web browsing |
| Audio driver (Whisper, VAD) | Voice input to Claude Code |
| Integrations (Slack, GitHub) | Available as MCP tools |
| LLM provider abstraction | Keep Anthropic/OpenAI providers for the orchestrator |
| Agent graph system | Simplified to orchestration/routing role |
| Build/signing infrastructure | DMG, hardened runtime, entitlements |

## What Gets Added

### 1. QR Code Pairing with Sulla Mobile

User opens Sulla Desktop → Settings → "Connect Phone" → shows QR code containing:
- A one-time pairing token
- The desktop's WebSocket endpoint (via Cloudflare Tunnel or direct LAN)

Sulla Mobile scans it → exchanges the token for a persistent auth credential → both sides store it. From then on, messages from the phone flow to the desktop.

**Implementation:**
- Desktop generates pairing token, stores in Keychain
- CF Workers endpoint: `POST /pairing/initiate` and `POST /pairing/confirm`
- Mobile scans QR, confirms pairing, receives desktop's connection details
- Desktop subscribes to the contractor's WS channel on CF Workers

### 2. Lima VM Provisioning

On first run (or project setup), Sulla Desktop provisions a Lima VM:

```yaml
# ~/.sulla/lima/default.yaml
images:
  - location: "https://cloud-images.ubuntu.com/releases/24.04/..."
cpus: 4
memory: 8GiB
disk: 50GiB
mounts:
  - location: "~/Projects"
    writable: true
provision:
  - mode: system
    script: |
      curl -fsSL https://raw.githubusercontent.com/anthropics/claude-code/main/install.sh | sh
      npm install -g @anthropic-ai/claude-code
```

**Project Mount Manager UI:**
- List of directories with read-only / read-write toggle
- Add/remove mounts without restarting the VM
- Visual indicator of what Claude can access

### 3. Agent Orchestrator

A thin routing layer that sits between inbound messages and Claude Code. Not a full LLM agent loop — a rule-based router with optional LLM escalation.

**Responsibilities:**

```
Inbound message (mobile, workflow trigger, scheduled)
    │
    ▼
┌─────────────────────┐
│  Can I answer from   │──yes──► Return from memory/cache
│  memory or cache?    │         (zero tokens burned)
└─────────┬───────────┘
          │ no
          ▼
┌─────────────────────┐
│  Does this need      │──no───► Route to Claude API directly
│  codebase access?    │         (simple questions, summaries)
└─────────┬───────────┘
          │ yes
          ▼
┌─────────────────────┐
│  Spin up Claude Code │
│  in Lima VM with     │
│  project context     │
│  Stream response     │
└─────────────────────┘
          │
          ▼
┌─────────────────────┐
│  Post-process:       │
│  - Store in memory   │
│  - Update conv       │
│  - Push to mobile    │
│  - Notify if needed  │
└─────────────────────┘
```

**Multi-step orchestration:**

Some tasks span multiple tools and time. Example: "Deploy the fix I merged yesterday."

1. Orchestrator checks git log for yesterday's merge (Claude Code)
2. Verifies CI passed (GitHub MCP)
3. Triggers deploy (Claude Code runs deploy script)
4. Monitors health endpoint (HTTP check loop)
5. Reports result to mobile (push notification)

This is where the existing LangGraph node system gets repurposed — the nodes become orchestration steps, not LLM inference steps.

### 4. MCP Server Hub

Sulla Desktop runs managed MCP servers on the host, bridged into the Lima VM:

| Server | What it provides |
|--------|-----------------|
| **Vault** | Secure credential access via macOS Keychain. Claude asks for "the staging database password" and gets it without it ever being in a config file. |
| **Browser** | Headless Playwright instance. Claude can screenshot pages, fill forms, test UIs, scrape current documentation. |
| **Memory** | Persistent structured memory. Survives sessions, syncs to Sulla Cloud, available on mobile. Not just CLAUDE.md — actual queryable knowledge. |
| **File Watcher** | Monitor directories for changes. Claude gets notified when builds complete, tests fail, or files change without polling. |
| **Terminal** | Persistent shell sessions. Long-running dev servers, build watchers, log tailers that Claude can check on. |
| **Calendar** | Read schedule, create events, check availability. "Block 2 hours tomorrow for the auth refactor." |
| **Notifications** | Push to phone, desktop notification, email. "Notify me when the deploy is done." |

**MCP Manager UI:**
- Card per server with on/off toggle
- Configuration panel (credentials, paths, settings)
- Live log viewer per server
- Health status indicator

### 5. Mobile Bridge

Sulla Desktop subscribes to the contractor's WebSocket channel on CF Workers. When a `claude_message` with `role: user` arrives:

1. Orchestrator evaluates the message
2. Routes to appropriate handler (memory, API, or Claude Code)
3. Response is stored locally + pushed via the existing sync architecture
4. Mobile receives the response via WS in real-time

**When Desktop is offline:**
- CF Workers has the Grok-based fallback agent (already built)
- Or message queues until desktop comes online
- Configurable: "Use cloud agent when desktop is offline" toggle

### 6. Workflow Integration

Sulla's DAG engine is the workflow system. No external tools needed. Workflows are YAML files in `/sulla/workflows/` that the PlaybookController walks, spawning sub-agents at each node.

**The dev pipeline, nightly research, customer onboarding — all are Sulla workflows:**
- Triggered from mobile chat, scheduled via HeartbeatNode, or spawned by other workflows
- Each agent node gets fresh context, full tool access, and decides its own completion
- Parallel branches run concurrently via sub-agent spawning
- Loop nodes retry until gates pass
- Results stream to mobile in real-time

**Task queue:**
- Priority levels: urgent (interrupt current work), normal (queue), background (run when idle)
- Retry with backoff on failure
- Task history with full logs
- Cancel/pause from mobile or desktop UI

---

## User Experience

### First Run
1. Install Sulla Desktop from DMG
2. App opens → "Welcome to Sulla"
3. "Scan this QR code with Sulla Mobile" → pairing flow
4. "Select projects Claude can access" → file picker, mount manager
5. Lima VM provisions in background (progress bar)
6. "Sulla is ready" → menu bar icon appears with glow

### Daily Use
- Menu bar icon shows status (idle / working / needs attention)
- Click icon → dropdown with current task, recent conversations, quick actions
- Chat from phone → desktop Claude does the work → result on phone
- Open full window → conversation view, diff reviewer, task queue, MCP manager

### Approvals
Configurable per-project trust level:
- **Full auto** — Claude applies changes directly (for personal projects)
- **Review diffs** — Changes land in a scratch mount, native diff UI shows what changed, one-click approve/reject
- **Ask first** — Claude proposes what it wants to do, waits for approval before executing

---

## Revenue Model

| Tier | What you get |
|------|-------------|
| **Free** | Mobile chat with cloud agent (Grok), 3 conversations/day |
| **Pro** ($29/mo) | Unlimited mobile chat, connect 1 desktop, persistent memory, 5 MCP servers |
| **Team** ($49/user/mo) | Multi-user, shared memory, team routing, workflow library, unlimited MCP servers |

The desktop app itself is free to install. Value is in the Sulla Cloud subscription that enables sync, mobile bridge, and team features.

---

## Workflow Pipeline: Long-Running Autonomous Development

### The Problem

Claude Code is a prompt/response engine. Users babysit it — watching every step, correcting mistakes, re-explaining context after it forgets. Nobody wants to micromanage their AI. They want to say "build this feature" and come back to a PR.

The reason this doesn't work today:
- Single session loses context after 5-6 exchanges
- Claude can't catch its own mistakes (same session, same blind spots)
- It stops at ambiguity instead of figuring it out
- Rate limits kill long sessions unpredictably
- No validation — you don't know if the output works until you manually check

### The Solution: Staged Pipeline with Adversarial Verification

Each stage runs a **fresh Claude Code session** with a clear objective and a validation gate. Stages loop until their gate passes. The pipeline can run for hours without human intervention.

```
User: "Add Stripe billing to the app"
          │
     ┌────┴────┐
     │ ARCHITECT│ → Read codebase, write design doc (files, data model, API)
     └────┬────┘   Gate: design doc committed to repo
          │
     ┌────┴────┐
     │IMPLEMENT│ → Follow design doc, write code, commit per logical unit
     └────┬────┘   Gate: all files from design doc exist and compile
          │        Loop: if design gap found → update doc → re-ARCHITECT
          │
     ┌────┴────┐
     │ VERIFY  │ → Fresh session. Read design + code. Find gaps, broken
     └────┬────┘   imports, missing edge cases. File issues.
          │        Gate: zero findings
          │        Loop: findings → IMPLEMENT fixes → re-VERIFY
          │
     ┌────┴────┐
     │  TEST   │ → Write tests against design requirements (not implementation)
     └────┬────┘   Run them. Fix failures.
          │        Gate: all tests pass
          │        Loop: failures → fix → re-run
          │
     ┌────┴────┐
     │ BROWSER │ → Start dev server. Playwright navigates the UI.
     │  TEST   │   Screenshot each state. Verify visually.
     └────┬────┘   Gate: all flows pass
          │        Loop: failures → IMPLEMENT fixes → re-test
          │
     ┌────┴────┐
     │DOCUMENT │ → Inline comments where logic isn't obvious.
     └────┬────┘   Update README, API docs, changelog.
          │        Gate: docs updated
          │
     PR created → user notified on phone
```

### Why Each Stage Is a Separate Session

- **Fresh context.** No degradation from 20+ tool calls. Each stage starts clean with exactly the context it needs.
- **Adversarial verification.** VERIFY is deliberately a different session than IMPLEMENT. It can't excuse its own reasoning or remember shortcuts it took. It reads the code cold.
- **Automatic looping.** VERIFY finds 3 issues → IMPLEMENT gets a list of specific findings → fixes them → VERIFY runs again with fresh eyes. No human in the loop.
- **Resumable.** Rate-limited at stage 3? Orchestrator waits and retries. Stages 1-2 are committed and persisted. Nothing lost.
- **Hours, not minutes.** A pipeline with loops might run 30 Claude Code sessions over 2 hours. Status updates push to your phone throughout.

### Pipeline Node Configuration

Each node in the pipeline is configurable:

```yaml
architect:
  prompt: "Read the codebase. Write a design document for: {task}"
  context:
    - CLAUDE.md
    - relevant source files (auto-detected from task description)
  output: docs/designs/{task-slug}.md
  gate: file exists and contains ## Files to Create section
  max_retries: 3
  timeout: 15m

implement:
  prompt: "Follow {design_doc} exactly. Commit after each logical unit."
  context:
    - design doc from architect stage
    - existing source files referenced in design
  gate: "all files listed in design doc exist; project compiles"
  loop_to: architect (on design gap)
  max_retries: 5
  timeout: 30m

verify:
  prompt: "You are a code reviewer. Read {design_doc} and the implementation. Find every gap, bug, incomplete implementation, and missing edge case. Be thorough and adversarial."
  context:
    - design doc
    - git diff from implement stage
  gate: zero findings reported
  loop_to: implement (with findings as input)
  max_retries: 3
  timeout: 15m

test:
  prompt: "Write tests for the requirements in {design_doc}. Test behavior, not implementation. Run them."
  context:
    - design doc
    - implementation files
    - existing test patterns in repo
  gate: all tests pass
  loop_to: implement (with failure details)
  max_retries: 5
  timeout: 20m

browser_test:
  prompt: "Start the dev server. Use Playwright to test the UI. Screenshot each state. Verify the feature works end-to-end."
  context:
    - design doc (expected flows)
    - implementation files (routes, components)
  gate: all screenshots captured, no errors
  loop_to: implement (with screenshot + error details)
  max_retries: 3
  timeout: 15m

document:
  prompt: "Add inline comments where logic isn't obvious. Update README and API docs. Write a changelog entry. Do not over-comment."
  context:
    - design doc
    - all new/modified files
  gate: docs updated, PR description written
  max_retries: 2
  timeout: 10m
```

### Integration with Sulla's DAG Engine

Each pipeline is a native Sulla workflow YAML. The stages are agent nodes in the existing DAG executor. This means:

- **AI-orchestrated routing** — the agent decides when a stage is done (`<AGENT_DONE>`), blocked (`<AGENT_BLOCKED>`), or needs more work (`<AGENT_CONTINUE>`)
- **Parallel execution** — IMPLEMENT and TEST can run as parallel branches with sub-agent spawning, merging results before VERIFY
- **Loop nodes** — VERIFY can loop back to IMPLEMENT with `loopMode: 'while'` until zero findings
- **Sub-agent nesting** — each stage spawns a fresh agent graph with its own context, tools, and conversation
- **Workflow composition** — the dev pipeline can be a sub-workflow inside a larger automation (e.g., "on GitHub issue → run dev pipeline → create PR → notify on Slack")
- **Heartbeat triggers** — scheduled workflows can run the pipeline overnight via HeartbeatNode
- **Customizable** — users edit YAML to add stages, change prompts, adjust gate conditions

### Example: Development Pipeline as Sulla Workflow

```yaml
id: workflow-dev-pipeline
name: Development Pipeline
description: Full feature implementation with adversarial verification

nodes:
  - id: trigger
    data:
      category: trigger
      subtype: chat-app
      config:
        triggerDescription: "Feature request or task description"

  - id: architect
    data:
      category: agent
      subtype: agent
      config:
        agentId: code-researcher
        agentName: Architect
        orchestratorInstructions: |
          Read the codebase. Write a design document for: {{trigger.message}}
          Include: files to create, files to modify, data model, API shape.
          Save the design doc to docs/designs/ in the repo. No code yet.
        completionContract: "Exit when design doc is committed"

  - id: implement
    data:
      category: agent
      subtype: agent
      config:
        agentId: code-researcher
        agentName: Implementer
        orchestratorInstructions: |
          Follow the design doc from {{architect.result}} exactly.
          Commit after each logical unit. If you find a design gap,
          report it via <AGENT_BLOCKED>.
        completionContract: "Exit when all files from design doc exist and compile"

  - id: verify
    data:
      category: agent
      subtype: agent
      config:
        agentId: code-researcher
        agentName: Verifier
        orchestratorInstructions: |
          You are a code reviewer. Read the design doc and the implementation.
          Find every gap, bug, incomplete implementation, and missing edge case.
          Be thorough and adversarial. This is NOT your code — review it cold.
          If issues found: report via <AGENT_BLOCKED> with specific file:line findings.
          If clean: approve via <AGENT_DONE>.

  - id: verify-loop
    data:
      category: flow-control
      subtype: loop
      config:
        loopMode: while
        maxIterations: 5
        condition: "{{verify.status}} == 'blocked'"
        # Loops back to implement with verify's findings

  - id: parallel-test
    data:
      category: flow-control
      subtype: parallel

  - id: unit-test
    data:
      category: agent
      subtype: agent
      config:
        agentId: code-researcher
        agentName: Test Writer
        orchestratorInstructions: |
          Write tests against the design requirements, not the implementation.
          Run them. Fix failures. Loop until green.
        completionContract: "Exit when all tests pass"

  - id: browser-test
    data:
      category: agent
      subtype: agent
      config:
        agentId: code-researcher
        agentName: Browser Tester
        orchestratorInstructions: |
          Start the dev server. Use browser tools to navigate the UI.
          Screenshot each state. Verify the feature works end-to-end.
          If failures: report via <AGENT_BLOCKED> with screenshots.
        completionContract: "Exit when all flows pass visually"

  - id: merge-tests
    data:
      category: flow-control
      subtype: merge

  - id: document
    data:
      category: agent
      subtype: agent
      config:
        agentId: code-researcher
        agentName: Documentor
        orchestratorInstructions: |
          Add inline comments where logic isn't obvious.
          Update README and API docs. Write a changelog entry.
          Create a PR with a clear description. Do not over-comment.
        completionContract: "Exit when PR is created"

  - id: response
    data:
      category: io
      subtype: response
      config:
        responseTemplate: |
          Development pipeline complete.
          PR: {{document.result}}
          Tests: {{unit-test.result}}
          Browser: {{browser-test.result}}

edges:
  - source: trigger
    target: architect
  - source: architect
    target: implement
  - source: implement
    target: verify
  - source: verify
    target: implement
    condition: "{{verify.status}} == 'blocked'"
  - source: verify
    target: parallel-test
    condition: "{{verify.status}} == 'done'"
  - source: parallel-test
    target: unit-test
    sourceHandle: branch-0
  - source: parallel-test
    target: browser-test
    sourceHandle: branch-1
  - source: unit-test
    target: merge-tests
  - source: browser-test
    target: merge-tests
  - source: merge-tests
    target: document
  - source: document
    target: response
```

This runs entirely within Sulla's existing DAG executor. Each agent node spawns a fresh sub-agent graph with full tool access. The orchestrator walks the DAG, the agents decide when they're done, and the loop/parallel/merge flow control handles the rest.

### Status Reporting to Mobile

Throughout the pipeline, Sulla Mobile shows:

```
┌─────────────────────────────┐
│  Add Stripe billing          │
│                              │
│  ✓ Architect      2m 14s    │
│  ✓ Implement     12m 03s    │
│  ✓ Verify         4m 31s    │
│  ● Testing...     1m 22s    │
│  ○ Browser Test              │
│  ○ Document                  │
│                              │
│  ▸ Running: test_checkout.ts │
│    12 passed, 1 failing      │
│    Retrying fix...           │
└─────────────────────────────┘
```

The user sees real-time progress without opening their laptop. If something needs human input (ambiguous requirement, credentials needed), it pushes a notification and waits.

---

## Implementation Phases

### Phase 1: Strip & Pair (1-2 weeks)
- Remove local model code (llama.cpp, Ollama, training)
- Extract Capture Studio into standalone repo
- Add QR pairing flow with Sulla Mobile
- Desktop subscribes to contractor's WS channel

### Phase 2: Lima VM (1-2 weeks)
- Provision Lima VM from desktop app
- Install Claude Code inside VM
- Project mount manager UI
- Basic chat → Claude Code pipe (replace local model with VM)

### Phase 3: MCP Hub (2-3 weeks)
- Vault MCP server (Keychain integration)
- Browser MCP server (Playwright)
- Memory MCP server (persistent, synced)
- MCP manager UI with toggle/configure/logs

### Phase 4: Orchestrator (2-3 weeks)
- Message routing (memory → API → Claude Code)
- Multi-step task execution
- Task queue with priorities
- Workflow trigger endpoint (HTTP + WS)

### Phase 5: Development Pipeline (2-3 weeks)
- Dev pipeline workflow YAML (architect → implement → verify → test → document)
- Claude Code as the execution backend for each agent node
- Pipeline status streaming to mobile
- Configurable stage prompts and gates

### Phase 6: Browser Testing & Polish (2-3 weeks)
- BROWSER TEST stage with Playwright MCP
- Screenshot capture and comparison
- Diff reviewer UI for code approval
- Approval gates (auto / review / ask-first)
- Menu bar status/badges
- App Store submission prep

---

## Technical Decisions

### Why Lima over Docker?
- Lima provides a full Linux VM, not just containerized processes
- Claude Code needs a real filesystem, real git, real shell — not a container
- Lima integrates with macOS seamlessly (shared mounts, port forwarding)
- Docker inside Lima is still possible if Claude needs containers

### Why not run Claude Code directly on the host?
- `--dangerously-skip-permissions` on the host is actually dangerous
- The VM is the safety boundary — Claude can `rm -rf /` and nothing happens
- Mount control gives fine-grained access management
- Easy rollback — snapshot the VM before risky tasks

### Why keep the agent orchestrator instead of pure proxy?
- Not everything needs Claude Code. Memory lookups, status checks, and simple questions save tokens.
- Multi-step workflows span tools that Claude Code can't coordinate alone (wait for CI, monitor health, notify phone).
- Rate limit resilience — orchestrator queues work when Claude is throttled.
- Fallback routing — cloud agent handles requests when desktop is offline.

### Why Sulla Cloud in the middle (not direct phone-to-desktop)?
- Phone can't reach desktop directly (NAT, firewall, mobile networks)
- Cloud provides reliable WebSocket relay and message persistence
- Offline resilience — messages queue in cloud until desktop is online
- Team routing — cloud decides which team member's desktop handles the request
