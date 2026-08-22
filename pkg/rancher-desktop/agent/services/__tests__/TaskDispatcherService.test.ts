import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const settingsGetMock: any = jest.fn();
const recoverStaleMock: any = jest.fn(() => Promise.resolve([]));
const countRunningMock: any = jest.fn(() => Promise.resolve(0));
const claimNextMock: any = jest.fn(() => Promise.resolve(null));
const settleMock: any = jest.fn(() => Promise.resolve());
const touchMock: any = jest.fn(() => Promise.resolve());
const addCommentMock: any = jest.fn(() => Promise.resolve());
const updateTaskMock: any = jest.fn(() => Promise.resolve());
const executeMock: any = jest.fn();
const graphDeleteMock: any = jest.fn();

jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: settingsGetMock },
}));
jest.unstable_mockModule('../../database/models/WorkTaskDispatchModel', () => ({
  WorkTaskDispatchModel: {
    recoverStale: recoverStaleMock,
    countRunning: countRunningMock,
    claimNext:    claimNextMock,
    settle:       settleMock,
    touch:        touchMock,
  },
}));
jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel: { addComment: addCommentMock, updateTask: updateTaskMock },
}));
jest.unstable_mockModule('../GraphRegistry', () => ({
  GraphRegistry: {
    getOrCreateAgentGraph: jest.fn(() => Promise.resolve({
      graph: { execute: executeMock },
      state: { messages: [], metadata: {} },
    })),
    delete: graphDeleteMock,
  },
}));
jest.unstable_mockModule('../HeartbeatService', () => ({
  isInsideWindow: jest.fn(() => true),
}));
jest.unstable_mockModule('../../utils/sullaPaths', () => ({
  findAgentDir: jest.fn(() => '/agents/opus-worker'),
}));

describe('TaskDispatcherService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recoverStaleMock.mockResolvedValue([]);
    countRunningMock.mockResolvedValue(0);
    claimNextMock.mockResolvedValue(null);
    settingsGetMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'heartbeatEnabled') return Promise.resolve(true);
      return Promise.resolve(fallback);
    });
  });

  it('recovers orphaned leases before filling worker capacity', async() => {
    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();

    await service.initialize();
    service.destroy();

    expect(recoverStaleMock).toHaveBeenCalledWith(0);
    expect(countRunningMock).toHaveBeenCalled();
  });

  it('claims mechanically, executes the assigned worker, and returns completed work for review', async() => {
    const claim = {
      task: {
        id:          'task-1',
        title:       'Ship it',
        description: 'Implement and verify.',
        project_id:  'project-1',
        epic_id:     'epic-1',
        priority:    'high',
      },
      dispatch: {
        id: 'dispatch-1', task_id: 'task-1', agent_id: 'opus-worker', thread_id: 'thread-1',
      },
    };
    claimNextMock
      .mockResolvedValueOnce(claim)
      .mockResolvedValue(null);
    executeMock.mockResolvedValue({
      metadata: { agent: { status: 'completed' }, finalSummary: 'Draft PR opened and tests passed.' },
      messages: [],
    });

    const { TaskDispatcherService } = await import('../TaskDispatcherService');
    const service = new TaskDispatcherService();
    await service.initialize();

    await new Promise(resolve => setTimeout(resolve, 0));
    service.destroy();

    expect(claimNextMock).toHaveBeenCalledWith('opus-worker');
    expect(executeMock).toHaveBeenCalled();
    expect(settleMock).toHaveBeenCalledWith(
      'dispatch-1', 'completed', 'Draft PR opened and tests passed.', undefined,
    );
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', {
      status: 'in_review', assignee: 'heartbeat', actor: 'dispatcher',
    });
  });
});
