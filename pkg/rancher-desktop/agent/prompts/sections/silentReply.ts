/**
 * Silent Reply Section — [SILENT] token for housekeeping turns.
 * Priority: 120
 * Modes: full
 *
 * NEW section — allows agents to skip visible output for housekeeping cycles.
 * Enabled for heartbeat and sub-agent modes.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export const SILENT_REPLY_CONTENT = `## Silent Replies

If you have nothing meaningful to report for a housekeeping cycle (no progress, no blockers, no new information), respond with exactly \`[SILENT]\`. The system will suppress this from the user's view.

Use [SILENT] sparingly — only when there is genuinely nothing to communicate.`;

export function buildSilentReplySection(ctx: PromptBuildContext): PromptSection | null {
  if (ctx.mode !== 'full') return null;

  // Only for heartbeat and sub-agents
  if (!ctx.isHeartbeat && !ctx.isSubAgent) return null;

  return {
    id:             'silent_reply',
    content:        SILENT_REPLY_CONTENT,
    priority:       120,
    cacheStability: 'dynamic',
  };
}
