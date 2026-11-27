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
import { runTools, type ToolInFlight } from './RunToolTracker';
import { LONG_TOOL_CEILING_MS, describeHungTool, toolHoldsRunAlive } from './RunLivenessClock';

export type RunActivityAction = 'request_start' | 'tool_start' | 'tool_end';

export interface RunActivityChangeSource {
  onChange(listener: (keys: readonly string[]) => void): () => void;
  actionCount(key: string): number;
}

export interface RunActivityLease {
  acquire(key: string): void;
  release(key: string): void;
}

/** Shared live activity clock and cumulative per-task action counter. */
export class RunActivityTracker implements RunActivityChangeSource {
  private readonly lastActivity = new Map<string, number>();
  private readonly actionCounts = new Map<string, number>();
  private readonly listeners = new Set<(keys: readonly string[]) => void>();

  constructor(
    private readonly lease: RunActivityLease = { acquire: acquireChatActivity, release: releaseChatActivity },
    private readonly tools: Pick<typeof runTools, 'inFlight' | 'clearKey'> = runTools,
    private readonly clock: () => number = Date.now,
  ) {}

  begin(key: string): void {
    this.lastActivity.set(key, this.clock());
    this.actionCounts.set(key, 0);
    this.lease.acquire(`run:${ key }`);
    this.emit([key]);
  }

  /** Liveness only. In particular, provider token/thinking callbacks must not increment actionCount. */
  touch(metadata: any): void {
    const keys = this.keys(metadata);
    if (!keys.length) return;
    const now = this.clock();
    for (const key of keys) this.lastActivity.set(key, now);
    if (this.toolAction(metadata)) this.incrementTaskAction(keys);
    this.emit(keys);
  }

  /** Record one discrete request/tool boundary, never a streamed token or thinking delta. */
  recordAction(taskKey: string, _action: RunActivityAction): void {
    if (typeof taskKey !== 'string' || taskKey.length === 0) return;
    this.lastActivity.set(taskKey, this.clock());
    this.actionCounts.set(taskKey, (this.actionCounts.get(taskKey) ?? 0) + 1);
    this.emit([taskKey]);
  }

  actionCount(key: string): number { return this.actionCounts.get(key) ?? 0 }

  onChange(listener: (keys: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener) };
  }

  private emit(keys: readonly string[]): void {
    for (const listener of this.listeners) listener(keys);
  }

  private keys(metadata: any): string[] {
    const keys = metadata?.activityKeys;
    return Array.isArray(keys) ? [...new Set(keys.filter((key): key is string => typeof key === 'string' && key.length > 0))] : [];
  }

  /** Legacy touches may carry an explicit tool boundary; token/status touches never count. */
  private toolAction(metadata: any): 'tool_start' | 'tool_end' | undefined {
    const action = metadata?.activityAction ?? metadata?.activityKind ?? metadata?.actionKind ?? metadata?.kind ?? metadata?.phase;
    if (action === 'tool_start') return 'tool_start';
    if (action === 'tool_end' || action === 'tool_result') return 'tool_end';
    return undefined;
  }

  /** Inherited keys include manager scopes; only count the leaf task. */
  private incrementTaskAction(keys: readonly string[]): void {
    const taskKey = [...keys].reverse().find(key => /#\d+$/.test(key));
    for (const key of taskKey ? [taskKey] : keys) this.actionCounts.set(key, (this.actionCounts.get(key) ?? 0) + 1);
  }

  /** Keys a child graph should carry: its parent's plus any of its own. */
  inherit(parentMetadata: any, ...own: string[]): string[] {
    const inherited = Array.isArray(parentMetadata?.activityKeys) ? parentMetadata.activityKeys : [];
    return [...new Set([...inherited, ...own].filter((key): key is string => typeof key === 'string' && key.length > 0))];
  }

  lastActivityAt(key: string): number | undefined {
    return this.lastActivity.get(key);
  }

  /** The oldest tool call still running for this key (a long command emits nothing until it ends). */
  toolInFlight(key: string): ToolInFlight | undefined {
    return this.tools.inFlight(key);
  }

  end(key: string): void {
    this.lastActivity.delete(key);
    // Nothing the ended run started is still running; a stale entry would hold the key "busy".
    this.tools.clearKey(key);
    this.lease.release(`run:${ key }`);
    this.emit([key]);
  }
}

export const RunActivity = new RunActivityTracker();

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
  liveness: { createdAt: number; hasCheckin: () => Promise<boolean> } = { createdAt: Date.now(), hasCheckin: async() => false },
  policy = new AgentJobLivenessPolicy(),
): () => void {
  RunActivity.begin(key);
  let fired = false;
  const timer = setInterval(() => {
    void (async() => {
      if (fired) return;
      const minutes = await deadRunMinutes();
      const now = Date.now();
      // A tool still running (a long shell command emits nothing until it ends) is
      // activity, up to the ceiling; a wait on the human (approval, question) always is.
      const tool = RunActivity.toolInFlight(key);
      if (toolHoldsRunAlive(tool, now)) return;
      const clock = {
        createdAt: liveness.createdAt,
        startedAt: liveness.createdAt,
        lastActivityAt: RunActivity.lastActivityAt(key) ?? now,
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
