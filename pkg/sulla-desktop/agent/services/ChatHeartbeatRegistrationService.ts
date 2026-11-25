// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ChatHeartbeatConfig, ChatHeartbeatStatus } from '@pkg/shared/chatHeartbeat';

import type { ChatHeartbeatJobTarget, ChatHeartbeatRegistration, ChatHeartbeatScheduler } from './ChatHeartbeatScheduler';

/** The delegated task, if any, that runs on a thread (jobs lookup by task thread). */
export interface ChatHeartbeatThreadTask {
  jobId:      string;
  taskIndex:  number;
  jobStatus:  string;
  taskStatus: string;
}

export interface ChatHeartbeatRegistrationPorts {
  taskForThread(threadId: string): Promise<ChatHeartbeatThreadTask | null>;
  persistJobHeartbeat(threadId: string): Promise<void>;
}

/**
 * The entry point for heartbeats set from outside the agent (composer, IPC). A renderer only
 * knows a thread id, so this resolves whether that thread is a delegated job task and, if so,
 * binds the job: its beats then take the parked-job wake path, the job minimum interval and a
 * durable record, exactly like a heartbeat the agent set for itself.
 */
export class ChatHeartbeatRegistrationService {
  private static readonly OPEN = ['running', 'parked'];

  constructor(
    private readonly scheduler: ChatHeartbeatScheduler,
    private readonly ports: ChatHeartbeatRegistrationPorts,
  ) {}

  async register(input: ChatHeartbeatRegistration): Promise<ChatHeartbeatStatus> {
    const target = input.jobId ? undefined : await this.unboundJobTarget(input.threadId);
    const status = this.scheduler.register({ ...input, ...(target ?? {}) });
    // Save only: a tab can re-register a stale "off" before startup recovery has restored the
    // job's own record, and that must not delete it.
    if (status.enabled && this.scheduler.jobTarget(input.threadId)) await this.persist(input.threadId);
    return status;
  }

  async configure(threadId: string, config: ChatHeartbeatConfig): Promise<ChatHeartbeatStatus | null> {
    if (!this.scheduler.has(threadId)) return null;
    const target = await this.unboundJobTarget(threadId);
    if (target) this.scheduler.bindJob(threadId, target);
    const status = this.scheduler.configure(threadId, config);
    if (this.scheduler.jobTarget(threadId)) await this.persist(threadId);
    return status;
  }

  updateBusy(threadId: string, busy: boolean): ChatHeartbeatStatus | null {
    return this.scheduler.updateBusy(threadId, busy);
  }

  unregisterFromUi(threadId: string): void {
    this.scheduler.unregisterFromUi(threadId);
  }

  /** The open job task behind a thread the scheduler has not bound to a job yet. */
  private async unboundJobTarget(threadId: string): Promise<ChatHeartbeatJobTarget | undefined> {
    if (this.scheduler.jobTarget(threadId)) return undefined;
    try {
      const task = await this.ports.taskForThread(threadId);
      if (!task || !ChatHeartbeatRegistrationService.OPEN.includes(task.jobStatus)
          || !ChatHeartbeatRegistrationService.OPEN.includes(task.taskStatus)) return undefined;
      return { jobId: task.jobId, taskIndex: task.taskIndex };
    } catch (error) {
      console.warn(`[ChatHeartbeat] could not resolve a job task for thread ${ threadId }:`, error);
      return undefined;
    }
  }

  private async persist(threadId: string): Promise<void> {
    try {
      await this.ports.persistJobHeartbeat(threadId);
    } catch (error) {
      console.warn(`[ChatHeartbeat] could not save the job heartbeat for thread ${ threadId }:`, error);
    }
  }
}
