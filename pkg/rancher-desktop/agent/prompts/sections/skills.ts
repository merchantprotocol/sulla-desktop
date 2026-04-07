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
      content:        `## Skills\nCheck these before acting. If one matches, use \`load_skill\` first.\n${ skillsIndex }`,
      priority:       55,
      cacheStability: 'stable',
    };
  }

  const content = `## Skills (mandatory scan)

Before replying to a user request, scan the available skills below. If a matching skill exists, load it with \`load_skill\` and follow its instructions before proceeding with your own approach.

### Available Skills
${ skillsIndex }`;

  return {
    id:             'skills',
    content,
    priority:       55,
    cacheStability: 'stable',
  };
}
