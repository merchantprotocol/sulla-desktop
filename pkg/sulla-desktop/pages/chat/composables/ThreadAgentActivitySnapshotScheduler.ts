// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentStateRow, AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';
import { AgentTreeBuilder, type AgentTreeNode } from '@pkg/services/agentState/AgentTreeBuilder';

export interface ThreadAgentActivitySnapshotSink {
  publish(snapshot: AgentStateSnapshot, now: number): void;
  /** Advance time-dependent popup details without rebuilding unchanged agent rows. */
  tick?(now: number): void;
  /** Emit the next queued action blip for each agent in this shared scheduler tick. */
  actionBlips?(agentKeys: readonly string[]): void;
}

/** Coalesces working snapshots and drains action blips through one shared timer. */
export class ThreadAgentActivitySnapshotScheduler {
  private static readonly actionBlipIntervalMs = 100;
  private latestSnapshot: AgentStateSnapshot;
  private activeThreadId?: string;
  private initialized = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private publishedRows: readonly AgentStateRow[] = [];
  private lastPublishedAt: number | null = null;
  private readonly lastActionCounts = new Map<string, number>();
  private readonly pendingActionBlips = new Map<string, number>();

  constructor(
    initialSnapshot: AgentStateSnapshot,
    private readonly sink: ThreadAgentActivitySnapshotSink,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 1_000,
  ) {
    this.latestSnapshot = initialSnapshot;
  }

  observe(snapshot: AgentStateSnapshot, threadId: string | undefined): void {
    const threadChanged = !this.initialized || this.activeThreadId !== threadId;
    this.initialized = true;
    this.activeThreadId = threadId;
    this.latestSnapshot = snapshot;

    const rows = this.rowsForThread(snapshot, threadId);
    this.collectActionDeltas(rows, threadChanged);
    const working = rows.some(row => row.state === 'working');

    if (working) {
      if (threadChanged || this.timer === null) this.publish(rows, true);
      this.start();
      return;
    }

    if (threadChanged || this.rowsChanged(rows)) this.publish(rows, true);
    if (this.pendingActionBlips.size) this.start();
    else this.stop();
  }

  dispose(): void { this.stop() }

  private publish(rows: readonly AgentStateRow[], force = false): void {
    const now = this.now();
    if (force || this.rowsChanged(rows)) {
      this.publishedRows = rows;
      this.lastPublishedAt = now;
      this.sink.publish(this.latestSnapshot, now);
      return;
    }
    this.sink.tick?.(now);
    this.lastPublishedAt = now;
  }

  private onTimer = (): void => {
    this.drainActionBlips();
    const rows = this.rowsForThread(this.latestSnapshot, this.activeThreadId);
    const working = rows.some(row => row.state === 'working');
    const now = this.now();
    if (working && (this.lastPublishedAt === null || now - this.lastPublishedAt >= this.intervalMs)) {
      this.publish(rows);
    }
    if (!working && !this.pendingActionBlips.size) this.stop();
  };

  private collectActionDeltas(rows: readonly AgentStateRow[], reset: boolean): void {
    const currentKeys = new Set<string>();
    for (const row of rows) {
      currentKeys.add(row.key);
      const count = row.actionCount;
      if (count === undefined) {
        this.lastActionCounts.delete(row.key);
        continue;
      }
      const previous = this.lastActionCounts.get(row.key);
      if (!reset && previous !== undefined && count > previous) {
        this.pendingActionBlips.set(row.key, (this.pendingActionBlips.get(row.key) ?? 0) + count - previous);
      }
      this.lastActionCounts.set(row.key, count);
    }
    for (const key of this.lastActionCounts.keys()) {
      if (!currentKeys.has(key)) {
        this.lastActionCounts.delete(key);
        this.pendingActionBlips.delete(key);
      }
    }
  }

  private drainActionBlips(): void {
    if (!this.pendingActionBlips.size) return;
    const agentKeys: string[] = [];
    for (const [key, pending] of this.pendingActionBlips) {
      agentKeys.push(key);
      if (pending <= 1) this.pendingActionBlips.delete(key);
      else this.pendingActionBlips.set(key, pending - 1);
    }
    this.sink.actionBlips?.(agentKeys);
  }

  private start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(this.onTimer, Math.min(this.intervalMs, ThreadAgentActivitySnapshotScheduler.actionBlipIntervalMs));
  }

  private rowsChanged(rows: readonly AgentStateRow[]): boolean {
    if (rows.length !== this.publishedRows.length) return true;
    for (let index = 0; index < rows.length; index++) {
      if (!this.sameValue(rows[index], this.publishedRows[index])) return true;
    }
    return false;
  }

  private sameValue(left: unknown, right: unknown, pairs = new WeakMap<object, WeakSet<object>>()): boolean {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;

    const paired = pairs.get(left) ?? new WeakSet<object>();
    if (paired.has(right)) return true;
    paired.add(right);
    pairs.set(left, paired);

    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return leftKeys.length === rightKeys.length && leftKeys.every(key =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) && this.sameValue(leftRecord[key], rightRecord[key], pairs));
  }

  private rowsForThread(snapshot: AgentStateSnapshot, threadId: string | undefined): AgentStateRow[] {
    if (!threadId) return [];
    const builder = new AgentTreeBuilder(snapshot.rows);
    const rootRows = snapshot.rows.filter(row => row.rootThreadId === threadId);
    if (rootRows.length) return builder.flatten(builder.forThread(threadId)).map(node => node.row);

    const matches = snapshot.rows.filter(row => row.threadId === threadId && row.rootThreadId !== null);
    const rootIds = [...new Set(matches.map(row => row.rootThreadId!))];
    if (rootIds.length !== 1 || !matches.length) return [];

    const matchingKeys = new Set(matches.map(row => row.key));
    const rows: AgentStateRow[] = [];
    const collect = (node: AgentTreeNode, inMatchedSubtree = false): void => {
      const include = inMatchedSubtree || matchingKeys.has(node.row.key);
      if (include) rows.push(node.row);
      for (const child of node.children) collect(child, include);
    };
    for (const node of builder.forThread(rootIds[0])) collect(node);
    return rows;
  }

  private stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
