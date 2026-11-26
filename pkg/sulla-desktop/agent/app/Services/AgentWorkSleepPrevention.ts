// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { startCaffeinate, stopCaffeinate } from '@pkg/main/SleepPreventionService';

export const AGENT_WORK_CAFFEINATE_KEY = 'agent-work';

export interface CaffeinateHold {
  startCaffeinate(key: string): void;
  stopCaffeinate(key: string): void;
}

/** Holds sleep prevention only for work executing in this process, never a durable job status. */
export class AgentWorkSleepPrevention {
  private readonly chatRuns = new Set<string>();
  private readonly hiddenRunners = new Set<string>();
  private readonly cliChildren = new Set<string>();
  private held = false;

  constructor(
    private readonly caffeinate: CaffeinateHold,
    private readonly holdKey = AGENT_WORK_CAFFEINATE_KEY,
  ) {}

  chatRunStarted(key: string): void { this.begin(this.chatRuns, key) }
  chatRunEnded(key: string): void { this.end(this.chatRuns, key) }
  hiddenRunnerStarted(key: string): void { this.begin(this.hiddenRunners, key) }
  hiddenRunnerEnded(key: string): void { this.end(this.hiddenRunners, key) }
  cliChildStarted(key: string): void { this.begin(this.cliChildren, key) }
  cliChildEnded(key: string): void { this.end(this.cliChildren, key) }

  /** Reassert only process-local state after recovery; durable job statuses are not liveness. */
  async reconcileAfterRecovery(): Promise<void> { this.syncHold() }

  dispose(): void {
    this.chatRuns.clear(); this.hiddenRunners.clear(); this.cliChildren.clear();
    this.syncHold();
  }

  private begin(runs: Set<string>, key: string): void {
    if (!key || runs.has(key)) return;
    runs.add(key);
    this.syncHold();
  }

  private end(runs: Set<string>, key: string): void {
    if (!runs.delete(key)) return;
    this.syncHold();
  }

  private syncHold(): void {
    const shouldHold = this.chatRuns.size + this.hiddenRunners.size + this.cliChildren.size > 0;
    if (shouldHold === this.held) return;
    this.held = shouldHold;
    if (shouldHold) this.caffeinate.startCaffeinate(this.holdKey);
    else this.caffeinate.stopCaffeinate(this.holdKey);
  }
}

export const agentWorkSleepPrevention = new AgentWorkSleepPrevention({ startCaffeinate, stopCaffeinate });
