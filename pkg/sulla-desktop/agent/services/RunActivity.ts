// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Last-activity clock for whole runs (a spawned job or workflow) including
 * every sub-agent they start. A graph state carries `metadata.activityKeys`;
 * each LLM token, thinking event and tool call touches every key, and child
 * states inherit their parent's keys. Dead-run detection reads this instead
 * of a lease timer, which keeps renewing whether or not the agent does work.
 */
import { acquireChatActivity, releaseChatActivity } from '@pkg/main/SleepPreventionService';
import { AgentJobLivenessPolicy } from './AgentJobLivenessPolicy';
import { RunToolTracker, type ToolInFlight } from './RunToolTracker';
import { SuspendAwareClock } from './SuspendAwareClock';
import { LONG_TOOL_CEILING_MS, describeHungTool, toolHoldsRunAlive } from './RunLivenessClock';

const clock = new SuspendAwareClock();
const runTools = new RunToolTracker(() => clock.now());
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

  /** The oldest tool call still running for this key (a long command emits nothing until it ends). */
  toolInFlight(key: string): ToolInFlight | undefined {
    const tool = runTools.inFlight(key);
    return tool ? { ...tool, startedAt: clock.toWallTime(tool.startedAt) } : undefined;
  },

  end(key: string): void {
    lastActivity.delete(key);
    // Nothing the ended run started is still running; a stale entry would hold the key "busy".
    runTools.clearKey(key);
    releaseChatActivity(`run:${ key }`);
  },
};

export const DEAD_RUN_CHECK_MS = 60_000;
/** After a dead run is aborted, how long to wait for it to return before letting go. */
export const DEAD_RUN_GRACE_MS = 180_000;
const DEFAULT_DEAD_RUN_MINUTES = 30;

/** Minutes of tree-wide silence before a run counts as dead (legacy setting key taskDispatcherDeadRunMinutes, kept so saved values still apply). */
export async function deadRunMinutes(): Promise<number> {
  const { SullaSettingsModel } = await import('../database/models/SullaSettingsModel');
  const value = Number(await SullaSettingsModel.get('taskDispatcherDeadRunMinutes', DEFAULT_DEAD_RUN_MINUTES));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_DEAD_RUN_MINUTES;
}

export type DeadRunKind = 'idle' | 'tool_hung';

/**
 * Watch a run's activity clock and call `onDead` once its WHOLE loop has been
 * silent past the dead-run threshold: no model output, no tool start or
 * result, no check-in or message, and no tool still running. A tool running
 * past LONG_TOOL_CEILING_MS stops protecting the run and is reported as
 * `tool_hung` ("tool still running for Xm: <name>"), not as an idle agent.
 * Returns a stop function that also clears the clock.
 */
export function watchForDeadRun(
  key: string,
  onDead: (reason: string, kind: DeadRunKind) => void | Promise<void>,
  stillAlive: () => Promise<boolean> = async() => false,
  liveness: { createdAt: number; hasCheckin: () => Promise<boolean> } = { createdAt: clock.now(), hasCheckin: async() => false },
  policy = new AgentJobLivenessPolicy(),
): () => void {
  RunActivity.begin(key);
  let fired = false;
  const timer = setInterval(() => {
    void (async() => {
      if (fired) return;
      const minutes = await deadRunMinutes();
      const now = clock.now();
      // A tool still running (a long shell command emits nothing until it ends) is
      // activity, up to the ceiling; a wait on the human (approval, question) always is.
      const tool = runTools.inFlight(key);
      if (toolHoldsRunAlive(tool, now)) return;
      const clock = {
        createdAt: liveness.createdAt,
        startedAt: liveness.createdAt,
        lastActivityAt: lastActivity.get(key) ?? now,
        now,
      };
      if (!policy.isStalled({ ...clock, hasCheckin: await liveness.hasCheckin(), stallMs: minutes * 60_000 })) return;
      if (await stillAlive()) return;
      fired = true;
      const idleMinutes = Math.floor(policy.idleMs(clock) / 60_000);
      if (tool) {
        await onDead(`${ describeHungTool(tool, now) } (tool ceiling ${ Math.round(LONG_TOOL_CEILING_MS / 60_000) }m), no other agent activity for ${ idleMinutes } minute(s)`, 'tool_hung');
        return;
      }
      await onDead(`no agent activity for ${ idleMinutes } minute(s) (limit ${ minutes })`, 'idle');
    })().catch(err => console.warn(`[RunActivity] dead-run check failed for ${ key }:`, err));
  }, DEAD_RUN_CHECK_MS);
  return () => {
    clearInterval(timer);
    RunActivity.end(key);
  };
}
