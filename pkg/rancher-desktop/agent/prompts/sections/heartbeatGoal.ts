/**
 * Heartbeat Goal Section — the install's north-star goal for Heartbeat.
 * Priority: 111 (directly after the frozen heartbeat contract)
 * Modes: full
 *
 * Only included when ctx.isHeartbeat is true.
 *
 * The heartbeat contract (id 'heartbeat') is frozen and ignores DB rows. This
 * section is the human-owned counterpart: the shipped default tells Heartbeat
 * to derive the right north star, and the human replaces it with their own
 * goal through the System Prompt settings (DB row 'heartbeat_goal'). The
 * builder applies that row over this default like any registered section.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export const HEARTBEAT_GOAL_DEFAULT_CONTENT = `## Heartbeat Goal — North Star

Your Human has not written a north-star goal for this install yet. Derive the right one: infer it from your Human's verified goals, commitments, and active Projects portfolio; state it in one sentence with a measurable success metric; and record it in Projects as the parent of your active goals. Your Human can replace this section with their own north star at any time, and theirs always wins.`;

export function buildHeartbeatGoalSection(ctx: PromptBuildContext): PromptSection | null {
  if (ctx.mode !== 'full') return null;
  if (!ctx.isHeartbeat) return null;

  return {
    id:             'heartbeat_goal',
    content:        HEARTBEAT_GOAL_DEFAULT_CONTENT,
    priority:       111,
    cacheStability: 'stable',
  };
}
