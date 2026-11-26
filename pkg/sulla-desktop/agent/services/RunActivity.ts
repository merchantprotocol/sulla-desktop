// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Last-activity clock for whole runs (a spawned job or workflow) including
 * every sub-agent they start. A graph state carries `metadata.activityKeys`;
 * each LLM token, thinking event and tool call touches every key, and child
 * states inherit their parent's keys. Status and telemetry can read this
 * activity without treating an elapsed-time threshold as proof of a dead run.
 */
import { acquireChatActivity, releaseChatActivity } from '@pkg/main/SleepPreventionService';
import { SuspendAwareClock } from './SuspendAwareClock';

const clock = new SuspendAwareClock();
const lastActivity = new Map<string, number>();

export const RunActivity = {
  begin(key: string): void {
    lastActivity.set(key, clock.now());
    acquireChatActivity(`run:${ key }`);
  },

  touch(metadata: any): void {
    const keys = metadata?.activityKeys;
    if (!Array.isArray(keys) || keys.length === 0) return;
    const now = clock.now();
    for (const key of keys) {
      if (typeof key === 'string') lastActivity.set(key, now);
    }
  },

  /** Keys a child graph should carry: its parent's plus any of its own. */
  inherit(parentMetadata: any, ...own: string[]): string[] {
    const inherited = Array.isArray(parentMetadata?.activityKeys) ? parentMetadata.activityKeys : [];
    return [...new Set([...inherited, ...own].filter((key): key is string => typeof key === 'string' && key.length > 0))];
  },

  lastActivityAt(key: string): number | undefined {
    const activityAt = lastActivity.get(key);
    return activityAt === undefined ? undefined : clock.toWallTime(activityAt);
  },

  end(key: string): void {
    lastActivity.delete(key);
    releaseChatActivity(`run:${ key }`);
  },
};
