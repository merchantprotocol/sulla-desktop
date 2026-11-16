// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Decides whether an output-less delegated wake can safely be retried later. */
export class DelegatedWakeSettlementPolicy {
  static readonly MAX_EMPTY_WAKES = 3;

  shouldPark(input: { liveChildren: number; pendingWait: boolean; consecutiveEmptyWakes: number }): boolean {
    return (input.liveChildren > 0 || input.pendingWait) && input.consecutiveEmptyWakes < DelegatedWakeSettlementPolicy.MAX_EMPTY_WAKES;
  }

  /**
   * What to do after a turn and its retry both produced nothing.
   * - park: a live child or pending wait will wake the task again (bounded).
   * - settle: nothing was waiting to be consumed, so hand the turn back to the
   *   ordinary settlement loop (contract reminder, then bounded auto-park).
   *   An empty reminder/ordinary turn must never kill the job outright.
   * - fail: undelivered child completions would otherwise be stranded, or
   *   the task has produced nothing MAX_EMPTY_WAKES times in a row.
   */
  emptyTurnAction(input: { liveChildren: number; pendingWait: boolean; consecutiveEmptyWakes: number; pendingCompletions: number }): 'park' | 'settle' | 'fail' {
    if (input.consecutiveEmptyWakes >= DelegatedWakeSettlementPolicy.MAX_EMPTY_WAKES) return 'fail';
    if (this.shouldPark(input)) return 'park';
    return input.pendingCompletions > 0 ? 'fail' : 'settle';
  }

  reason(liveChildren: number): string {
    return `empty wake turn; parked with ${ liveChildren } live children`;
  }

  isEmptyWakeReason(reason: string | undefined): boolean {
    return /^empty wake turn; parked with \d+ live children$/.test(reason ?? '');
  }

  completionUpdate(task: { emptyWakeCount?: number; waitReason?: string }): { emptyWakeCount: number; waitReason?: undefined } | undefined {
    if ((task.emptyWakeCount ?? 0) <= 0) return undefined;
    return {
      emptyWakeCount: 0,
      ...(this.isEmptyWakeReason(task.waitReason) ? { waitReason: undefined } : {}),
    };
  }
}
