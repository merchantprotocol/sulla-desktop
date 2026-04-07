/**
 * Narration Policy Section — When and how to narrate tool call results.
 * Priority: 45
 * Modes: full
 *
 * Replaces the verbose "after every tool call, briefly say what you found"
 * directive from the old AGENT_PROMPT_DIRECTIVE.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export const NARRATION_POLICY_CONTENT = `## Tool Result Narration

After tool calls, narrate results concisely to preserve context across conversation cycles. Your future self reads this to know what happened.

- Keep narration to one sentence per tool result.
- Focus on what was found, not what you did: "Config at /path — db host is localhost:5432" not "I used read_file to read the config file."
- Skip narration for routine reads that produced expected results.
- Always narrate when: the result changes your plan, reveals something unexpected, or produced an error.`;

export function buildNarrationPolicySection(ctx: PromptBuildContext): PromptSection | null {
  if (ctx.mode !== 'full') return null;

  return {
    id:             'narration_policy',
    content:        NARRATION_POLICY_CONTENT,
    priority:       45,
    cacheStability: 'stable',
  };
}
