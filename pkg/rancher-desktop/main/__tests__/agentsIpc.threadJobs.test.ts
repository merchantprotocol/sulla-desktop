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
    ]);
  });
});
