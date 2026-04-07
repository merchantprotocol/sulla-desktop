/**
 * Agent Prompt Section — Agent-specific .md files from config directory.
 * Priority: 90
 * Modes: full, minimal
 *
 * Loads non-section-override .md files from ~/sulla/agents/{agentId}/
 * and injects them as a single section. Files matching registered section
 * IDs are handled as overrides by the builder, not here.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildAgentPromptSection(ctx: PromptBuildContext): PromptSection | null {
  // The agent prompt content is loaded by loadAgentPromptFiles() and split
  // into section overrides vs generic prompt content. The generic prompt
  // content (non-override files) is passed via agentConfig.prompt.
  const agentPrompt = ctx.agentConfig?.prompt;
  if (!agentPrompt || !agentPrompt.trim()) return null;

  return {
    id:             'agent_prompt',
    content:        agentPrompt.trim(),
    priority:       90,
    cacheStability: 'stable',
  };
}
