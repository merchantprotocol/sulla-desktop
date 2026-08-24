import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { classifyInProgressRow, WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

describe('WorkTaskDispatchModel', () => {
  let originalTransaction: any;
  let originalQuery: any;

  beforeAll(() => {
    originalTransaction = postgresClient.transaction;
    originalQuery = postgresClient.query;
  });

  afterEach(() => {
    (postgresClient as any).transaction = originalTransaction;
    (postgresClient as any).query = originalQuery;
    jest.restoreAllMocks();
  });

  it('claims the next eligible task under a row lock and creates its live lease atomically', async() => {
    const task = {
      id:              'task-1',
      project_id:      'project-1',
      epic_id:         'epic-1',
      title:           'Ship it',
      description:     '',
      status:          'todo',
      active_lane_key: 'in_progress',
      priority:        'high',
      labels:          [],
    } as any;
    const dispatch = {
      id:        'dispatch-1',
      task_id:   'task-1',
      agent_id:  'opus-worker',
      thread_id: 'thread-1',
      status:    'running',
    } as any;
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [task] })
      .mockResolvedValueOnce({ rows: [dispatch] })
      .mockResolvedValueOnce({ rows: [] });

    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    const claimed = await WorkTaskDispatchModel.claimNext('opus-worker', 'core-todo');

    expect(claimed).toMatchObject({ task: { id: 'task-1' }, dispatch: { task_id: 'task-1' } });
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE OF t SKIP LOCKED');
    expect(query.mock.calls[0][0]).toContain("resolve_work_task_lane_role(t.id, t.status) = 'execution'");
    expect(query.mock.calls[0][0]).toContain('work_task_dispatches');
    expect(query.mock.calls[0][0]).toContain("FROM unnest(COALESCE(t.labels, '{}')) AS label");
    expect(query.mock.calls[0][0]).toContain('LOWER(t.assignee) = ANY($2::text[])');
    expect(query.mock.calls[0][1]).toEqual([
      ['done', 'cancelled', 'parked', 'blocked'],
      ['heartbeat', 'dispatcher'],
      ['gated', 'decision', 'human', 'manual', 'no-auto-dispatch'],
    ]);
    expect(query.mock.calls[0][0]).toContain('child.parent_id = t.id');
    expect(query.mock.calls[0][0]).toContain('t.due_at ASC NULLS LAST');
    expect(query.mock.calls[1][0]).toContain('INSERT INTO work_task_dispatches');
    expect(query.mock.calls[1][0]).toContain('run_kind');
    expect(query.mock.calls[1][0]).toContain('MAX(attempt_count)');
    expect(query.mock.calls[1][1][4]).toBe('core-todo');
    expect(query.mock.calls[2][0]).toContain('status = $2');
    expect(query.mock.calls[2][0]).toContain('assignee = $3');
    expect(query.mock.calls[2][1]).toEqual(['task-1', 'in_progress', 'dispatcher', 'todo']);
  });

  it('returns null without mutating when no eligible task exists', async() => {
    const query = jest.fn(() => Promise.resolve({ rows: [] })) as any;
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNext('opus-worker')).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('claims review work under the same cross-kind lease and excludes the execution agent', async() => {
    const task = { id: 'task-2', status: 'in_review', labels: [] } as any;
    const dispatch = {
      id: 'dispatch-review-1', task_id: 'task-2', kind: 'verification', attempt: 1,
    } as any;
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [task] })
      .mockResolvedValueOnce({ rows: [dispatch] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNextReview('codex-test')).resolves.toMatchObject({
      task: { id: 'task-2' }, dispatch: { kind: 'verification' },
    });
    expect(query.mock.calls[0][0]).toContain("resolve_work_task_lane_role(t.id, t.status) = 'review'");
    expect(query.mock.calls[0][0]).toContain('JOIN work_projects p ON p.id = e.project_id');
    expect(query.mock.calls[0][0]).toContain('CASE p.priority');
    expect(query.mock.calls[0][0].indexOf('CASE p.priority')).toBeLessThan(
      query.mock.calls[0][0].indexOf('CASE e.priority'),
    );
    expect(query.mock.calls[0][0].indexOf('CASE e.priority')).toBeLessThan(
      query.mock.calls[0][0].indexOf('CASE t.priority'),
    );
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE OF t SKIP LOCKED');
    expect(query.mock.calls[0][0]).toContain("d.status = 'running'");
    expect(query.mock.calls[0][0]).toContain("d.status IN ('failed', 'stale')");
    expect(query.mock.calls[0][0]).toContain("interval '5 minutes'");
    expect(query.mock.calls[0][0]).toContain("d.kind = 'execution'");
    expect(query.mock.calls[0][0]).toContain('<> $3');
    expect(query.mock.calls[1][0]).toContain("'verification'");
    expect(query.mock.calls[2][0]).toContain("assignee = 'verifier'");
  });

  it('recovers stale leases without duplicating work that already has verified custody', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ id: 'dispatch-1', task_id: 'task-1', kind: 'execution' }] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.recoverStale(45)).resolves.toEqual(['task-1']);
    expect(query.mock.calls[0][0]).toContain("status = 'stale'");
    expect(query.mock.calls[0][0]).toContain("interval '1 minute'");
    expect(query.mock.calls[1][0]).toContain("resolve_project_lane_key(t.project_id, 'review', 'in_review')");
    expect(query.mock.calls[1][0]).toContain("reviewer_verdict = 'pass'");
    expect(query.mock.calls[1][0]).toContain("resolve_work_task_lane_role(t.id, t.status) = 'execution'");
    expect(query.mock.calls[1][0]).toContain("assignee = 'dispatcher'");
  });

  it('returns stale verification leases to in_review instead of blocking them', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ id: 'dispatch-2', task_id: 'task-2', kind: 'verification' }] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.recoverStale(45)).resolves.toEqual(['task-2']);
    expect(query.mock.calls[1][0]).toContain("resolve_work_task_lane_role(id, status) = 'review'");
    expect(query.mock.calls[1][0]).toContain("assignee = 'verifier'");
  });

  it('settles the verifier verdict, exact head, comment, and task transition in one transaction', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-2', task_status: 'in_review' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.finalizeVerification(
      'dispatch-2', 'APPROVE', 'a'.repeat(40), 'a'.repeat(40), 'All criteria verified.',
    )).resolves.toBe('APPROVE');
    expect(query.mock.calls[1][0]).toContain('artifact_sha = $3');
    expect(query.mock.calls[2][0]).toContain('INSERT INTO work_task_comments');
    expect(query.mock.calls[3][0]).toContain("resolve_work_task_lane_role($1, $2) = 'terminal'");
    expect(query.mock.calls[3][1]).toEqual(['task-2', 'done', null, 'in_review']);
  });

  it('refuses to settle approval when the server-resolved head differs', async() => {
    const query = jest.fn(() => Promise.resolve({ rows: [{ task_id: 'task-2' }] }));
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.finalizeVerification(
      'dispatch-2', 'APPROVE', 'a'.repeat(40), 'b'.repeat(40), 'Reviewed stale head.',
    )).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('audits verifier crashes while leaving the task retryable in_review', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-2', review_generation_hash: 'g1', task_status: 'in_review', review_lane_key: 'in_review' }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.failVerification('dispatch-2', 'boom')).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toContain("status = 'failed'");
    expect(query.mock.calls[3][1][2]).toContain('released for retry');
    expect(query.mock.calls[4][1]).toEqual(['task-2', 'in_review', 'heartbeat', 'in_review']);
  });

  it('escalates the third equivalent verifier infrastructure failure to planning', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-fail', review_generation_hash: 'g1' }] })
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'older' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.failVerification('dispatch-fail', 'adapter_unavailable')).resolves.toBe(true);
    expect(query.mock.calls[2][0]).toContain("'terminal:' || $2");
    expect(query.mock.calls[4][1][2]).toContain('escalated to planning');
    expect(query.mock.calls[5][1]).toEqual(['task-fail', 'planning', 'dispatcher']);
  });

  it('binds one immutable generation and durably excludes every worker and custodian', async() => {
    const artifacts: any[] = [{
      type: 'code_pr', canonicalRef: 'org/repo#1', hash: 'a'.repeat(40), adapter: 'github-pr', code: true,
    }];
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-bind' }] })
      .mockResolvedValueOnce({
        rows: [
          { agent_id: 'worker-a', origin_evidence: { custodianAgentIds: ['custodian-a'] } },
          { agent_id: 'worker-b', origin_evidence: null },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    const bound = await WorkTaskDispatchModel.bindReviewGeneration('review-bind', artifacts);
    expect(bound.suppressed).toBe(false);
    expect(bound.excludedAgentIds.sort()).toEqual(['custodian-a', 'worker-a', 'worker-b']);
    expect(query.mock.calls[3][0]).toContain('review_generation_hash');
    expect(query.mock.calls[3][0]).toContain('excluded_agent_ids');
    expect(query.mock.calls[3][0]).toContain('worker_agent_ids');
    expect(query.mock.calls[3][0]).toContain('custodian_agent_ids');
  });

  it('suppresses an identical terminal generation before reviewer side effects', async() => {
    const artifacts: any[] = [{
      type: 'projects_evidence', canonicalRef: 'projects-task:t1', hash: 'b'.repeat(64), adapter: 'projects-read', code: false,
    }];
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-bind' }] })
      .mockResolvedValueOnce({ rows: [{ agent_id: 'worker-a', origin_evidence: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'review-old', status: 'completed', disposition: 'PASS' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    const bound = await WorkTaskDispatchModel.bindReviewGeneration('review-new', artifacts);
    expect(bound.suppressed).toBe(true);
    expect(query.mock.calls[3][1][1]).toContain('suppressed identical terminal generation review-old');
    expect(query.mock.calls[4][1]).toEqual(['task-bind', 'done', null]);
  });

  it('returns concrete rework to the dispatcher', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-2' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.finalizeVerification(
      'dispatch-2', 'REWORK', 'c'.repeat(40), null, 'Missing regression test.',
    )).resolves.toBe('REWORK');
    expect(query.mock.calls[4][1]).toEqual(['task-2', 'todo', 'dispatcher']);
  });

  it('routes a third identical rework to Heartbeat recovery', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-2' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.finalizeVerification(
      'dispatch-2', 'REWORK', 'd'.repeat(40), null, 'Same defect.',
    )).resolves.toBe('BLOCKED');
    expect(query.mock.calls[4][1]).toEqual(['task-2', 'blocked', 'heartbeat']);
    expect(query.mock.calls[3][1][2]).toContain('retry ceiling');
  });

  it('classifies the full in-progress safety matrix', () => {
    const eligible = {
      id:                   'task-1',
      archived:             false,
      epic_open:            true,
      autonomous_owner:     true,
      autonomous_labels:    true,
      has_live_dispatch:    false,
      has_active_child:     false,
      stale_activity:       true,
      has_active_agent_job: false,
    } as any;
    expect(classifyInProgressRow(eligible)).toEqual([]);
    expect(classifyInProgressRow({
      ...eligible,
      archived:             true,
      epic_open:            false,
      autonomous_owner:     false,
      autonomous_labels:    false,
      has_live_dispatch:    true,
      has_active_child:     true,
      stale_activity:       false,
      has_active_agent_job: true,
    })).toEqual([
      'archived', 'epic_closed', 'human_or_unknown_owner', 'non_autonomous_label',
      'live_dispatch', 'active_child', 'recent_activity', 'active_agent_job',
    ]);
  });

  it('uses the configured stale boundary and includes durable operation checks in report-only classification', async() => {
    const originalQuery = postgresClient.query;
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));
    try {
      await WorkTaskDispatchModel.findRecoverableInProgress(360, 25);
      const [sql, values] = (postgresClient.query as any).mock.calls[0];
      expect(sql).toContain("last_activity_at <= now() - ($4 * interval '1 minute')");
      expect(sql).toContain("j.status = 'running'");
      expect(sql).toContain("d.status = 'running'");
      expect(values).toEqual(expect.arrayContaining([360, 25]));
    } finally {
      (postgresClient as any).query = originalQuery;
    }
  });

  it('treats a concurrent activity change as a CAS miss without auditing or moving the task', async() => {
    const query: any = jest.fn(() => Promise.resolve({ rows: [] }));
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));
    const candidate = {
      task: { id: 'task-1' }, fingerprint: '2026-08-23T10:00:00.000Z', attemptCount: 0, exclusionReasons: [],
    } as any;

    await expect(WorkTaskDispatchModel.recoverOrphanedInProgress([candidate], 1, 3))
      .resolves.toEqual([{ taskId: 'task-1', outcome: 'cas_miss' }]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('t.last_activity_at = $5::timestamptz');
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE OF t SKIP LOCKED');
  });

  it('audits and requeues an orphan, then blocks at the retry ceiling', async() => {
    const task = {
      id:               'task-1',
      status:           'in_progress',
      assignee:         'dispatcher',
      last_activity_at: '2026-08-23T10:00:00.000Z',
    } as any;
    const candidate = {
      task, fingerprint: task.last_activity_at, attemptCount: 1, exclusionReasons: [],
    } as any;

    const recoveredQuery = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [task] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query: recoveredQuery }));
    await expect(WorkTaskDispatchModel.recoverOrphanedInProgress([candidate], 1, 3))
      .resolves.toEqual([{ taskId: 'task-1', outcome: 'recovered', attemptNumber: 2 }]);
    expect(recoveredQuery.mock.calls[2][0]).toContain('work_task_recovery_attempts');
    expect(recoveredQuery.mock.calls[3][0]).toContain('INSERT INTO work_task_comments');
    expect(recoveredQuery.mock.calls[3][1]).toEqual(expect.arrayContaining(['todo', 'dispatcher']));

    const ceilingQuery = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [task] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query: ceilingQuery }));
    await expect(WorkTaskDispatchModel.recoverOrphanedInProgress([candidate], 1, 3))
      .resolves.toEqual([{ taskId: 'task-1', outcome: 'blocked_ceiling', attemptNumber: 3 }]);
    expect(ceilingQuery.mock.calls[3][1]).toEqual(expect.arrayContaining(['blocked', 'heartbeat']));
  });

  it('finalizes ledger evidence, task state, and Projects comment in one transaction', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ status: 'running' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', status: 'in_review', assignee: 'heartbeat' }] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    const committed = await WorkTaskDispatchModel.finalize('dispatch-1', 'task-1', {
      dispatchStatus: 'completed',
      taskStatus:     'in_review',
      taskAssignee:   'heartbeat',
      comment:        'Verified custody.',
      result:         'done',
      evidence:       { artifactUrl: 'https://github.com/o/r/pull/1', contentHash: 'abc1234' },
    });

    expect((postgresClient as any).transaction).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(query.mock.calls[1][0]).toContain('UPDATE work_task_dispatches');
    expect(query.mock.calls[2][0]).toContain('INSERT INTO work_task_comments');
    expect(query.mock.calls[3][0]).toContain('UPDATE work_tasks');
    expect(query.mock.calls[3][0]).toContain("resolve_work_task_lane_role(id, status) = 'execution'");
    expect(query.mock.calls[3][0]).toContain('RETURNING *');
    expect(committed).toEqual(expect.objectContaining({ id: 'task-1', status: 'in_review' }));
  });

  it('atomically records protected review evidence and routes REPLAN to the planning council', async() => {
    const artifacts: any[] = [{
      type:         'code_pr',
      canonicalRef: 'merchantprotocol/sulla-desktop#671',
      hash:         'a'.repeat(40),
      adapter:      'github-pr',
      code:         true,
    }];
    const generationHash = WorkTaskDispatchModel.reviewGenerationHash(artifacts);
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-3', review_generation_hash: generationHash }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.finalizeProtectedReview(
      'review-3',
      'REPLAN',
      {
        workflowExecutionId: 'wfp-3',
        reviewerAgentIds:    ['code-researcher', 'thinking-worker'],
        excludedAgentIds:    ['opus-worker'],
        generationHash,
        artifactTypes:       ['code_pr'],
        artifacts,
        artifactType:        'code_pr',
        artifactRef:         'a'.repeat(40),
        artifactHash:        'a'.repeat(40),
        summary:             'The plan misses a required consumer.',
        checks:              ['diff'],
        findings:            [{ severity: 'high', message: 'missing consumer' }],
      },
      artifacts,
    )).resolves.toBe('REPLAN');

    expect(query.mock.calls[2][0]).toContain('reviewer_agent_ids = $12::text[]');
    expect(query.mock.calls[3][1][2]).toContain('REPLAN');
    expect(query.mock.calls[4][1]).toEqual(['task-3', 'planning', 'dispatcher']);
  });

  it('registers EXTERNAL_WAIT in the durable monitor ledger in the settlement transaction', async() => {
    const artifacts: any[] = [{
      type:         'code_pr',
      canonicalRef: 'merchantprotocol/sulla-desktop#671',
      hash:         'b'.repeat(40),
      adapter:      'github-pr',
      code:         true,
    }];
    const generationHash = WorkTaskDispatchModel.reviewGenerationHash(artifacts);
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-4', review_generation_hash: generationHash }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.finalizeProtectedReview(
      'review-4',
      'EXTERNAL_WAIT',
      {
        workflowExecutionId: 'wfp-4',
        reviewerAgentIds:    ['code-researcher'],
        excludedAgentIds:    ['opus-worker'],
        generationHash,
        artifactTypes:       ['code_pr'],
        artifacts,
        artifactType:        'code_pr',
        artifactRef:         'b'.repeat(40),
        artifactHash:        'b'.repeat(40),
        summary:             'Checks are still running.',
        checks:              ['ci pending'],
        findings:            [],
        wait:                {
          kind:      'github_checks',
          targetKey: 'merchantprotocol/sulla-desktop#671',
          target:    { owner: 'merchantprotocol', repo: 'sulla-desktop', pullNumber: 671 },
        },
      },
      artifacts,
    )).resolves.toBe('EXTERNAL_WAIT');

    expect(query.mock.calls[3][0]).toContain('INSERT INTO work_task_waits');
    expect(query.mock.calls[3][1][2]).toBe('github_checks');
    expect(query.mock.calls[6][1]).toEqual(['task-4', 'blocked', 'heartbeat']);
  });
});
