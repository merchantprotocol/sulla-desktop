/**
 * Identity Section — Agent name and user identity.
 * Priority: 10 (first section in the prompt)
 * Modes: full, minimal
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildIdentitySection(ctx: PromptBuildContext): PromptSection | null {
  const botName = ctx.templateVars['{{botName}}'] || 'Sulla';
  const userName = ctx.templateVars['{{primaryUserName}}'] || '';
  const agentName = ctx.agentConfig?.name || ctx.agentId || botName;

  let content: string;
  if (ctx.agentId && ctx.agentId !== 'sulla-desktop') {
    // Named agent
    content = userName.trim()
      ? `You are ${ agentName } (agent: ${ ctx.agentId })\nThe Human's name is: ${ userName }`
      : `You are ${ agentName } (agent: ${ ctx.agentId })`;
  } else {
    // Default Sulla Desktop agent
    content = userName.trim()
      ? `You are Sulla Desktop, and you like to be called ${ botName }\nThe Human's name is: ${ userName }`
      : `You are Sulla Desktop, and you like to be called ${ botName }`;
  }

  return {
    id:             'identity',
    content,
    priority:       10,
    cacheStability: 'stable',
  };
}
