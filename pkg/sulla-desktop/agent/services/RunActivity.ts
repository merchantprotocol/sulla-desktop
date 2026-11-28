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
export interface RunActionSnapshot { kind: 'model' | 'tool'; label: string; at: string }
export interface RunActivityChangeSource {
  onChange(listener: (keys: readonly string[]) => void): () => void;
  actionCount(key: string): number;
  lastAction(key: string): RunActionSnapshot | null;
}
export interface RunActivityLease { acquire(key: string): void; release(key: string): void }

/** Shared live activity clock and cumulative per-task action counter. */
export class RunActivityTracker implements RunActivityChangeSource {
  private readonly lastActivity = new Map<string, number>();
  private readonly actionCounts = new Map<string, number>();
  private readonly lastActions = new Map<string, RunActionSnapshot>();
  private readonly listeners = new Set<(keys: readonly string[]) => void>();
  private readonly toolSteps = new Map<string, Map<string, string>>();
  private readonly completedToolSteps = new Map<string, Set<string>>();
  private readonly providerTurns = new Map<string, { codex: number; claude: number }>();

  constructor(
    private readonly lease: RunActivityLease = { acquire: acquireChatActivity, release: releaseChatActivity },
    private readonly tools: Pick<typeof runTools, 'inFlight' | 'clearKey'> = runTools,
    private readonly clock: () => number = Date.now,
  ) {}

  begin(key: string): void {
    this.lastActivity.set(key, this.clock());
    this.actionCounts.set(key, 0);
    this.lastActions.delete(key);
    this.toolSteps.delete(key);
    this.completedToolSteps.delete(key);
    this.providerTurns.delete(key);
    this.lease.acquire(`run:${ key }`);
    this.emit([key]);
  }

  /** Liveness only. Provider token/thinking callbacks are not discrete actions. */
  touch(metadata: any): void {
    const keys = this.keys(metadata);
    if (!keys.length) return;
    const now = this.clock();
    for (const key of keys) this.lastActivity.set(key, now);
    this.emit(keys);
  }

  /** Record one discrete provider request/tool boundary, never a streamed token or thinking delta. */
  recordAction(taskKey: string, action: RunActivityAction, label?: unknown, actionId?: string): void {
    if (typeof taskKey !== 'string' || taskKey.length === 0) return;
    const kind = action === 'request_start' ? 'model' : 'tool';
    const toolLabel = kind === 'model' ? 'model call' : RunActivityTracker.safeToolLabel(label);
    let resolvedLabel = toolLabel;
    if (kind === 'tool' && actionId) {
      const completed = this.completedToolSteps.get(taskKey);
      const open = this.toolSteps.get(taskKey);
      if (action === 'tool_start') {
        if (open?.has(actionId) || completed?.has(actionId)) return;
        let steps = open;
        if (!steps) this.toolSteps.set(taskKey, steps = new Map());
        steps.set(actionId, toolLabel);
      } else {
        if (completed?.has(actionId)) return;
        resolvedLabel = open?.get(actionId) ?? toolLabel;
        open?.delete(actionId);
        if (open && !open.size) this.toolSteps.delete(taskKey);
        let done = completed;
        if (!done) this.completedToolSteps.set(taskKey, done = new Set());
        done.add(actionId);
      }
    }
    const at = this.clock();
    this.lastActivity.set(taskKey, at);
    this.actionCounts.set(taskKey, (this.actionCounts.get(taskKey) ?? 0) + 1);
    this.lastActions.set(taskKey, { kind, label: resolvedLabel, at: new Date(at).toISOString() });
    this.emit([taskKey]);
  }

  /** Routes inherited activity keys to the leaf task represented by the row. */
  recordActionForMetadata(metadata: any, action: RunActivityAction, label?: unknown, actionId?: string): void {
    const taskKey = this.taskKey(metadata);
    if (taskKey) this.recordAction(taskKey, action, label, actionId);
  }

