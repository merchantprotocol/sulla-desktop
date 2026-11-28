// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sources = vi.hoisted(() => ({
  jobs: [] as any[],
  threads: [] as any[],
  getAllJobs: vi.fn(async() => sources.jobs),
}));

vi.mock('@pkg/agent/tools/agents/jobRegistry', () => ({ getAllJobs: sources.getAllJobs }));
vi.mock('@pkg/agent/services/GraphRegistry', () => ({
  GraphRegistry: { findThreadsByChannel: (channel: string) => sources.threads.filter(thread => thread.channel === channel) },
}));

import { ActiveAgentsRegistry, type ActiveAgent } from '@pkg/agent/services/ActiveAgentsRegistry';

class TestableActiveAgentsRegistry extends ActiveAgentsRegistry {
  constructor(private readonly agents: ActiveAgent[]) { super() }
  async getAllAgents(): Promise<ActiveAgent[]> { return this.agents }
  async buildHumanPresence(): Promise<string> { return '' }
}

const agent = (agentId: string, channel: string, name = agentId): ActiveAgent => ({
  agentId, channel, name, role: 'agent', type: 'agent', status: 'running',
  startedAt: 1, lastActiveAt: 1, description: '',
});

describe('ActiveAgentsRegistry compact roster job ownership', () => {
  beforeEach(() => {
    sources.jobs = [];
    sources.threads = [];
    sources.getAllJobs.mockImplementation(async() => sources.jobs);
  });

  it('shows a launched child as a manager relationship, not as the parent chat own job', async() => {
    // risk: the parent chat is misidentified as the child's delegated task in its own turn context.
    sources.jobs = [{
      jobId: 'child-job', status: 'running', createdAt: 20, parentThreadId: 'parent-thread',
      parentAgentId: 'account-manager', tasks: [{ threadId: 'child-thread', label: 'Worker', agentId: 'worker', status: 'running' }],
    }];
    sources.threads = [{ channel: 'account-manager', threadId: 'parent-thread', label: 'Manager account-manager', jobId: 'child-job' }];

    const roster = await new TestableActiveAgentsRegistry([agent('account-manager', 'account-manager')]).buildCompactRoster();

    expect(roster).toContain('Manager account-manager@account-manager#parent-thread');
    expect(roster).not.toContain('Manager account-manager@account-manager#parent-thread (job child-job');
  });

  it('keeps a tab agent on its own job when the tab also launches a child', async() => {
    // risk: a tab manager's newer child job replaces the parent job that actually owns the tab thread.
    sources.jobs = [
      {
        jobId: 'tab-own-job', status: 'running', createdAt: 10, parentThreadId: 'root-thread', parentAgentId: 'root-agent',
        tasks: [{ threadId: 'tab-thread', label: 'Tab agent', agentId: 'tab-agent', status: 'running' }],
      },
      {
        jobId: 'tab-child-job', status: 'running', createdAt: 20, parentThreadId: 'tab-thread', parentAgentId: 'tab-agent',
        tasks: [{ threadId: 'leaf-thread', label: 'Leaf worker', agentId: 'worker', status: 'running' }],
      },
    ];
    sources.threads = [{ channel: 'tab-agent', threadId: 'tab-thread', label: 'Tab agent', jobId: 'tab-child-job' }];

    const roster = await new TestableActiveAgentsRegistry([
      agent('root-agent', 'root-agent'), agent('tab-agent', 'tab-agent'),
    ]).buildCompactRoster();

    expect(roster).toContain('Tab agent@tab-agent#tab-thread (job tab-own-job)');
    expect(roster).not.toContain('Tab agent@tab-agent#tab-thread (job tab-child-job');
  });
});
