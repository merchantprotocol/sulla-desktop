/**
 * Workspace Section — Sulla Home directory tree and session start instructions.
 * Priority: 60
 * Modes: full, minimal
 *
 * Points the agent at the bundled `sulla-docs/` (canonical tool + environment
 * reference) instead of the older `~/sulla/resources/environment/` layout.
 * `{{sulla_docs}}` resolves to the absolute path of the shipped docs at
 * runtime (packaged app bundle or dev checkout) — see resolveSullaDocsDir().
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildWorkspaceSection(ctx: PromptBuildContext): PromptSection | null {
  const sullaHome = ctx.templateVars['{{sulla_home}}'] || '~/sulla';
  const sullaDocs = ctx.templateVars['{{sulla_docs}}'] || '';

  if (ctx.mode === 'local') {
    const content = `## Environment
You run inside an isolated Lima VM. Commands via \`exec\` execute in this sandbox.

Sulla Home: ${ sullaHome }/
Key dirs: skills/, workflows/, agents/, integrations/, identity/ (human/business/agent goals), projects/, logs/

**Agent + tool docs (canonical reference):** ${ sullaDocs }/
Start by reading \`${ sullaDocs }/INDEX.md\` — it lists what to load next and maps every subsystem to the right doc.`;

    return {
      id:             'workspace',
      content,
      priority:       60,
      cacheStability: 'stable',
    };
  }

  const content = `## Environment

You run inside an isolated Lima VM. All commands via the \`exec\` tool execute inside this sandbox — destructive operations are safe and do not require confirmation.

### Sulla Home — ${ sullaHome }/

\`\`\`
${ sullaHome }/
├── skills/                     # Installation-specific skills
├── workflows/                  # Installation-specific workflows
├── agents/                     # Installation-specific agent configs
├── integrations/               # Installation-specific integration configs & auth
├── functions/                  # Custom functions (run via sulla function/function_run)
├── routines/                   # Routine templates (workflow source)
├── identity/                   # Persistent identity & goals
│   ├── human/                  # {identity.md, goals.md}
│   ├── business/               # {identity.md, goals.md}
│   ├── world/                  # {identity.md, goals.md}
│   └── agent/                  # {identity.md, goals.md}
├── projects/                   # Project workspaces and PRDs
├── logs/                       # Execution logs (playbook-debug.log, etc.)
├── conversations/              # Conversation history
├── captures/                   # Capture Studio recordings
└── workspaces/                 # Isolated workspaces for tasks
\`\`\`

### Agent + tool docs — ${ sullaDocs }/

The canonical reference for every tool, subsystem, and common user request. Ships with Sulla Desktop (bundled in the app; resolves to the packaged path at runtime or the dev checkout).

**Read \`${ sullaDocs }/INDEX.md\` first.** It lists what to load next on session start and maps every topic to the right doc.

Core subdirectories:

\`\`\`
${ sullaDocs }/
├── INDEX.md                            # ⭐ Start here. Maps every topic to a doc.
├── tools/
│   ├── inventory.md                    # ⭐ Every tool, every category (verified live)
│   ├── overview.md                     # Invocation pattern, anti-patterns
│   ├── meta.md                         # exec, file_search, read/write_file, spawn_agent, execute_workflow
│   ├── browser.md                      # 23 browser tools — tabs, DOM, screenshots, JS
│   ├── github.md                       # git + GitHub API (25 tools)
│   ├── pg.md                           # Postgres queries + all 18 tables + write safety
│   ├── redis.md                        # KV / hashes / lists
│   ├── vault.md                        # Credentials, LLM access levels, autofill
│   ├── calendar.md                     # Local calendar; no GCal sync
│   ├── notify.md                       # notify_user + presence detection
│   ├── slack.md                        # Messaging, user search, threads
│   ├── agents.md                       # spawn_agent (under meta/) + check_agent_jobs
│   ├── n8n.md                          # Separate workflow engine (may not be installed)
│   ├── applescript.md                  # macOS app automation (per-app allowlist)
│   └── computer-use.md                 # What's shipped vs what's planned
├── workflows/
│   ├── authoring.md                    # ⭐ Build / validate / debug / schedule / restart
│   ├── schema.md                       # YAML structure, template syntax
│   ├── node-types.md                   # Every node subtype
│   └── examples.md                     # Working patterns
├── functions/
│   ├── authoring.md                    # ⭐ Build, run, debug, edit custom functions
│   ├── schema.md                       # function.yaml spec
│   ├── runtimes.md                     # Python / Node / Shell handlers
│   └── examples.md                     # Working code
├── environment/
│   ├── architecture.md                 # Electron main, Lima VM, ports, channels
│   ├── docker.md                       # Host Docker vs Lima-internal services (they DIFFER)
│   ├── kubernetes.md                   # k3s + kubectl_* / rdctl_* tools
│   └── heartbeat.md                    # Autonomous heartbeat agent
├── agent-patterns/
│   ├── user-stories.md                 # ⭐ Common request → step-by-step plan
│   ├── known-gaps.md                   # What you CAN'T do today — don't fake it
│   ├── writing-voice.md                # ✍️ Required reading before writing prose for a human
│   ├── orchestrator.md                 # Completion wrappers, orchestratorInstructions
│   ├── context-passing.md              # Template resolution, merge output
│   └── channels.md                     # Inter-agent messaging
├── cloud/overview.md                   # Sulla Cloud positioning + pricing
├── mobile/overview.md                  # Sulla Mobile (iOS AI receptionist)
├── marketplace/overview.md             # Recipes + extension management
├── desktop/
│   ├── capture-studio.md               # Multi-track recorder
│   └── secretary-mode.md               # Live meeting transcription (Cmd+Shift+S)
├── identity/
│   ├── structure.md                    # ~/sulla/identity/ layout
│   └── icp.md                          # Ideal customer profile, framing
└── verification-2026-04-23.md          # What was live-verified, what was wrong, what got fixed
\`\`\`

Do not guess tool names or invent documentation. If a doc says a tool or feature exists, trust it. If you see something not documented, verify with \`sulla meta/browse_tools '{"query":"..."}'\` before using it, and if confirmed, update the doc.`;

  return {
    id:             'workspace',
    content,
    priority:       60,
    cacheStability: 'stable',
  };
}
