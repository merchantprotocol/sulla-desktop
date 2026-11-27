/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * "Sulla" is a trademark. See TRADEMARK.md.
 */
import type { StatusRollupItem } from '../composer/StatusRollupQueue';
import type { ToolStepMetadata } from '../../models/Message';
import type { TraceRow } from './traceTypes';

type IntervalHandle = ReturnType<typeof setInterval>;
type ScheduleInterval = (callback: () => void, milliseconds: number) => IntervalHandle;
type CancelInterval = (handle: IntervalHandle) => void;
export type ToolStepTraceRow = TraceRow & { toolStep?: ToolStepMetadata };

interface ActiveStep {
  readonly item: StatusRollupItem;
  readonly sequence: number;
}

/** One view-scoped 1s clock shared by every running trace row and status line. */
export class ToolStepClock {
  private readonly listeners = new Set<(now: number) => void>();
  private readonly activeSteps = new Map<string, ActiveStep>();
  private interval: IntervalHandle | undefined;
  private sequence = 0;
  private currentTime: number;

  public constructor(
    private readonly now: () => number = Date.now,
    private readonly schedule: ScheduleInterval = (callback, milliseconds) => setInterval(callback, milliseconds),
    private readonly cancel: CancelInterval = handle => clearInterval(handle),
    private readonly intervalMs = 1_000,
  ) {
    this.currentTime = this.now();
  }

  get nowMs(): number { return this.currentTime; }

  /** Extracts only the frozen, persisted step contract; legacy string meta is ignored. */
  step(meta: unknown): ToolStepMetadata | undefined {
    if (!meta || typeof meta !== 'object') return undefined;
    const step = (meta as { step?: unknown }).step;
    if (!step || typeof step !== 'object') return undefined;
    const value = step as Partial<ToolStepMetadata>;
    const validEndedAt = value.endedAt === undefined || typeof value.endedAt === 'number' && Number.isFinite(value.endedAt);
    const validDuration = value.durationMs === undefined || typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0;
    const validResult = value.ok === undefined || typeof value.ok === 'boolean';
    return typeof value.stepId === 'string' && value.stepId.trim().length > 0 && typeof value.runId === 'string' && value.runId.trim().length > 0 &&
      ['codex', 'claude', 'api', 'native'].includes(value.provider ?? '') &&
      ['native', 'codex_cli', 'claude_cli', 'mcp'].includes(value.source ?? '') &&
      typeof value.safeLabel === 'string' && this.isSafeStepLabel(value.safeLabel.trim()) &&
      typeof value.startedAt === 'number' && Number.isFinite(value.startedAt) && validEndedAt && validDuration && validResult
      ? value as ToolStepMetadata : undefined;
  }

  /** Safe labels win; absent/legacy metadata falls back to the named tool, never its arguments. */
  safeLabel(meta: unknown, fallback: string): string {
    const stepLabel = this.step(meta)?.safeLabel.trim();
    if (stepLabel) return stepLabel;
    const label = fallback.trim();
    if (!label) return 'shell';
    return this.isSafeLegacyToolName(label) ? label : 'shell';
  }

  /** Uses persisted epoch timestamps; running durations advance only while subscribed. */
  elapsedMs(startedAt: number, endedAt?: number, now = this.nowMs): number {
    if (!Number.isFinite(startedAt)) return 0;
    const end = endedAt !== undefined && Number.isFinite(endedAt) ? endedAt : now;
    return Math.max(0, end - startedAt);
  }

  durationLabel(milliseconds: number): string {
    const duration = Math.max(0, milliseconds);
    if (duration < 1_000) return `${Math.round(duration)}ms`;
    const exactSeconds = duration / 1_000;
    if (exactSeconds < 60) return `${Number(exactSeconds.toFixed(1))}s`;
    const seconds = Math.floor(exactSeconds);
    const minutes = Math.floor(seconds / 60);
    return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
  }

  attachStep(row: TraceRow, step?: ToolStepMetadata): ToolStepTraceRow {
    return step ? { ...row, toolStep: step } : row;
  }

  /** Starts/results are correlated independently per root or worker, then the latest live start wins. */
  observe(items: readonly StatusRollupItem[]): void {
    const ordered = items.map((item, index) => ({ item, index }))
      .filter(({ item }) => item.phase && item.correlationId)
      .sort((left, right) => left.item.observedAt - right.item.observedAt ||
        (left.item.phase === 'start' ? 0 : 1) - (right.item.phase === 'start' ? 0 : 1) || left.index - right.index);
    for (const { item } of ordered) {
      const key = this.key(item);
      if (item.phase === 'start') this.activeSteps.set(key, { item, sequence: ++this.sequence });
      else this.activeSteps.delete(key);
    }
  }

  currentStep(threadId: string): StatusRollupItem | null {
    const latest = [...this.activeSteps.values()]
      .filter(step => step.item.threadId === threadId)
      .sort((left, right) => left.item.observedAt - right.item.observedAt || left.sequence - right.sequence)
      .at(-1);
    return latest?.item ?? null;
  }

  reset(): void { this.activeSteps.clear(); }

  /** All mounted rows in one chat share this single interval. */
  subscribe(listener: (now: number) => void): () => void {
    if (this.listeners.size === 0) this.currentTime = this.now();
    this.listeners.add(listener);
    listener(this.currentTime);
    if (this.interval === undefined) {
      this.interval = this.schedule(() => {
        this.currentTime = this.now();
        for (const update of this.listeners) update(this.currentTime);
      }, this.intervalMs);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.interval !== undefined) {
        this.cancel(this.interval);
        this.interval = undefined;
      }
    };
  }

  private key(item: StatusRollupItem): string {
    return `${item.threadId}:${item.agentId}:${item.correlationId}`;
  }

  /** Legacy fallbacks are tool names only; paths, URLs, and command snippets are never labels. */
  private isSafeStepLabel(label: string): boolean {
    return /^[A-Za-z][A-Za-z0-9_.+-]*$/.test(label) || /^[A-Za-z][A-Za-z0-9_-]*\/[A-Za-z0-9_-]+$/.test(label) ||
      /^sulla\s+[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/i.test(label);
  }

  private isSafeLegacyToolName(label: string): boolean {
    return /^[A-Za-z][A-Za-z0-9_-]*$/.test(label) || /^[A-Za-z][A-Za-z0-9_-]*\/[A-Za-z0-9_-]+$/.test(label) ||
      /^sulla\s+[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/i.test(label);
  }
}
