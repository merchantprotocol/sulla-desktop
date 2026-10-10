/**
 * Agent Prompt Section — Agent-specific prompt content from Postgres.
 * Priority: 90
 * Modes: full, minimal
 *
 * Injects the generic prompt content persisted with an agent definition.
 * Registered section IDs remain separate builder overrides.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildAgentPromptSection(ctx: PromptBuildContext): PromptSection | null {
  // The database loader splits registered section overrides from generic
  // prompt content and passes the latter via agentConfig.prompt.
  const agentPrompt = ctx.agentConfig?.prompt;
  if (!agentPrompt?.trim()) return null;

  return {
    id:             'agent_prompt',
    content:        agentPrompt.trim(),
    priority:       90,
    cacheStability: 'stable',
  };
}
