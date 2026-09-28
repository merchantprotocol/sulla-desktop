import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const requestWakeMock: any = jest.fn();
jest.unstable_mockModule('../../../services/HeartbeatService', () => ({
  getHeartbeatService: () => ({ requestWake: requestWakeMock }),
}));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('ProjectsApplicationService.addComment wakes Heartbeat for human comments', () => {
  beforeEach(() => requestWakeMock.mockReset());

  it.each([
    ['human', 1],
    ['heartbeat', 0],
    ['sulla', 0],
  ])('author %s → %i wake request(s)', async(author, wakes) => {
    const { ProjectsApplicationService } = await import('../ProjectsApplicationService');
    const repo: any = { addComment: jest.fn((input: any) => Promise.resolve({ id: 'c1', task_id: input.task_id, body: input.body, author: input.author })) };
    const service = new ProjectsApplicationService(repo);

    await expect(service.addComment({ task_id: 't1', body: 'look at this', author })).resolves.toMatchObject({ id: 'c1' });
    await flush();

    expect(requestWakeMock).toHaveBeenCalledTimes(wakes);
    if (wakes) expect(requestWakeMock).toHaveBeenCalledWith('human commented on task t1');
  });
});
