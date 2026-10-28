---
slug: sulla-change-sulla-source
label: Change Sulla Desktop source safely
trigger_when: When you need to add or modify a Sulla Desktop tool, migration, seeder, prompt section, or built-in agent or skill.
trigger_actions: [add a tool, add a migration, add a seeder, add a prompt section, add a built-in agent, change Sulla source]
trigger_phrases: [change Sulla source, add a Sulla tool, migration, seeder, prompt section, built-in agent]
scope: [sulla-repository, sulla-repo-agent-runtime]
---

**When:** You are changing repository source, especially agent runtime wiring.

**Do:**
1. Read `AGENTS.md`, `CLAUDE.md`, the target code, and the nearest tests. Give new files the license header the files around them use (GPL-2.0-or-later SPDX header in Desktop code, the Fair-Code header in the Sulla Server directories) and follow existing conventions.
2. For a tool, add implementation and manifest under `pkg/sulla-desktop/agent/tools/<category>/`, then register the category or manifest where the existing registry requires it. Verify the live catalog with `sulla meta/browse_tools '{"category":"<category>"}'`.
3. For a migration, add the next numbered file under `pkg/sulla-desktop/agent/database/migrations/` and register it through the migration index. Make it forward-safe and reversible where the existing migration pattern supports that.
4. For a seeder, add it under `pkg/sulla-desktop/agent/database/seeders/`, register it in the seeder index, and make repeated runs safe.
5. For a prompt section, add the section under `pkg/sulla-desktop/agent/prompts/sections/` and wire it through the section index or builder. Keep always-on prompt content small.
6. For a built-in agent or skill, update the matching JSON under `agent/builtinAgents` or `agent/builtinSkills` and the adjacent seeder code.
7. Put tests in the nearest `__tests__` directory or alongside the package's established test files. Run the repository's approved Yarn checks only when the task permits them.
8. Review `git diff`, check for secrets and generated files, commit with the repository's required co-author line, push the branch, and open the PR required by the task.

**Don't:**
- Use npm, edit another worktree, or remove source or third-party license headers.
- Add a manifest entry without an implementation or add a migration/seeder without its index registration.
