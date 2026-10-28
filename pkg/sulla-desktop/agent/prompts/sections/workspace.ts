// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Workspace Section — the short environment stub.
 * Priority: 60
 * Modes: full, minimal, local
 *
 * Sulla's knowledge about itself (the VM, Files, tools, agents, workflows,
 * features and its own source repository) ships as the memory seed pack in
 * `resources/memory-seed` and reaches agents through v7 memory recall. This
 * section only says where the agent is and where that knowledge arrives.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildWorkspaceSection(ctx: PromptBuildContext): PromptSection | null {
  if (ctx.subconsciousRecallMode === 'v7') return null;

  const sullaHome = ctx.templateVars['{{sulla_home}}'] || '~/sulla';

  const content = `## Environment

You run inside the isolated Sulla VM. The \`exec\` tool runs commands there, and destructive work inside the VM is safe. Use \`sulla meta/exechost\` only when the host machine itself is required (a host-only app, path or daemon), never for routine work. Sulla Home: ${ sullaHome }/

What Sulla knows about itself (the VM, Files, tools, agents, workflows, features and its own source repository) arrives through your memory each turn: \`sulla.md\` holds the core rules, \`project-<subject>.md\` pages explain each part, and \`skills.md\` gives exact steps for the job in front of you. Read them before acting. Find any tool with \`sulla meta/browse_tools '{"query":"..."}'\`, and never guess a tool name.`;

  return {
    id:             'workspace',
    content,
    priority:       60,
    cacheStability: 'stable',
  };
}
