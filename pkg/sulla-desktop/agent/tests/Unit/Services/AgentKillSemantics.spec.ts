// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { AgentTurnStopper } from '../../../services/AgentTurnStopper';
import { AgentKillService } from '../../../services/AgentKillService';
import { AgentCompletionRecoveryService, CompletionDeliveryPolicy } from '../../../services/AgentCompletionRecoveryService';
import { InterruptedAgentRecoveryService } from '../../../services/InterruptedAgentRecoveryService';
import { JobCompletionDelivery } from '../../../tools/agents/jobDelivery';
import type { AgentJob } from '../../../tools/agents/jobRegistry';

const job = (jobId: string, parentThreadId: string, threadId: string, status: AgentJob['status'] = 'running'): AgentJob => ({
  jobId, parentThreadId, parentChannel: 'sulla-desktop', parentAgentId: 'manager', status,
  createdAt: 1, finishedAt: null, taskCount: 1, results: [], waitingOnChildren: 0,
  tasks: [{ agentId: 'worker', label: jobId, prompt: 'work', status: status === 'stopped' ? 'stopped' : 'running', threadId }],
});

describe('intentional kill semantics', () => {
  it('does not wake a parent for a human-killed child', async() => {
    // risk: intentional abort resurrects a parent fleet
    const stopped = { ...job('child', 'parent', 'child-thread', 'stopped'), stoppedBy: 'human' as const, stopReason: 'Killed by human' };
    const capture = vi.fn().mockResolvedValue(null);
    const delivery = new JobCompletionDelivery({ capture } as any);
    await expect(delivery.deliver(stopped, [], 0)).resolves.toBe(true);
    expect(capture).not.toHaveBeenCalled();
  });

  it('does not replay a stopped completion after restart', async() => {
    // risk: restart recovery resurrects intentionally killed work
    const enqueue = vi.fn();
    const stopped = { ...job('child', 'parent', 'child-thread', 'stopped'), stoppedBy: 'human' as const };
    const recovery = new AgentCompletionRecoveryService({ pendingCompletions: async() => [stopped] }, { enqueue } as any, new CompletionDeliveryPolicy());
    await recovery.recover();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('still wakes for an accidental failure', async() => {
    // risk: provider crashes become invisible to the manager
    const enqueue = vi.fn();
    const failed = { ...job('child', 'parent', 'child-thread'), status: 'failed' as const, results: [{ label: 'child', status: 'error' as const, output: 'provider crashed', threadId: 'child-thread', contract: 'result' }] };
    failed.tasks[0].completion = failed.results[0];
    const recovery = new AgentCompletionRecoveryService({ pendingCompletions: async() => [failed] }, { enqueue } as any, new CompletionDeliveryPolicy());
    await recovery.recover();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('kills descendants through grandchildren', async() => {
    // risk: runaway nested fleet survives a human kill
    const jobs = [job('child', 'root', 'child-thread'), job('grandchild', 'child-thread', 'grandchild-thread')];
    const stopped: string[] = [];
    const turnStopper = { stop: vi.fn().mockResolvedValue(undefined) };
    const service = new AgentKillService({ allJobs: async() => jobs }, async(id) => { stopped.push(id); return 'stopped'; }, vi.fn().mockResolvedValue(undefined), turnStopper, vi.fn().mockResolvedValue(undefined));
    await expect(service.killTree('root')).resolves.toEqual({ ok: true, killedJobs: 2 });
    expect(stopped).toEqual(['child', 'grandchild']);
  });


  it('stops the parent turn on its owning channel without a proactive message', async() => {
    // risk: a non-default manager channel survives Kill Tree
    const send = vi.fn().mockResolvedValue(undefined);
    const stopper = new AgentTurnStopper({ send });
    await stopper.stop('coding-manager', 'parent-thread');
    expect(send).toHaveBeenCalledWith('coding-manager', { type: 'stop_run', data: { threadId: 'parent-thread' } });
    expect(send).toHaveBeenCalledOnce();
  });

  it('skips restart recovery while launches are paused', async() => {
    // risk: kill-all switch fails to hold work down after restart
    const claim = vi.fn();
    const recovery = new InterruptedAgentRecoveryService({ claimInterruptedJobs: claim }, vi.fn(), vi.fn(), 2, async() => true);
    await recovery.recover();
    expect(claim).not.toHaveBeenCalled();
  });
});
