import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const listTasksAwaitingHumanReplyMock: any = jest.fn();
const addCommentMock: any = jest.fn();

jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel:       { listTasksAwaitingHumanReply: listTasksAwaitingHumanReplyMock },
  isHumanCommentAuthor: (author: string | null | undefined) => ['human', 'user', 'owner', 'me'].includes(String(author ?? '').trim().toLowerCase()),
}));
jest.unstable_mockModule('../../projects/application/ProjectsApplicationService', () => ({
  getProjectsApplicationService: () => ({ ready: () => Promise.resolve(), addComment: addCommentMock }),
}));

const row = (id: string) => ({ task: { id, status: 'parked' }, comment_id: `c-${ id }`, body: 'please look', created_at: '2026-09-28T20:00:00.000Z' });

describe('listHumanCommentTriage', () => {
  beforeEach(() => {
    listTasksAwaitingHumanReplyMock.mockReset();
  });

  it('asks for comments Heartbeat has not answered in the last 14 days', async() => {
    listTasksAwaitingHumanReplyMock.mockResolvedValue([]);
    const { listHumanCommentTriage } = await import('../HumanCommentTriage');

    await expect(listHumanCommentTriage(5)).resolves.toEqual([]);
    expect(listTasksAwaitingHumanReplyMock).toHaveBeenCalledWith({ responder: 'heartbeat', sinceDays: 14, limit: 5 });
  });

  it('returns every unanswered human comment whatever the ticket state', async() => {
    listTasksAwaitingHumanReplyMock.mockResolvedValue([row('parked'), row('done')]);
    const { listHumanCommentTriage } = await import('../HumanCommentTriage');

    const result = await listHumanCommentTriage();
    expect(result.map(r => r.task.id)).toEqual(['parked', 'done']);
  });
});

describe('add_task_comment', () => {
  beforeEach(() => {
    addCommentMock.mockReset().mockResolvedValue({ id: 'c1', author: 'heartbeat' });
  });

  it.each([['author', 'human'], ['author', ' Human '], ['actor', 'owner']])('refuses to let an agent post as the human (%s=%s)', async(field, value) => {
    const { AddTaskCommentWorker } = await import('../../tools/project/add_task_comment');
    const result = await (new AddTaskCommentWorker() as any)._validatedCall({ task_id: 't1', body: 'Marking done', [field]: value });

    expect(result.successBoolean).toBe(false);
    expect(result.responseString).toContain('cannot post as the human');
    expect(addCommentMock).not.toHaveBeenCalled();
  });

  it('still posts agent comments', async() => {
    const { AddTaskCommentWorker } = await import('../../tools/project/add_task_comment');
    const result = await (new AddTaskCommentWorker() as any)._validatedCall({ task_id: 't1', body: 'Handled: moved to todo.', author: 'heartbeat' });

    expect(result.successBoolean).toBe(true);
    expect(addCommentMock).toHaveBeenCalledWith({ task_id: 't1', body: 'Handled: moved to todo.', author: 'heartbeat' }, { actor: 'sulla', source: 'tool' });
  });
});
