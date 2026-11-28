// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentStateRow, AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';
import { AgentTreeBuilder, type AgentTreeNode } from '@pkg/services/agentState/AgentTreeBuilder';

export interface ThreadAgentActivitySnapshotSink {
  publish(snapshot: AgentStateSnapshot, now: number): void;
  /** Advance time-dependent popup details without rebuilding unchanged agent rows. */
  tick?(now: number): void;
}

/** Coalesces working snapshots to one per second and keeps clock-only ticks off the row views. */
export class ThreadAgentActivitySnapshotScheduler {
  private latestSnapshot: AgentStateSnapshot;
  private activeThreadId?: string;
  private initialized = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private publishedRows: readonly AgentStateRow[] = [];

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
    const working = rows.some(row => row.state === 'working');

    if (working) {
      if (threadChanged || this.timer === null) this.publish(rows, true);
      if (this.timer === null) this.timer = setInterval(this.publish, this.intervalMs);
      return;
    }

    this.stop();
    if (threadChanged || this.rowsChanged(rows)) this.publish(rows, true);
  }

  dispose(): void { this.stop() }

  private publish = (rows = this.rowsForThread(this.latestSnapshot, this.activeThreadId), force = false): void => {
    const now = this.now();
    if (force || this.rowsChanged(rows)) {
      this.publishedRows = rows;
      this.sink.publish(this.latestSnapshot, now);
      return;
    }
    this.sink.tick?.(now);
  };

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
