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

export interface RunActivityClock {
  now(): number;
  toWallTime(logicalTime: number): number;
}

export interface RunActivityHold {
  acquireChatActivity(key: string): void;
  releaseChatActivity(key: string): void;
}

/** Owns app-activity holds and liveness timestamps for in-process run lifetimes. */
export class RunActivityService {
  private readonly lastActivity = new Map<string, number>();
  private readonly activeRuns = new Map<string, number>();

  constructor(
    private readonly clock: RunActivityClock,
    private readonly hold: RunActivityHold,
  ) {}

  begin(key: string): void {
    if (!key) return;
    const activeCount = this.activeRuns.get(key) ?? 0;
    this.activeRuns.set(key, activeCount + 1);
    this.lastActivity.set(key, this.clock.now());
    if (activeCount === 0) this.hold.acquireChatActivity(`run:${ key }`);
  }

  touch(metadata: any): void {
    const keys = metadata?.activityKeys;
    if (!Array.isArray(keys) || keys.length === 0) return;
    const now = this.clock.now();
    for (const key of keys) {
      if (typeof key === 'string' && this.activeRuns.has(key)) this.lastActivity.set(key, now);
    }
  }

  /** Keys a child graph should carry: its parent's plus any of its own. */
  inherit(parentMetadata: any, ...own: string[]): string[] {
    const inherited = Array.isArray(parentMetadata?.activityKeys) ? parentMetadata.activityKeys : [];
    return [...new Set([...inherited, ...own].filter((key): key is string => typeof key === 'string' && key.length > 0))];
  }

  lastActivityAt(key: string): number | undefined {
    const activityAt = this.lastActivity.get(key);
    return activityAt === undefined ? undefined : this.clock.toWallTime(activityAt);
  }

  end(key: string): void {
    const activeCount = this.activeRuns.get(key);
    if (activeCount === undefined) return;
    if (activeCount > 1) {
      this.activeRuns.set(key, activeCount - 1);
      return;
    }
    this.activeRuns.delete(key);
    this.lastActivity.delete(key);
    this.hold.releaseChatActivity(`run:${ key }`);
  }
}

class SleepPreventionRunActivityHold implements RunActivityHold {
  acquireChatActivity(key: string): void { acquireChatActivity(key) }
  releaseChatActivity(key: string): void { releaseChatActivity(key) }
}

export const RunActivity = new RunActivityService(new SuspendAwareClock(), new SleepPreventionRunActivityHold());
