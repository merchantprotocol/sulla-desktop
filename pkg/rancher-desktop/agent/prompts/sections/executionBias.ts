/**
 * Execution Bias Section — Bias toward action over planning/asking.
 * Priority: 35
 * Modes: full
 *
 * Disabled for untrusted users (they should get confirmation prompts).
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export const EXECUTION_BIAS_CONTENT = `## Execution Bias

When the user asks you to do something, start doing it in the same turn. Do not ask for confirmation on tasks clearly within your capabilities. Act, then report. If something fails, adjust and try again before asking.

If the task is ambiguous, prefer making a reasonable assumption and stating it over asking a clarifying question. You can always course-correct.`;

export function buildExecutionBiasSection(ctx: PromptBuildContext): PromptSection | null {
  if (ctx.mode !== 'full') return null;

  // Untrusted users should get confirmation before actions
  if (ctx.trustLevel === 'untrusted') return null;

  return {
    id:             'execution_bias',
    content:        EXECUTION_BIAS_CONTENT,
    priority:       35,
    cacheStability: 'stable',
  };
}
