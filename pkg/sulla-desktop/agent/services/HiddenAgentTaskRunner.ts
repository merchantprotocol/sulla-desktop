// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobResult, AgentJobTask } from '../tools/agents/jobRegistry';
import { agentWorkSleepPrevention, type AgentWorkSleepPrevention } from '../app/Services/AgentWorkSleepPrevention';
import { RunActivity, type RunActivityService } from './RunActivity';

export interface ReopenableTaskRun {
  task: AgentJobTask;
  taskIndex: number;
  threadId: string;
  generation: number;
  activityKeys?: string[];
}

export interface ReopenableTaskRunner {
  run(input: ReopenableTaskRun): Promise<AgentJobResult>;
}

export interface HiddenTaskExecution {
  execute(input: ReopenableTaskRun): Promise<AgentJobResult>;
}

/** Stable runner boundary shared by initial launches now and reopened generations in PR B. */
export class HiddenAgentTaskRunner implements ReopenableTaskRunner {
  constructor(
    private readonly execution: HiddenTaskExecution,
    private readonly workActivity: Pick<AgentWorkSleepPrevention, 'hiddenRunnerStarted' | 'hiddenRunnerEnded'> = agentWorkSleepPrevention,
    private readonly runActivity: Pick<RunActivityService, 'begin' | 'end'> = RunActivity,
  ) {}

  async run(input: ReopenableTaskRun): Promise<AgentJobResult> {
    if (!input.threadId) throw new Error('Hidden task execution requires a persisted threadId.');
    if (!Number.isInteger(input.generation) || input.generation < 1) throw new Error('Hidden task generation must be a positive integer.');
    const runKey = `hidden:${ input.threadId }`;
    const activityKeys = [...new Set([runKey, ...(input.activityKeys ?? [])])];
    const begunActivityKeys: string[] = [];
    let workActivityStarted = false;
    try {
      this.workActivity.hiddenRunnerStarted(runKey);
      workActivityStarted = true;
      for (const key of activityKeys) {
        this.runActivity.begin(key);
        begunActivityKeys.push(key);
      }
      return await this.execution.execute(input);
    } finally {
      try {
        for (const key of begunActivityKeys.reverse()) this.runActivity.end(key);
      } finally {
        if (workActivityStarted) this.workActivity.hiddenRunnerEnded(runKey);
      }
    }
  }
}
