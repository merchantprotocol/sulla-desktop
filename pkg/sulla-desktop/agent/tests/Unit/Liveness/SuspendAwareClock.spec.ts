// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { RunLivenessClock } from '../../../services/RunLivenessClock';
import { SuspendAwareClock } from '../../../services/SuspendAwareClock';
import { AbortService } from '../../../services/AbortService';
import { HiddenAgentRunInterrupter, HiddenAgentWakeRecovery } from '../../../services/HiddenAgentWakeRecovery';
import type { AgentJob } from '../../../tools/agents/jobRegistry';

const taskJob = (visibility: 'hidden' | 'tab' = 'hidden'): AgentJob => ({
  jobId: 'sleep-job', status: 'running', createdAt: 1, finishedAt: null, taskCount: 1, results: [], visibility,
  tasks: [{ agentId: 'worker', label: 'Worker', prompt: 'continue', status: 'running', threadId: 'sleep-thread' }],
});

describe('suspend-aware worker recovery', () => {
  it('does not count a simulated long system suspend as run silence', () => {
    // risk: liveness — sleeping longer than the stall window is not provider silence.
    let wall = 1_000, monotonic = 1_000;
    const clock = new SuspendAwareClock(() => wall, () => monotonic, 50);
    const run = new RunLivenessClock(1_000, 10_000, () => clock.now());

    wall += 60_000;
    monotonic += 5;

    expect(run.verdict()).toEqual({ kind: 'alive' });
  });

  it('interrupts and re-drives only an active hidden worker on resume', async() => {
    // risk: lifecycle — hidden graph.execute work must continue after sleep aborts its stream.
    const job = taskJob();
    const abort = new AbortService();
    const graphState = { metadata: { delegatedJobId: job.jobId, delegatedTaskIndex: 0, runtimeRunnerActive: true, options: { abort } } };
    const resumed: Array<[string, number]> = [];
    const recovery = new HiddenAgentWakeRecovery(
      { list: async() => [job, taskJob('tab')] },
      new HiddenAgentRunInterrupter({ get: threadId => threadId === 'sleep-thread' ? graphState : undefined }),
      (current, index) => resumed.push([current.jobId, index]),
    );

    recovery.suspend();
    await recovery.resume();
    expect(graphState.metadata.runtimeInterrupted).toBe(true);
    expect(abort.signal.aborted).toBe(true);
    expect(resumed).toEqual([[job.jobId, 0]]);
  });
});
