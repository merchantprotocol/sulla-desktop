// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sources = vi.hoisted(() => ({
  jobs: [] as any[],
  getAllJobs: vi.fn(async() => sources.jobs),
  getAllAgents: vi.fn(async() => []),
}));

vi.mock('@pkg/agent/tools/agents/jobRegistry', () => ({ getAllJobs: sources.getAllJobs }));
vi.mock('@pkg/agent/services/ActiveAgentsRegistry', () => ({
  getActiveAgentsRegistry: () => ({ getAllAgents: sources.getAllAgents }),
}));

import { ListAgentsWorker } from '@pkg/agent/tools/agents/list_agents';

class TestableListAgentsWorker extends ListAgentsWorker {
  run() { return this._validatedCall({}) }
}

describe('list_agents job ownership', () => {
  beforeEach(() => {
    sources.jobs = [];
    sources.getAllJobs.mockImplementation(async() => sources.jobs);
    sources.getAllAgents.mockResolvedValue([]);
  });

  it('lists a manager thread without binding it to its child job', async() => {
    // risk: parent chats inherit a child job identity in live-agent lookup results.
    sources.jobs = [{
      jobId: 'child-job', status: 'running', createdAt: 20,
      parentAgentId: 'account-manager', parentThreadId: 'parent-thread',
      tasks: [{ threadId: 'child-thread', label: 'Worker', agentId: 'worker', status: 'running' }],
    }];

    const result = await new TestableListAgentsWorker().run();
    const agents = JSON.parse(result.responseString).agents;
    const manager = agents.find((item: any) => item.threadId === 'parent-thread');
    const child = agents.find((item: any) => item.threadId === 'child-thread');

    expect(manager).toMatchObject({ name: 'Manager account-manager', threadId: 'parent-thread' });
    expect(manager).not.toHaveProperty('jobId');
    expect(child).toMatchObject({ threadId: 'child-thread', jobId: 'child-job' });
  });

  it('keeps a delegated manager thread bound only to the job task that owns it', async() => {
    // risk: a newer child replaces a delegated tab manager's own job in the roster.
    sources.jobs = [
      {
        jobId: 'manager-own-job', status: 'running', createdAt: 10,
        parentAgentId: 'root-agent', parentThreadId: 'root-thread',
        tasks: [{ threadId: 'manager-thread', label: 'Manager', agentId: 'account-manager', status: 'running' }],
      },
      {
        jobId: 'manager-child-job', status: 'running', createdAt: 20,
        parentAgentId: 'account-manager', parentThreadId: 'manager-thread',
        tasks: [{ threadId: 'leaf-thread', label: 'Leaf', agentId: 'worker', status: 'running' }],
      },
    ];

    const result = await new TestableListAgentsWorker().run();
    const manager = JSON.parse(result.responseString).agents.find((item: any) => item.threadId === 'manager-thread');

    expect(manager).toMatchObject({ threadId: 'manager-thread', jobId: 'manager-own-job' });
  });
});
