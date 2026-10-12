/** @jest-environment node */
import { describe, expect, it, jest } from '@jest/globals';

const NOW = Date.UTC(2026, 9, 11, 17, 0, 0);
const MIN = 60_000;

const jobs: any[] = [
  {
    jobId: 'job-pm', status: 'running', createdAt: NOW - 14 * MIN, finishedAt: null, taskCount: 1, results: [],
    visibility: 'tab', completionDeliveredAt: null,
    tasks: [{ agentId: 'project-manager', label: 'Project Manager', prompt: 'plan', status: 'running', startedAt: NOW - 14 * MIN, visibility: 'tab', contract: { name: 'project-plan' } }],
  },
  {
    jobId: 'job-quiet', status: 'running', createdAt: NOW - 40 * MIN, finishedAt: null, taskCount: 1, results: [],
    visibility: 'hidden', completionDeliveredAt: null,
    tasks: [{ agentId: 'codex-sol-worker', label: 'Backend', prompt: 'build', status: 'running', startedAt: NOW - 40 * MIN, visibility: 'hidden', contract: { name: 'result' } }],
  },
  {
    jobId: 'job-undelivered', status: 'completed', createdAt: NOW - 20 * MIN, finishedAt: NOW - 2 * MIN, taskCount: 1,
    results: [{ label: 'Research', status: 'completed', output: 'Found three vendors.', threadId: 't3' }],
    visibility: 'hidden', completionDeliveredAt: null,
    tasks: [{ agentId: 'opus-worker', label: 'Research', prompt: 'research', status: 'completed', startedAt: NOW - 20 * MIN, finishedAt: NOW - 2 * MIN, returnedAt: NOW - 2 * MIN }],
  },
  {
    jobId: 'job-old', status: 'completed', createdAt: NOW - 3 * 60 * MIN, finishedAt: NOW - 2 * 60 * MIN, taskCount: 1,
    results: [{ label: 'Old', status: 'completed', output: 'old news', threadId: 't4' }],
    visibility: 'hidden', completionDeliveredAt: NOW - 2 * 60 * MIN,
    tasks: [{ agentId: 'haiku-worker', label: 'Old', prompt: 'old', status: 'completed', startedAt: NOW - 3 * 60 * MIN, finishedAt: NOW - 2 * 60 * MIN }],
  },
  {
    jobId: 'job-recent-done', status: 'completed', createdAt: NOW - 30 * MIN, finishedAt: NOW - 10 * MIN, taskCount: 1,
    results: [{ label: 'Recent', status: 'completed', output: 'ok', threadId: 't5' }],
    visibility: 'hidden', completionDeliveredAt: NOW - 10 * MIN,
    tasks: [{ agentId: 'luna-worker', label: 'Recent', prompt: 'recent', status: 'completed', startedAt: NOW - 30 * MIN, finishedAt: NOW - 10 * MIN }],
  },
];

jest.unstable_mockModule('../../tools/agents/jobRegistry', () => ({
  getJobsForParentThread: async(threadId: string) => (threadId === 'parent' ? jobs : []),
}));
jest.unstable_mockModule('../../database/models/AgentJobMessagingModel', () => ({
  AgentJobMessagingModel: {
    telemetryForJob: async(jobId: string) => (jobId === 'job-pm'
      ? { 0: { latestCheckin: { step: 'lanes', summary: 'lanes created, assigning agents', filesTouched: [], blockers: [], percent: 40, createdAt: NOW - 3 * MIN }, checkins: [], undeliveredMessages: 0 } }
      : {}),
  },
}));
jest.unstable_mockModule('../RunActivity', () => ({
  RunActivity: { lastActivityAt: (key: string) => (key === 'job-pm' ? NOW - MIN : undefined) },
}));

const { buildSubagentDirectoryContext } = await import('../SubagentDirectory');

describe('<subagent_directory>', () => {
  it('lists each child with visibility, contract, check-in, stalls and unprocessed results', async() => {
    const block = await buildSubagentDirectoryContext('parent', NOW);
    const lines = block.split('\n');

    const pm = lines.find(line => line.includes('project-manager'));
    expect(pm).toBe('- project-manager · tab · running 14m · contract project-plan · last check-in 3m ago 40% "lanes created, assigning agents" · job job-pm');

    const quiet = lines.find(line => line.includes('codex-sol-worker'));
    expect(quiet).toContain('hidden · running 40m');
    expect(quiet).toContain('no check-in yet');
    expect(quiet).toContain('⚠ stalled (quiet 40m)');

    expect(block).toContain('### Results not yet processed');
    expect(block).toContain('Research (job job-undelivered): "Found three vendors."');
    expect(block).toContain('1 open child looks stalled');

    // Delivered within the hour: still listed. Delivered over an hour ago: gone.
    expect(block).toContain('luna-worker');
    expect(block).not.toContain('haiku-worker');
  });

  it('is empty for a thread with no children', async() => {
    expect(await buildSubagentDirectoryContext('lonely', NOW)).toBe('');
    expect(await buildSubagentDirectoryContext(undefined, NOW)).toBe('');
  });
});
