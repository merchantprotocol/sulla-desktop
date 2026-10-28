// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Tooling Section — Tool-first rule, capabilities, and tool usage guidance.
 * Priority: 40
 * Modes: full, minimal
 *
 * Migrated from AGENT_PROMPT_BASE in AgentNode.ts.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

/**
 * The short Files rules every agent needs on every turn. The detail (folder
 * metadata, versions, publishing, projects) arrives through memory recall as the
 * sulla-files, sulla-use-cases and sulla-projects subject pages.
 */
export const FILES_AND_PROJECTS = `## Files and projects

Sulla Files at \`/mnt/sulla-files\` is your Human's own versioned file system, not your workspace. Save only finished work they would open (deliverables, plans, decisions, project files) in the right existing folder; read its \`_folder-metadata.yaml\` first and update files in place, never \`-v2\`/\`-final\` copies. Never put scratch, logs or build output there, and never delete, move or rename their files unless asked. In the VM, \`/\`, \`/tmp\` and your home directory are RAM-backed: work in \`/mnt/worktrees/<repo>-<branch>\` and \`/mnt/worktrees/_scratch/<job id>/\`. Projects are \`Projects/<slug>/PROJECT.md\` + \`TASKS.md\`. Agents, skills, workflows, functions and recipes live under \`Use Cases/<type>/<slug>/\` as drafts until published with \`files_request_publish\` and approved by the human in Decide.`;

export function buildToolingSection(ctx: PromptBuildContext): PromptSection | null {
  const toolCategories = ctx.templateVars['{{tool_categories}}'] || '';

  if (ctx.mode === 'local') {
    const content = `## Tools

All integrations, MCP servers, and internal tools are callable through the \`sulla\` CLI. The system handles authentication — credentials are resolved from the encrypted vault and injected automatically.

\`\`\`bash
# Proxy call — authenticated API pass-through to any service
sulla <account_id>/<slug> '{"method":"GET","path":"/rest/companies"}'

# Internal tool — built-in tools organized by category
sulla <category>/<tool> '{"param":"value"}'

# MCP tool — Model Context Protocol servers
sulla <account_id>/mcp/<tool> '{"param":"value"}'
\`\`\`

Make parallel tool calls when possible.

${ FILES_AND_PROJECTS }`;

    return {
      id:             'tooling',
      content,
      priority:       40,
      cacheStability: 'stable',
    };
  }

  // Slim tool mode — only the minimal native set is pushed (browse_tools,
  // exec, read_file, write_file, ask_user_question); teach catalog
  // discovery instead of listing capabilities. Kept short on purpose.
  if (ctx.toolMode === 'slim') {
    const slimContent = `## Tools

You have a minimal native toolset: \`browse_tools\`, \`exec\`, \`read_file\`, \`write_file\`, \`ask_user_question\`. Every other capability (browser, docker, github, calendar, vault, slack, workflows, kubernetes, …) lives in the sulla CLI tool catalog.

**Workflow — always in this order:**
1. Discover: \`browse_tools({ category: "docker" })\` or \`browse_tools({ query: "send slack message" })\` — returns ready-to-run commands with parameter JSON
2. Invoke: \`exec({ command: "sulla <category>/<tool> '{\\"param\\":\\"value\\"}'" })\`

Integrations and MCP servers use the same pattern — auth is injected automatically from the vault:

\`\`\`bash
sulla <account_id>/<slug> '{"method":"GET","path":"/rest/companies"}'   # proxy call
sulla <account_id>/mcp/<tool> '{"param":"value"}'                       # MCP tool
\`\`\`

**Rules:**
- ❌ NEVER invent tool names or sulla commands — browse_tools first when unsure
- ❌ NEVER use \`execute_workflow\` for CLI commands — it only runs named Sulla workflows
- Use \`ask_user_question\` whenever you need a real answer from the user — to pick between options, confirm an assumption, or get a yes/no go-ahead before a risky or destructive action outside the VM (offer Approve / Deny options). It renders an interactive card and BLOCKS until they answer. Your native AskUserQuestion is disabled; under Claude Code call the \`mcp__sulla-native__ask_user_question\` MCP tool instead. Never just ask in plain text when you need a real answer.

Make parallel tool calls when possible.

${ FILES_AND_PROJECTS }`;

    return {
      id:             'tooling',
      content:        slimContent,
      priority:       40,
      cacheStability: 'stable',
    };
  }

  const content = `## Tools

All integrations, MCP servers, and internal tools are callable through the \`sulla\` CLI. The system handles authentication — credentials are resolved from the encrypted vault and injected automatically.

\`\`\`bash
# Proxy call — authenticated API pass-through to any service
sulla <account_id>/<slug> '{"method":"GET","path":"/rest/companies"}'

# Internal tool — built-in tools organized by category
sulla <category>/<tool> '{"param":"value"}'

# MCP tool — Model Context Protocol servers
sulla <account_id>/mcp/<tool> '{"param":"value"}'
\`\`\`

**CRITICAL — tool dispatch rule:**
- ✅ ALWAYS use \`exec({ command: "sulla <category>/<tool> '...'" })\` to run CLI tools
- ❌ NEVER use \`execute_workflow\` for CLI tools — it only handles named Sulla workflows and will always fail otherwise

Make parallel tool calls when possible.

${ FILES_AND_PROJECTS }

## Tool rules

- Sulla tools beat generic ones. Your memory's \`skills.md\` and \`tool-*\` subject pages show the exact commands for the job in front of you.
- Recurring or scheduled work becomes a Sulla Workflow (\`sulla workflow/import_workflow\`), never cron, launchd or CronCreate.
- Git pushes and GitHub calls go through \`sulla github/*\` (auth is injected); never SSH or raw curl with a token.
- Ask real questions with \`ask_user_question\` (under Claude Code: the \`mcp__sulla-native__ask_user_question\` MCP tool), never in plain text.
- Use \`exec\` in the VM for everyday work. \`sulla meta/exechost\` is only for things that truly need the host machine, and never \`applescript\` with \`target_app: "Terminal"\`.`;

  return {
    id:             'tooling',
    content,
    priority:       40,
    cacheStability: 'stable',
  };
}
