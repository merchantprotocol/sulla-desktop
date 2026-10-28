// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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
    // Static content gated on isHeartbeat, which never changes within a
    // session — safe to cache with the stable prefix.
    cacheStability: 'stable',
  };
}
