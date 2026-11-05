// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobResult, AgentJobTask } from '../tools/agents/jobRegistry';

export interface ReopenableTaskRun {
  task: AgentJobTask;
  taskIndex: number;
  threadId: string;
  generation: number;
}

export interface ReopenableTaskRunner {
  run(input: ReopenableTaskRun): Promise<AgentJobResult>;
}

export interface HiddenTaskExecution {
  execute(input: ReopenableTaskRun): Promise<AgentJobResult>;
}

/** Stable runner boundary shared by initial launches now and reopened generations in PR B. */
export class HiddenAgentTaskRunner implements ReopenableTaskRunner {
  constructor(private readonly execution: HiddenTaskExecution) {}

  async run(input: ReopenableTaskRun): Promise<AgentJobResult> {
    if (!input.threadId) throw new Error('Hidden task execution requires a persisted threadId.');
    if (!Number.isInteger(input.generation) || input.generation < 1) throw new Error('Hidden task generation must be a positive integer.');
    return this.execution.execute(input);
  }
}

/** Process-local custody of the reusable executor for a persisted hidden task. */
export class HiddenAgentTaskRunnerRegistry {
  private readonly runners = new Map<string, ReopenableTaskRunner>();

  register(jobId: string, taskIndex: number, runner: ReopenableTaskRunner): void { this.runners.set(this.key(jobId, taskIndex), runner); }
  find(jobId: string, taskIndex: number): ReopenableTaskRunner | undefined { return this.runners.get(this.key(jobId, taskIndex)); }
  private key(jobId: string, taskIndex: number): string { return `${ jobId }:${ taskIndex }`; }
}

export const hiddenAgentTaskRunnerRegistry = new HiddenAgentTaskRunnerRegistry();