  /** Counts only provider event envelopes that represent request or tool boundaries. */
  recordProviderStreamEvent(metadata: any, event: any): void {
    if (!event || typeof event !== 'object') return;
    const taskKey = this.taskKey(metadata);
    if (!taskKey) return;
    if (event.type === 'turn.started') {
      this.beginProviderRequest(taskKey, 'codex');
      this.recordAction(taskKey, 'request_start');
    } else if (event.type === 'stream_event' && event.event?.type === 'message_start') {
      this.beginProviderRequest(taskKey, 'claude');
      this.recordAction(taskKey, 'request_start');
    }
    const item = event.item;
    if ((event.type === 'item.started' || event.type === 'item.completed') && item && typeof item === 'object') {
      const kind = item.item_type ?? item.type;
      if (['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(kind)) {
        const id = typeof item.id === 'string' ? item.id : typeof item.call_id === 'string' ? item.call_id : '';
        if (!id) return;
        const phase = event.type === 'item.started' ? 'tool_start' : 'tool_end';
        const toolName = kind === 'command_execution' ? 'shell'
          : kind === 'mcp_tool_call' ? this.providerMcpToolName(item)
            : kind;
        this.recordAction(taskKey, phase, toolName, `codex:${ this.providerRequestIndex(taskKey, 'codex') }:${ id }`);
      }
    }
    const nested = event.event;
    if (nested?.type === 'content_block_start' && nested.content_block?.type === 'tool_use') {
      const block = nested.content_block;
      if (typeof block.id === 'string') this.recordAction(taskKey, 'tool_start', block.name, `claude:${ this.providerRequestIndex(taskKey, 'claude') }:${ block.id }`);
    }
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) if (block?.type === 'tool_use' && typeof block.id === 'string') {
        this.recordAction(taskKey, 'tool_start', block.name, `claude:${ this.providerRequestIndex(taskKey, 'claude') }:${ block.id }`);
      }
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        this.recordAction(taskKey, 'tool_end', 'tool', `claude:${ this.providerRequestIndex(taskKey, 'claude') }:${ block.tool_use_id }`);
      }
    }
  }

  private providerMcpToolName(item: any): string {
    const tool = typeof item.tool === 'string' ? item.tool : 'tool';
    return typeof item.server === 'string' && /sulla/i.test(item.server) ? `sulla ${ tool }` : tool;
  }

  actionCount(key: string): number { return this.actionCounts.get(key) ?? 0 }
  lastAction(key: string): RunActionSnapshot | null { return this.lastActions.get(key) ?? null }

  onChange(listener: (keys: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener) };
  }

  private emit(keys: readonly string[]): void { for (const listener of this.listeners) listener(keys) }

  private keys(metadata: any): string[] {
    const keys = metadata?.activityKeys;
    return Array.isArray(keys) ? [...new Set(keys.filter((key): key is string => typeof key === 'string' && key.length > 0))] : [];
  }

  private taskKey(metadata: any): string | undefined {
    const keys = this.keys(metadata);
    return [...keys].reverse().find(key => /#\d+$/.test(key)) ?? keys[keys.length - 1];
  }

  private beginProviderRequest(taskKey: string, provider: 'codex' | 'claude'): void {
    const turns = this.providerTurns.get(taskKey) ?? { codex: 0, claude: 0 };
    turns[provider]++;
    this.providerTurns.set(taskKey, turns);
  }

  private providerRequestIndex(taskKey: string, provider: 'codex' | 'claude'): number {
    return this.providerTurns.get(taskKey)?.[provider] ?? 0;
  }

  /** Only the tool's identifier is retained; command arguments are never an activity label. */
  static safeToolLabel(value: unknown): string {
    if (typeof value !== 'string') return 'tool';
    const raw = value.trim();
    if (!raw) return 'tool';
    if (/^(bash|command_execution|shell|exec|run_command)$/i.test(raw)) return raw.toLowerCase() === 'bash' ? 'bash' : 'shell';
    if (raw.startsWith('sulla/') || raw.startsWith('sulla ')) {
      const name = raw.slice('sulla/'.length).trim().split(/\s+/)[0];
      const normalized = name.includes('_') ? `${ name.slice(0, name.indexOf('_')) }/${ name.slice(name.indexOf('_') + 1) }` : name;
      return `sulla ${ normalized }`.slice(0, 96);
    }
    if (raw.startsWith('mcp__')) {
      const separator = raw.lastIndexOf('__');
      const server = raw.slice(5, separator);
      const name = raw.slice(separator + 2).split(/\s+/)[0].replace(/^sulla[_-]/i, '');
      const normalized = name.includes('_') ? `${ name.slice(0, name.indexOf('_')) }/${ name.slice(name.indexOf('_') + 1) }` : name;
      return `${ /sulla/i.test(server) ? 'sulla' : server.replace(/[^\w.-]/g, '').slice(0, 48) || 'tool' } ${ normalized }`.slice(0, 96);
    }
    return /^[\w./-]{1,96}$/.test(raw) ? raw : 'tool';
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
    this.toolSteps.delete(key);
    this.completedToolSteps.delete(key);
    this.providerTurns.delete(key);
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
