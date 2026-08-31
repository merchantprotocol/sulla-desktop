import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { WorkflowExecutionModel } from '../WorkflowExecutionModel';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

const JOURNAL_ROW = {
  id:              'outcome-1',
  dispatch_id:     'dispatch-1',
  task_id:         'task-1',
  dispatch_status: 'completed',
  task_status:     'in_review',
  task_assignee:   'heartbeat',
  comment:         'WORK_RESULT: shipped',
  result:          'ok',
  error:           null,
  evidence:        null,
  receipt:         null,
  consumed_at:     null,
};

describe('WorkTaskDispatchModel.finalizeOutcomeJournal idempotent replay', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function transactionWith(query: jest.Mock) {
    jest.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => callback({ query }));
  }

  it('settles the dispatch and consumes the journal when the task already advanced', async() => {
    const query = jest.fn((sql: string) => {
      if (sql.includes('FROM work_task_outcome_journal WHERE id')) {
        return Promise.resolve({ rows: [{ ...JOURNAL_ROW }] });
      }
      if (sql.includes('FROM work_task_dispatches WHERE id')) {
        return Promise.resolve({ rows: [{ status: 'running' }] });
      }
      if (sql.includes('SELECT status, assignee, last_moved_by FROM work_tasks')) {
        return Promise.resolve({ rows: [{ status: 'in_review', assignee: 'dispatcher', last_moved_by: 'dispatcher' }] });
      }
      if (sql.includes('SELECT * FROM work_tasks WHERE id')) {
        return Promise.resolve({ rows: [{ id: 'task-1', status: 'in_review', assignee: 'dispatcher' }] });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }) as any;
    transactionWith(query);

    const task = await WorkTaskDispatchModel.finalizeOutcomeJournal('outcome-1');
    expect(task).toEqual({ id: 'task-1', status: 'in_review', assignee: 'dispatcher' });

    const statements = query.mock.calls.map((call: any[]) => String(call[0]));
    // The dispatch settles to the journal's terminal status.
    expect(statements.some((sql: string) => sql.includes('UPDATE work_task_dispatches') && sql.includes("status = 'running'"))).toBe(true);
    // The worker's outcome comment still lands with a replay note.
    const commentCall = query.mock.calls.find((call: any[]) => String(call[0]).includes('INSERT INTO work_task_comments'));
    expect(commentCall).toBeDefined();
    expect(String((commentCall as any)[1][2])).toContain('WORK_RESULT: shipped');
    expect(String((commentCall as any)[1][2])).toContain('Outcome journal replay');
    // Stage claims release so the WIP slot is not stranded.
    expect(statements.some((sql: string) => sql.includes('UPDATE work_task_stage_claims') && sql.includes("status = 'released'"))).toBe(true);
    // The journal is consumed exactly once.
    expect(statements.some((sql: string) => sql.includes('UPDATE work_task_outcome_journal SET consumed_at'))).toBe(true);
    // The task itself is never moved: its current state won the race.
    expect(statements.some((sql: string) => sql.includes('UPDATE work_tasks') && sql.includes('SET status'))).toBe(false);
  });

  it('still runs the strict finalization while the dispatcher owns the task', async() => {
    const query = jest.fn((sql: string) => {
      if (sql.includes('FROM work_task_outcome_journal WHERE id')) {
        return Promise.resolve({ rows: [{ ...JOURNAL_ROW, task_status: 'planning', task_assignee: 'dispatcher' }] });
      }
      if (sql.includes('SELECT status, assignee, last_moved_by FROM work_tasks')) {
        return Promise.resolve({ rows: [{ status: 'in_progress', assignee: 'dispatcher', last_moved_by: 'dispatcher' }] });
      }
      if (sql.includes('FROM work_task_dispatches WHERE id')) {
        return Promise.resolve({ rows: [{ status: 'running' }] });
      }
      if (sql.includes('UPDATE work_tasks') && sql.includes('RETURNING *')) {
        return Promise.resolve({ rows: [{ id: 'task-1', status: 'planning', assignee: 'dispatcher' }] });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }) as any;
    transactionWith(query);

    const task = await WorkTaskDispatchModel.finalizeOutcomeJournal('outcome-1');
    expect(task).toEqual({ id: 'task-1', status: 'planning', assignee: 'dispatcher' });

    const statements = query.mock.calls.map((call: any[]) => String(call[0]));
    // Strict path moves the task with the dispatcher-custody guard intact.
    expect(statements.some((sql: string) => sql.includes('UPDATE work_tasks')
      && sql.includes("status = 'in_progress' AND assignee = 'dispatcher'"))).toBe(true);
  });

  it('redirects a worker self-approved terminal task into independent review', async() => {
    const query = jest.fn((sql: string) => {
      if (sql.includes('FROM work_task_outcome_journal WHERE id')) return Promise.resolve({ rows: [{ ...JOURNAL_ROW }] });
      if (sql.includes('SELECT status, assignee, last_moved_by FROM work_tasks')) {
        return Promise.resolve({ rows: [{ status: 'done', assignee: null, last_moved_by: 'sulla' }] });
      }
      if (sql.includes("SET status = 'in_progress'")) return Promise.resolve({ rows: [{ id: 'task-1' }] });
      if (sql.includes('FROM work_task_dispatches WHERE id')) return Promise.resolve({ rows: [{ status: 'running' }] });
      if (sql.includes('UPDATE work_tasks') && sql.includes('RETURNING *')) {
        return Promise.resolve({ rows: [{ id: 'task-1', status: 'in_review', assignee: 'heartbeat' }] });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }) as any;
    transactionWith(query);

    await expect(WorkTaskDispatchModel.finalizeOutcomeJournal('outcome-1')).resolves.toMatchObject({
      status: 'in_review',
    });
    const statements = query.mock.calls.map((call: any[]) => String(call[0]));
    expect(statements.some((sql: string) => sql.includes("SET status = 'in_progress'") && sql.includes("last_moved_by IS DISTINCT FROM 'human'"))).toBe(true);
    expect(statements.some((sql: string) => sql.includes("status = 'in_progress' AND assignee = 'dispatcher'"))).toBe(true);
  });
});

describe('WorkTaskDispatchModel.recordReviewLaunchWithExecution scope pair', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const LAUNCH = {
    executionId:  'exec-1',
    workflowId:   'core-review',
    workflowName: 'Review Project Artifact',
    workflowSlug: 'core-review',
    triggerInput: 'review it',
    scopeTaskId:  'task-1',
    reviewerAgentIds: ['sulla-desktop'],
  };

  function launchWith(generation: number | null) {
    const query = jest.fn((sql: string) => {
      if (sql.includes('UPDATE work_task_dispatches')) return Promise.resolve({ rows: [], rowCount: 1 });
      if (sql.includes('MAX(generation)')) return Promise.resolve({ rows: [{ generation }] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }) as any;
    jest.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => callback({ query }));
    return query;
  }

  it('passes the paired lane-entry generation so scope_pair_check cannot fire', async() => {
    const markRunning = jest.spyOn(WorkflowExecutionModel, 'markRunning').mockResolvedValue(undefined as any);
    launchWith(3);

    await WorkTaskDispatchModel.recordReviewLaunchWithExecution('dispatch-1', LAUNCH);

    expect(markRunning).toHaveBeenCalledWith(
      expect.objectContaining({ scopeTaskId: 'task-1', scopeGeneration: 3 }),
      expect.anything(),
    );
  });

  it('launches unscoped when the task has no lane-entry generation', async() => {
    const markRunning = jest.spyOn(WorkflowExecutionModel, 'markRunning').mockResolvedValue(undefined as any);
    launchWith(null);

    await WorkTaskDispatchModel.recordReviewLaunchWithExecution('dispatch-1', LAUNCH);

    expect(markRunning).toHaveBeenCalledWith(
      expect.objectContaining({ scopeTaskId: undefined, scopeGeneration: undefined }),
      expect.anything(),
    );
  });
});

describe('WorkTaskDispatchModel drainable review backlog', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('excludes wedged review rows from the backpressure count', async() => {
    const queryOne = jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({ count: '1' } as any);

    await expect(WorkTaskDispatchModel.countReviewBacklog()).resolves.toBe(1);

    const [sql] = queryOne.mock.calls[0];
    // Dead-heartbeat running dispatches cannot drain and must not hold todo work.
    expect(sql).toContain("zombie.status = 'running'");
    expect(sql).toContain('zombie.heartbeat_at < now()');
    // A terminal-failed latest verification needs planning/human recovery, not backpressure.
    expect(sql).toContain("latest_verification.kind = 'verification'");
    expect(sql).toContain("NOT LIKE 'terminal:%'");
    // Dependency-held review rows are un-claimable by the review pool.
    expect(sql).toContain('wtd.dependent_task_id = t.id');
  });

  it('mirrors the drainable conditions inside the todo-claim race guard', async() => {
    const query = jest.fn(() => Promise.resolve({ rows: [] })) as any;
    jest.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime-1')).resolves.toBeNull();

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("downstream.status = 'in_review'");
    expect(sql).toContain('zombie.task_id = downstream.id');
    expect(sql).toContain('latest_verification.task_id = downstream.id');
    expect(sql).toContain('wtd.dependent_task_id = downstream.id');
  });
});
