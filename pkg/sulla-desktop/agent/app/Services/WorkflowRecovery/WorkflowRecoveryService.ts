// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';

export interface SuspendedExecution {
  executionId: string; workflowId: string; workflowName: string; workflowSlug: string;
  startedAt: string; autoRestart: boolean;
}
export interface WorkflowExecutionStore {
  findStaleExecutions(): Promise<any[]>; findSuspended(): Promise<any[]>;
  recover(executionId: string): Promise<any>; suspendAllRunning(): Promise<string[]>;
  nextLeaseExpiry(): Promise<Date | null>;
}
export interface WorkflowRecoveryRegistry { activate(execution: SuspendedExecution): Promise<void>; }
export interface WorkflowRecoveryNotifier { notify(execution: SuspendedExecution): Promise<void>; }
export interface RecoveryClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  defer(callback: () => void): void;
}
export type WorkflowRecoveryStatus = 'stopped' | 'starting' | 'running' | 'stopping';
const STALE_RECHECK_MS = 30_000;

export class WorkflowRecoveryService extends Service {
  private pending: SuspendedExecution[] = [];
  private readonly notified = new Set<string>();
  private readonly activationScheduled = new Set<string>();
  private recoveryInFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: WorkflowRecoveryStatus = 'stopped';

  constructor(
    private readonly executions: WorkflowExecutionStore,
    private readonly registry: WorkflowRecoveryRegistry,
    private readonly clock: RecoveryClock,
    private readonly notifier: WorkflowRecoveryNotifier,
  ) { super(); }

  status(): WorkflowRecoveryStatus { return this.state; }

  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') return;
    this.state = 'starting';
    await this.recover();
    this.state = 'running';
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') return;
    this.state = 'stopping';
    if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = null; }
    await this.gracefulShutdown();
    this.state = 'stopped';
  }

  async gracefulShutdown(): Promise<void> { await this.executions.suspendAllRunning(); }

  async recover(): Promise<void> {
    if (this.recoveryInFlight) return this.recoveryInFlight;

    this.recoveryInFlight = this.runRecovery();
    try {
      await this.recoveryInFlight;
    } finally {
      this.recoveryInFlight = null;
    }
  }

  private async runRecovery(): Promise<void> {
    try {
      const recovered: SuspendedExecution[] = [];
      for (const candidate of await this.executions.findStaleExecutions()) {
        const result = await this.executions.recover(candidate.attributes.execution_id);
        if (result) recovered.push(this.map(result.execution.attributes));
      }
      const suspended = (await this.executions.findSuspended()).map(row => this.map(row.attributes));
      const all = [...recovered, ...suspended];
      const automatic = all.filter(entry => entry.autoRestart && !this.activationScheduled.has(entry.executionId));
      const manual = all.filter(entry => !entry.autoRestart);
      this.pending = manual;
      if (automatic.length) {
        for (const execution of automatic) this.activationScheduled.add(execution.executionId);
        this.clock.defer(() => { void this.activate(automatic); });
      }
      for (const execution of manual) {
        if (this.notified.has(execution.executionId)) continue;
        this.notified.add(execution.executionId);
        await this.notifier.notify(execution);
      }
      await this.scheduleNextLeaseRecovery();
    } catch (error) {
      console.error('[WorkflowRecovery] recoverOnBoot failed:', error);
    }
  }

  takePending(): SuspendedExecution[] { const value = [...this.pending]; this.pending = []; return value; }

  private map(attributes: any): SuspendedExecution {
    return {
      executionId: attributes.execution_id,
      workflowId: attributes.workflow_id,
      workflowName: attributes.workflow_name || attributes.workflow_id,
      workflowSlug: attributes.workflow_slug || attributes.workflow_id,
      startedAt: attributes.started_at instanceof Date ? attributes.started_at.toISOString() : String(attributes.started_at),
      autoRestart: attributes.auto_restart !== false,
    };
  }

  private async activate(executions: SuspendedExecution[]): Promise<void> {
    for (const execution of executions) {
      try { await this.registry.activate(execution); }
      catch (error) {
        console.error(`[WorkflowRecovery] Auto-restart error for "${ execution.executionId }":`, error);
      } finally {
        this.activationScheduled.delete(execution.executionId);
      }
    }
  }

  private async scheduleNextLeaseRecovery(): Promise<void> {
    const next = await this.executions.nextLeaseExpiry();
    if (!next) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    const untilExpiry = next.getTime() - this.clock.now();
    const delay = untilExpiry <= 0 ? STALE_RECHECK_MS : Math.max(1_000, untilExpiry + 250);
    this.timer = this.clock.setTimeout(() => { this.timer = null; void this.recover(); }, delay);
    (this.timer as any).unref?.();
  }
}
