/**
 * Workspace Section — Sulla Home directory tree and session start instructions.
 * Priority: 60
 * Modes: full, minimal
 *
 * Migrated from AGENT_PROMPT_BASE in AgentNode.ts.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildWorkspaceSection(ctx: PromptBuildContext): PromptSection | null {
  const sullaHome = ctx.templateVars['{{sulla_home}}'] || '~/sulla';

  if (ctx.mode === 'local') {
    const content = `## Environment
You run inside an isolated Lima VM. Commands via \`exec\` execute in this sandbox.

Sulla Home: ${ sullaHome }/
Key dirs: resources/ (defaults), skills/, workflows/, agents/, integrations/, identity/ (human/business/agent goals), projects/, logs/

Use \`file_search\` to find skills/workflows. Use \`load_skill\` to load instructions.

Session start — read these before acting:
1. \`~/sulla/integrations/environment/tools-api-reference.md\` — tool reference
2. \`~/sulla/integrations/environment/agent.md\` — agent principles
3. \`~/sulla/identity/human/identity.md\` — who you work for
4. \`~/sulla/projects/ACTIVE_PROJECTS.md\` — current projects`;

    return {
      id:             'workspace',
      content,
      priority:       60,
      cacheStability: 'stable',
    };
  }

  const content = `## Environment

You run inside an isolated Lima VM. You do NOT have access to the host machine. All commands via the \`exec\` tool execute inside this sandbox — destructive operations are safe and do not require confirmation.

### Sulla Home — ${ sullaHome }/

\`\`\`
${ sullaHome }/
├── resources/                  # Ships with Sulla — curated defaults
│   ├── skills/                 # Default skill instructions (SKILL.md)
│   ├── workflows/              # Default workflow definitions (YAML)
│   ├── agents/                 # Default agent configs
│   └── integrations/           # Default integration docs
├── skills/                     # Installation-specific skills
├── workflows/                  # Installation-specific workflows
├── agents/                     # Installation-specific agent configs
├── integrations/               # Installation-specific integration configs & auth
├── identity/                   # Persistent identity & goals
│   ├── human/                  # {identity.md, goals.md}
│   ├── business/               # {identity.md, goals.md}
│   ├── world/                  # {identity.md, goals.md}
│   └── agent/                  # {identity.md, goals.md}
├── projects/                   # Project workspaces and PRDs
├── logs/                       # Execution logs and change logs
├── conversations/              # Conversation history
└── workspaces/                 # Isolated workspaces for tasks
\`\`\`

Use \`file_search\` to find relevant skills, workflows, or integration docs. Use \`load_skill\` to load full skill instructions.

### Session Start — Import context when needed

At the start of every session, read the following files in order before doing anything else:

1. \`read_file\` → \`~/sulla/integrations/environment/tools-api-reference.md\` — full tool category list, call format, and examples
2. \`read_file\` → \`~/sulla/integrations/environment/environment-overview.md\` — Sulla Desktop architecture, what runs where (host vs. Lima VM), directory layout
3. \`read_file\` → \`~/sulla/integrations/environment/agent.md\` — core agent principles, communication rules, completion wrappers
4. \`read_file\` → \`~/sulla/identity/human/identity.md\` — who you are working for, their operating model and priorities
5. \`read_file\` → \`~/sulla/identity/business/identity.md\` — business model, revenue structure, active deadlines
6. \`read_file\` → \`~/sulla/identity/human/goals.md\` — 13-week arc, financial targets, operating rules
7. \`read_file\` → \`~/sulla/projects/ACTIVE_PROJECTS.md\` — current active projects and blockers
8. \`read_file\` → \`~/sulla/identity/business_priorities.md\` — real-time priority status

Do not guess tool names, assume project context, or proceed without reading these first.`;

  return {
    id:             'workspace',
    content,
    priority:       60,
    cacheStability: 'stable',
  };
}
