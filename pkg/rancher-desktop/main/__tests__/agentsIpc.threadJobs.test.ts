import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('electron', () => ({ ipcMain: { handle: jest.fn() } }));
jest.unstable_mockModule('@pkg/agent/tools/agents/jobRegistry', () => ({
  getJobsForParentThread: jest.fn(() => Promise.resolve([{
    jobId:          'job-1',
    status:         'running',
    createdAt:      100,
    finishedAt:     null,
    taskCount:      2,
    results:        [],
    parentThreadId: 'parent-1',
    tasks:          [
      { agentId: 'codex-sol-worker', label: 'Backend', prompt: 'Build', status: 'running', startedAt: 110 },
      { agentId: 'codex-luna-worker', label: 'UI', prompt: 'Render', status: 'completed', startedAt: 120, finishedAt: 220 },
    ],
  }, {
    jobId:          'job-tab',
    status:         'running',
    createdAt:      130,
    finishedAt:     null,
    taskCount:      1,
    results:        [],
    parentThreadId: 'parent-1',
    parentAgentId:  'account-manager',
    visibility:     'tab',
    tasks:          [
      { agentId: 'project-manager', label: 'Project Manager', prompt: 'Plan', status: 'running', startedAt: 130, threadId: 'child-thread-1', visibility: 'tab', depth: 1, contract: { name: 'project-plan' } },
    ],
  }])),
}));
jest.unstable_mockModule('@pkg/agent/database/models/ConversationHistoryModel', () => ({
  ConversationHistoryModel: { getById: jest.fn() },
}));
jest.unstable_mockModule('@pkg/agent/utils/sullaPaths', () => ({ resolveSullaLogsDir: () => '/logs' }));
jest.unstable_mockModule('@pkg/agent/services/RunActivity', () => ({
  RunActivity: { lastActivityAt: () => 150 },
}));

const { fetchThreadAgentCards } = await import('../agentsIpc');

describe('agents:thread-jobs', () => {
  it('returns one live card per task with UI status mapping', async() => {
    const cards = await fetchThreadAgentCards('parent-1');

    expect(cards).toEqual([
      expect.objectContaining({ jobId: 'job-1', taskIndex: 0, agentId: 'codex-sol-worker', status: 'running' }),
      expect.objectContaining({ jobId: 'job-1', taskIndex: 1, agentId: 'codex-luna-worker', status: 'done' }),
      expect.objectContaining({ jobId: 'job-tab', kind: 'tab' }),
    ]);
  });

  it('shows agent tabs from the same job source, with what the rail needs to focus them', async() => {
    const cards = await fetchThreadAgentCards('parent-1');
    expect(cards.find(card => card.jobId === 'job-1')?.kind).toBe('job');
    expect(cards.find(card => card.jobId === 'job-tab')).toEqual(expect.objectContaining({
      agentId:        'project-manager',
      label:          'Project Manager',
      status:         'running',
      kind:           'tab',
      contract:       'project-plan',
      conversationId: 'child-thread-1',
      lastActivity:   'Working in its own tab',
      agentTab:       { contractId: 'job-tab', threadId: 'child-thread-1', agentName: 'Project Manager', parentAgentId: 'account-manager', depth: 1 },
    }));
  });
});
