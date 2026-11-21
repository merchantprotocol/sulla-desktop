// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { CompletionKey } from '../app/Services/CompletionKey';
import { DeferredStallInput } from '../app/Services/DeferredStallInput';
import type { PendingCompletion } from './AgentCompletionInbox';
import { DelegatedTurnProgressProbe } from './DelegatedTurnProgressProbe';
import { DelegatedWakeSettlementPolicy } from './DelegatedWakeSettlementPolicy';

/** Collaborators a delegated task supplies so the turn loop stays testable. */
export interface DelegatedFreshTurnPorts {
  readonly jobId?:    string;
  readonly taskIndex: number;
  readonly threadId:  string;
  readonly state:     any;
  readonly signal?:   AbortSignal;
  prepare(state: any): void;
  execute(): Promise<any>;
  returnedTask(): Promise<any>;
  getJob(jobId: string): Promise<any>;
  openChildren(threadId: string): Promise<number>;
  pendingWait(jobId: string, taskIndex: number): Promise<unknown>;
  updateJobTask(jobId: string, taskIndex: number, patch: Record<string, unknown>): Promise<unknown>;
  endWakeTurn(jobId: string, taskIndex: number): Promise<unknown>;
  waitForWake(threadId: string, signal?: AbortSignal): Promise<unknown>;
  resume(jobId: string, taskIndex: number): Promise<unknown>;
  rerouteCompletions(manager: any, taskIndex: number, reason: string, entries: any[]): Promise<unknown>;
  acknowledgeCompletions(entries: PendingCompletion[]): Promise<unknown>;
}

export interface DelegatedFreshTurnResult { finalState: any; returned: any }

/**
 * Runs one delegated turn after a wake, reminder or resume, retrying once when
 * the turn did nothing. Only real output (a non-blank token, a tool call or
 * an appended reply, see DelegatedTurnProgressProbe) is progress. A
 * truly empty turn parks while something can wake it, hands back to the
 * settlement loop when nothing was waiting to be consumed, and fails only when
 * child completions would be stranded or the empty-turn bound is exceeded.
 */
export class DelegatedFreshTurnRunner {
  constructor(
    private readonly ports: DelegatedFreshTurnPorts,
    private readonly policy = new DelegatedWakeSettlementPolicy(),
  ) {}

  async run(currentState: any): Promise<DelegatedFreshTurnResult> {
    const { ports } = this;
    const { state, jobId, taskIndex } = ports;
    const wakeInput = state.messages[state.messages.length - 1];
    const progress = new DelegatedTurnProgressProbe(state);
    currentState = await this.executeOnce();
    let returned = await ports.returnedTask();
    if (!returned && !progress.madeProgress()) {
      currentState = await this.executeOnce();
      returned = await ports.returnedTask();
      if (!returned && !progress.madeProgress()) return this.settleEmptyTurn(currentState, wakeInput);
    }
    if (jobId && (returned || progress.madeProgress())) {
      const currentTask = (await ports.getJob(jobId))?.tasks[taskIndex];
      const completionUpdate = currentTask && this.policy.completionUpdate(currentTask);
      if (completionUpdate) await ports.updateJobTask(jobId, taskIndex, completionUpdate);
    }
    const entries = this.completionEntries(wakeInput).filter(entry => CompletionKey.isTaskCompletion(entry));
    if (entries.length) await ports.acknowledgeCompletions(entries);
    return { finalState: currentState, returned };
  }

  private async executeOnce(): Promise<any> {
    this.ports.prepare(this.ports.state);
    return await this.ports.execute();
  }

  private completionEntries(wakeInput: any): PendingCompletion[] {
    const entries = wakeInput?.metadata?.completionEntries;
    return Array.isArray(entries) ? entries : [];
  }

  private async settleEmptyTurn(currentState: any, wakeInput: any): Promise<DelegatedFreshTurnResult> {
    const { ports } = this;
    const { jobId, taskIndex, threadId } = ports;
    const entries = this.completionEntries(wakeInput);
    const completionEntries = entries.filter(entry => !CompletionKey.isStall(entry));
    const advisoryOnly = Boolean(DeferredStallInput.read(wakeInput))
      || (entries.length > 0 && completionEntries.length === 0);
    if (!jobId) {
      // No agent job row (direct/legacy run): nothing can park it, count its
      // empty turns or own child completions, so hand the turn back to the
      // caller's settlement loop, which reminds and then auto-parks with its
      // own bound. Completions stay unacknowledged for that loop to retry.
      return { finalState: currentState, returned: undefined };
    }
    if (advisoryOnly) return { finalState: currentState, returned: undefined };
    const job = await ports.getJob(jobId);
    const liveChildren = await ports.openChildren(threadId);
    const pendingWait = Boolean(await ports.pendingWait(jobId, taskIndex));
    const emptyWakeCount = (job?.tasks[taskIndex]?.emptyWakeCount ?? 0) + 1;
    const action = this.policy.emptyTurnAction({ liveChildren, pendingWait, consecutiveEmptyWakes: emptyWakeCount, pendingCompletions: completionEntries.length });
    if (action === 'park') {
      await ports.updateJobTask(jobId, taskIndex, { emptyWakeCount, waitReason: this.policy.reason(liveChildren) });
      await ports.endWakeTurn(jobId, taskIndex);
      await ports.waitForWake(threadId, ports.signal);
      if (ports.signal?.aborted) return { finalState: currentState, returned: undefined };
      await ports.resume(jobId, taskIndex);
      // A wake (child completion, job message) is injected into this live
      // state.messages before wake() releases waitForWake (see
      // AgentJobLifecycleService.hasLiveWaiter), so the next
      // run() reads that as its wake input. If the wake added nothing, run()
      // re-reads this same unacknowledged input, so its completions are still
      // acknowledged on progress or rerouted on failure; never dropped.
      return await this.run(currentState);
    }
    if (action === 'settle') {
      // Nothing was waiting to be consumed (a contract reminder, resume nudge
      // or message turn). The caller's settlement loop reminds/auto-parks with
      // its own bound; counting here bounds repeated truly-empty turns.
      await ports.updateJobTask(jobId, taskIndex, { emptyWakeCount });
      return { finalState: currentState, returned: undefined };
    }
    const wakeReason = String(wakeInput?.metadata?.source || 'unknown_wake');
    const completionIds = completionEntries.map((entry: any) => entry?.jobId).filter(Boolean).join(',') || 'none';
    const failureReason = `Delegated wake turn produced no assistant output after retry: job=${ jobId }, wake=${ wakeReason }, unconsumedCompletionJobs=${ completionIds }`;
    if (completionEntries.length && job) await ports.rerouteCompletions(job, taskIndex, failureReason, completionEntries);
    throw new Error(failureReason);
  }
}
