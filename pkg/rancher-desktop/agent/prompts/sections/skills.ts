/**
 * Skills Section — Mandatory skills scanning before replying.
 * Priority: 55
 * Modes: full
 *
 * NEW section — ensures the agent checks available skills before
 * reinventing functionality that already exists.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildSkillsSection(ctx: PromptBuildContext): PromptSection | null {
  if (ctx.mode !== 'full' && ctx.mode !== 'local') return null;

  const skillsIndex = ctx.templateVars['{{skills_index}}'] || '';
  if (!skillsIndex || skillsIndex.includes('No skills registered')) return null;

  if (ctx.mode === 'local') {
    return {
      id:             'skills',
      content:        ``,
      priority:       55,
      cacheStability: 'stable',
    };
  }

  const content = ``;

  return {
    id:             'skills',
    content,
    priority:       55,
    cacheStability: 'stable',
  };
}
