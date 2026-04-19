/**
 * Heartbeat Section — Autonomous execution directive for the heartbeat agent.
 * Priority: 110
 * Modes: full
 *
 * Only included when ctx.isHeartbeat is true.
 * Migrated from prompts/heartbeat.ts.
 */
import { heartbeatPrompt } from '../heartbeat';

import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export function buildHeartbeatSection(ctx: PromptBuildContext): PromptSection | null {
  if (ctx.mode !== 'full') return null;
  if (!ctx.isHeartbeat) return null;

  return {
    id:             'heartbeat',
    content:        heartbeatPrompt,
    priority:       110,
    cacheStability: 'dynamic',
  };
}
