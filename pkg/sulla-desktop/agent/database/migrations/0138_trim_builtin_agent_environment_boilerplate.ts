// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Remove the exact legacy Projects/Files paragraph from shipped agent rows.
 * The replacement is intentionally exact and idempotent; role-specific text
 * and human-authored variants are untouched. The regular built-in seeder then
 * refreshes every otherwise-untouched row to the current bundled prompt.
 */
const LEGACY_PROJECTS = `

Projects live in Sulla Files under \`Projects/<project-slug>/\`. Each project folder has PROJECT.md (goal, status, owner agent, links) and TASKS.md (a markdown checklist: \`- [ ] task — owner — note\`; tick \`- [x]\` when done). Put plans, specs and notes in that folder too. Read and edit them with the Files tools (files_where, files_get, files_put); search projects with Files search. Create a new project folder only when the work is a real multi-session goal and no existing project fits. Never keep a separate task list anywhere else.`;

const columns = ['description', 'system_prompt', 'prompt_content', 'soul_content', 'goals_content', 'returns'];

export const up = columns.map(column => `
  UPDATE agent_definitions
     SET ${ column } = replace(${ column }, ${ quote(LEGACY_PROJECTS) }, '')
   WHERE is_builtin = TRUE
     AND ${ column } LIKE '%' || ${ quote('Projects live in Sulla Files') } || '%';
`).join('\n');

// Prompt slimming cannot reconstruct the removed duplicate safely. The bundle
// and subject-memory seed are the source of truth after this one-way cleanup.
export const down = '';

function quote(value: string): string {
  return `$prompt_trim$${ value }$prompt_trim$`;
}
