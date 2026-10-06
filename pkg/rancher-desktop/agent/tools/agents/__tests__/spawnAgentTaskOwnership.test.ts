import { afterEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../../services/GraphRegistry', () => ({
  GraphRegistry: { getOrCreateAgentGraph: jest.fn(), delete: jest.fn() },
}));
jest.unstable_mockModule('../../../services/WebSocketClientService', () => ({
  getWebSocketClientService: () => ({ send: jest.fn() }),
}));

const { postgresClient } = await import('../../../database/PostgresClient');
const { WorkTaskOwnershipModel } = await import('../../../database/models/WorkTaskOwnershipModel');
const { GraphRegistry } = await import('../../../services/GraphRegistry');
const { SpawnAgentWorker } = await import('../spawn_agent');

describe('spawn_agent task ownership', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refuses to launch when another agent owns the task, and launches nothing', async() => {
    const query = jest.spyOn(postgresClient, 'query').mockResolvedValue([] as any);
    const claim = jest.spyOn(WorkTaskOwnershipModel, 'claimForJob').mockResolvedValue({
      claimed: false, conflicts: [{ taskId: 'AwBS', kind: 'dispatch', ref: 'dispatch-1' }],
    });
    const worker = new SpawnAgentWorker();
    worker.setState({ metadata: { wsChannel: 'sulla-desktop', threadId: 'parent' } });

    const result = await (worker as any)._validatedCall({
      tasks: [{ prompt: 'repair PR #17', projectTaskId: 'AwBS' }],
    });

    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('task AwBS is owned by dispatch dispatch-1');
    expect(claim).toHaveBeenCalledWith(expect.stringMatching(/^agent-job-/), { AwBS: 'sulla-desktop' }, []);
    expect((GraphRegistry as any).getOrCreateAgentGraph).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM agent_jobs'))).toBe(true);
  });

  it('lets a dispatch worker delegate the task it already owns, and hands it back when done', async() => {
    jest.spyOn(postgresClient, 'query').mockResolvedValue([] as any);
    const claim = jest.spyOn(WorkTaskOwnershipModel, 'claimForJob').mockResolvedValue({ claimed: true, conflicts: [] });
    let released!: () => void;
    const releasedOnce = new Promise<void>(resolve => { released = resolve; });
    const release = jest.spyOn(WorkTaskOwnershipModel, 'releaseForJob').mockImplementation(async() => { released(); });
    (GraphRegistry as any).getOrCreateAgentGraph.mockResolvedValue({
      graph: { execute: async(state: any) => state },
      state: { messages: [], metadata: {} },
    });
    const worker = new SpawnAgentWorker();
    worker.setState({ metadata: { wsChannel: 'sulla-desktop', threadId: 'parent', ownedProjectTaskIds: ['AwBS'] } });

    const result = await (worker as any)._validatedCall({
      tasks: [{ prompt: 'repair PR #17', projectTaskId: 'AwBS' }],
      async: true,
    });

    expect(result.successBoolean).toBe(true);
    expect(claim).toHaveBeenCalledWith(expect.any(String), { AwBS: 'sulla-desktop' }, ['AwBS']);
    // The background job must settle (and release) before the test ends.
    await releasedOnce;
    expect(release).toHaveBeenCalledWith(JSON.parse(result.responseString).jobId);
  });

  it('rejects a blank projectTaskId before creating any job', async() => {
    const claim = jest.spyOn(WorkTaskOwnershipModel, 'claimForJob');
    const worker = new SpawnAgentWorker();
    const result = await (worker as any)._validatedCall({ tasks: [{ prompt: 'x', projectTaskId: ' ' }] });

    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('invalid projectTaskId');
    expect(claim).not.toHaveBeenCalled();
  });
});
