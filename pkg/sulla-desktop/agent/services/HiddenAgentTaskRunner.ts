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

/** Instance-owned execution custody with a reconstructible fresh-session fallback. */
export class HiddenTaskExecutionService {
  private readonly runners = new Map<string, ReopenableTaskRunner>();

  constructor(private readonly freshExecution: HiddenTaskExecution) {}

  register(jobId: string, taskIndex: number, runner: ReopenableTaskRunner): void { this.runners.set(this.key(jobId, taskIndex), runner); }
  hasRegistered(jobId: string, taskIndex: number): boolean { return this.runners.has(this.key(jobId, taskIndex)); }
  async run(input: ReopenableTaskRun & { jobId: string }): Promise<AgentJobResult> {
    const runner = this.runners.get(this.key(input.jobId, input.taskIndex));
    return runner ? runner.run(input) : this.freshExecution.execute(input);
  }
  private key(jobId: string, taskIndex: number): string { return `${ jobId }:${ taskIndex }`; }
}
