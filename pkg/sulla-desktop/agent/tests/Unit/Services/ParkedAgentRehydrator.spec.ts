// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import { ParkedAgentRehydrator } from '../../../services/ParkedAgentRehydrator';
import type { AgentJob } from '../../../tools/agents/jobRegistry';

const parkedJob = (): AgentJob => ({
  jobId: 'manager-job', status: 'parked', createdAt: 1, finishedAt: null,
  taskCount: 1, results: [], parentChannel: 'sulla-desktop', parentThreadId: 'root',
  tasks: [{ agentId: 'coding-manager-sol', label: 'manager', prompt: 'own', status: 'parked', threadId: 'manager-thread', depth: 1 }],
});

describe('ParkedAgentRehydrator', () => {
  it('restores exact agent and delegated job context', async() => {
    // risk: wrong persona/model/thread after graph eviction
    const service = new ParkedAgentRehydrator(
      { findByTaskThread: async() => parkedJob() },
      { findBySlug: async() => ({ slug: 'coding-manager-sol' }) },
      vi.fn(),
    );
    const identity = await service.resolve('manager-thread');
    expect(identity).toMatchObject({ agentId: 'coding-manager-sol', taskIndex: 0, job: { jobId: 'manager-job' } });
    const state = { metadata: {} as Record<string, unknown> };
    service.apply(state, identity!);
    expect(state.metadata).toMatchObject({ isSubAgent: true, delegatedJobId: 'manager-job', subAgentDepth: 1 });
  });

  it('recognizes terminal delegated threads so late children cannot resurrect them', async() => {
    // risk: a stopped parent is restarted by a late child completion
    const stopped = parkedJob();
    stopped.status = 'stopped';
    const service = new ParkedAgentRehydrator(
      { findByTaskThread: async() => stopped },
      { findBySlug: async() => ({}) },
      vi.fn(),
    );
    expect(await service.isTerminalDelegatedThread('manager-thread')).toBe(true);
    expect(await service.resolve('manager-thread')).toBeNull();
  });

  it('fails visibly instead of falling back when the definition is missing', async() => {
    // risk: a parked manager wakes as default Sulla with the wrong prompt/model
    const fail = vi.fn();
    const service = new ParkedAgentRehydrator(
      { findByTaskThread: async() => parkedJob() },
      { findBySlug: async() => null },
      fail,
    );
    await expect(service.resolve('manager-thread')).rejects.toThrow('refusing default-agent fallback');
    expect(fail).toHaveBeenCalledWith('manager-job', expect.stringContaining('coding-manager-sol'));
  });
});
