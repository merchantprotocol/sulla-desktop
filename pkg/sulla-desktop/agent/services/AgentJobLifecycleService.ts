// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentGraphState } from '../nodes/Graph';
import type { ChatMessage } from '../languagemodels/BaseLanguageModel';
import { injectSteer } from '../utils/steerChannel';
import { ReturnedTaskSettlement } from './ReturnedTaskSettlement';
import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import { deliverJobCompletion, returnedJobResult } from '../tools/agents/jobDelivery';
import { completeJob, getJob, parkJobTask, recordTaskCompletion, resumeParkedJob } from '../tools/agents/jobRegistry';

interface ParkedWaiter { resolve: () => void; }
export interface ChildDependencyCounter { openChildrenForThread(threadId: string): Promise<number>; }

/** Owns the running -> parked -> running lifecycle for hidden delegated managers. */
export class AgentJobLifecycleService {
  private readonly waiters = new Map<string, ParkedWaiter>();
  private readonly pendingWakes = new Map<string, number>();
  private static readonly PENDING_WAKE_TTL_MS = 5 * 60_000;
  private static readonly MAX_PENDING_WAKES = 1_000;

  constructor(
    private readonly children: ChildDependencyCounter,
    private readonly parkTask: (jobId: string, taskIndex: number, waitingOnChildren: number) => Promise<unknown>,
    private readonly resumeTask: (jobId: string, taskIndex: number) => Promise<unknown>,
    private readonly settleReturn: (jobId: string, taskIndex: number) => Promise<boolean> = () => Promise.resolve(false),
  ) {}

  private readonly runners = new Map<string, AgentGraphState>();

  registerRunner(threadId: string, state: AgentGraphState): () => void {
    if (this.runners.has(threadId)) throw new Error('Delegated thread already has a live runner');
    this.runners.set(threadId, state);
    return () => {
      if (this.runners.get(threadId) !== state) return;
      state.metadata.delegatedRunActive = false;
      this.runners.delete(threadId);
      this.pendingWakes.delete(threadId);
    };
  }

  async withRunner<T>(threadId: string, state: AgentGraphState, run: () => Promise<T>): Promise<T> {
    const release = this.registerRunner(threadId, state);
    try { return await run() } finally { release() }
  }

  liveState(threadId: string): AgentGraphState | undefined { return this.runners.get(threadId) }

  /** Lookup, deduplication, injection and release share a single JS turn. */
  deliver(threadId: string, message: ChatMessage): boolean {
    const state = this.liveState(threadId);
    if (!state) return false;
    const { wakeId, jobMessageId } = message.metadata ?? {};
    if (!state.messages.some(previous => (wakeId && wakeId === previous.metadata?.wakeId) ||
      (jobMessageId && jobMessageId === previous.metadata?.jobMessageId) || (message.id && message.id === previous.id))) {
      if (!injectSteer(state, message)) this.wake(threadId);
    }
    return true;
  }

  interruptRunners(): void {
    for (const state of this.runners.values()) {
      state.metadata.runtimeInterrupted = true;
      state.metadata.options?.abort?.abort();
    }
  }

  openChildren(threadId: string): Promise<number> {
    return this.children.openChildrenForThread(threadId);
  }

  async parkWhenWaiting(jobId: string, taskIndex: number, threadId: string): Promise<boolean> {
    const openChildren = await this.openChildren(threadId);
    if (openChildren === 0) return false;
    await this.parkTask(jobId, taskIndex, openChildren);
    return true;
  }

  /**
   * True while this exact process has a spawn_agent runner blocked in
   * waitForWake() for this thread — the manager is parked mid in-process
   * loop, not dormant. A completion/message for such a thread must be
   * injected into the live state and released with wake(), never re-entered
   * through a brand-new dispatchToAgent turn: that second, disconnected
   * execution would leave this exact Promise (and its own completeJob /
   * deliverJobCompletion once the loop returns) blocked forever.
   */
  hasLiveWaiter(threadId: string): boolean {
    return this.waiters.has(threadId);
  }

  async waitForWake(threadId: string, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    if (signal?.aborted) return;
    const queuedAt = this.pendingWakes.get(threadId);
    this.pendingWakes.delete(threadId);
    if (queuedAt && Date.now() - queuedAt <= AgentJobLifecycleService.PENDING_WAKE_TTL_MS) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(threadId);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      if (timeoutMs !== undefined) timer = setTimeout(finish, timeoutMs);
      this.waiters.set(threadId, { resolve: finish });
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  /** Returns true when a live parked runner accepted the wake. */
  wake(threadId: string): boolean {
    const waiter = this.waiters.get(threadId);
    if (!waiter) {
      const cutoff = Date.now() - AgentJobLifecycleService.PENDING_WAKE_TTL_MS;
      for (const [key, queuedAt] of this.pendingWakes) if (queuedAt < cutoff) this.pendingWakes.delete(key);
      if (this.pendingWakes.size >= AgentJobLifecycleService.MAX_PENDING_WAKES) this.pendingWakes.delete(this.pendingWakes.keys().next().value as string);
      this.pendingWakes.set(threadId, Date.now());
      return false;
    }
    waiter.resolve();
    return true;
  }

  async resume(jobId: string, taskIndex: number): Promise<void> {
    await this.resumeTask(jobId, taskIndex);
  }

  /**
   * A dormant parked job (no live waiter in this process — e.g. after a
   * restart) is truthfully 'running' for the duration of the dispatched
   * turn that wakes it. parkTask/resumeTask already guard on the job's
   * current status, so this is safe to call even if another path raced it.
   */
  async beginWakeTurn(jobId: string, taskIndex: number): Promise<void> {
    await this.resumeTask(jobId, taskIndex);
  }

  /** Re-park only if the woken turn ended without completing the job (still 'running'). */
  async endWakeTurn(jobId: string, taskIndex: number): Promise<void> {
    await this.parkTask(jobId, taskIndex, 0);
  }

  /**
   * End a dispatched wake turn of a dormant task (no spawn_agent runner owns
   * it any more). A return_result recorded during the turn is settled and
   * delivered here, because the runner that normally does so is gone;
   * re-parking it would strand the result on a task nothing will wake again.
   */
  async endDormantWakeTurn(jobId: string, taskIndex: number): Promise<void> {
    try {
      if (await this.settleReturn(jobId, taskIndex)) return;
    } catch (error) {
      // Parked with its return still recorded; the startup sweep settles it.
      console.warn(`[AgentJobLifecycle] Failed to settle returned task ${ jobId }#${ taskIndex } after its wake turn:`, error);
    }
    await this.parkTask(jobId, taskIndex, 0);
  }
}

// Explicit types: these two singletons reference each other, which TypeScript
// cannot infer through.
export const returnedTaskSettlement: ReturnedTaskSettlement = new ReturnedTaskSettlement({
  getJob,
  liveJobs:             () => agentJobProvider.states.refreshLive(),
  resultFor:            returnedJobResult,
  recordTaskCompletion,
  deliver:              deliverJobCompletion,
  completeJob,
  hasLiveRunner:        (threadId: string): boolean => !!agentJobLifecycle.liveState(threadId) || agentJobLifecycle.hasLiveWaiter(threadId),
});

export const agentJobLifecycle: AgentJobLifecycleService = new AgentJobLifecycleService(
  agentJobProvider.jobs,
  parkJobTask,
  resumeParkedJob,
  (jobId: string, taskIndex: number): Promise<boolean> => returnedTaskSettlement.settle(jobId, taskIndex),
);
