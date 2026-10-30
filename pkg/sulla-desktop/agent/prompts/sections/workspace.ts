// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Workspace Section — where the agent runs, host access, and Sulla Home.
 * Priority: 60
 * Modes: full, minimal, local
 *
 * Sulla's deeper knowledge about itself ships as the memory seed pack in
 * `resources/memory-seed` and reaches agents through memory recall and the
 * `sulla memory/*` tools (see the tooling section).
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildWorkspaceSection(ctx: PromptBuildContext): PromptSection | null {
  const sullaHome = ctx.templateVars['{{sulla_home}}'] || '~/sulla';

  if (ctx.mode === 'local') {
    const content = `## Environment
You run inside the isolated Sulla VM on the Sulla runtime. Commands via \`exec\` execute in this sandbox. Use \`sulla meta/exechost\` only when the host machine itself is required.

Sulla Home: ${ sullaHome }/
Sulla's knowledge about itself lives in memory: read the recalled pages and use \`sulla memory/episodic_recall\` when you need more.`;

    return {
      id:             'workspace',
      content,
      priority:       60,
      cacheStability: 'stable',
    };
  }

  const content = `## Environment

You run inside the isolated Sulla VM on the Sulla runtime (Sulla's own macOS virtual machine). All commands via the \`exec\` tool execute inside this sandbox, and destructive work inside the VM is safe.

### Host Machine Access (exechost tool) — LAST RESORT ONLY

**Default to the VM.** Everyday shell work, file search/read/write, package installs, git, builds, tests, and sulla CLI calls stay inside the Sulla VM via the regular \`exec\` tool. Keep work inside the VM to protect the human's machine.

Use \`sulla meta/exechost\` **only** when the host MUST be used, for example:
- Host-only binaries or paths the VM cannot see (macOS app bundles under \`/Applications\`, GUI apps)
- Host-only daemons that are not available inside the Sulla VM
- User-installed host tools that are not in the VM and cannot be installed there
- An explicit user request to run something on the host machine

Do **not** use \`exechost\` for routine searching, editing, compiling, testing, or exploratory commands.

When host access is enabled (Preferences → Application → Administrative Access → "Allow access to the host machine"):
- \`exechost\` runs **silently** — no Terminal window opens, and output comes back inline.
- It uses the user's login shell, so the full PATH (Homebrew, nvm, rbenv, etc.) is available.
- If host access is disabled, \`exechost\` returns a clear error telling the user how to enable it.
- **Never use \`applescript_execute\` with \`target_app: "Terminal"\`** for host commands — it pops Terminal windows.

### Disk

- \`/mnt/worktrees\` holds code (\`/mnt/worktrees/<repo>-<branch>\`) and kept scratch (\`/mnt/worktrees/_scratch/<job id>/\`).
- \`/mnt/sulla-files\` is your Human's Sulla Files. \`/mnt/data\` is the VM's data disk.
- \`/tmp\` is on disk and fine for throwaway files.
- The VM's root filesystem and home directory don't survive a restart; never leave work there.

### Sulla Home — ${ sullaHome }/

\`\`\`
${ sullaHome }/
├── skills/        # Installation-specific skills
├── workflows/     # Installation-specific workflows
├── agents/        # Installation-specific agent configs
├── functions/     # Custom functions (run via sulla function/function_run)
├── routines/      # Routine templates (workflow source)
├── recipes/       # Installed recipes
├── projects/      # Historical workspace (projects now live in Sulla Files: Projects/)
├── workspaces/    # Isolated workspaces for tasks
└── resources/     # Bundled skills, agents, workflows and integrations
\`\`\`

Agents, skills, workflows, functions and recipes you author go in Sulla Files under \`Use Cases/<type>/<slug>/\`; see "Files and projects".

### Where Sulla's knowledge lives

What Sulla knows about itself (the VM, Files, tools, agents, workflows, features and its own source repository) lives in the memory database. \`sulla.md\`, \`project-<subject>.md\` and \`skills.md\` pages arrive with each turn; read them before acting, and search for more with the \`sulla memory/*\` tools. Find any tool with \`sulla meta/browse_tools '{"query":"..."}'\`, and never guess a tool name. If memory and live behavior disagree, trust what you verify and correct the memory.`;

  return {
    id:             'workspace',
    content,
    priority:       60,
    cacheStability: 'stable',
  };
}
