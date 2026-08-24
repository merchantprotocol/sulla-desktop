import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { postgresClient } from '../../PostgresClient';
import { WorkLaneDefinitionModel } from '../WorkLaneDefinitionModel';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

describe('WorkTaskDispatchModel.countByRole (issue #711)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('aggregates autonomous work by resolved semantic role, honouring custom lanes', async () => {
    const query = jest.spyOn(postgresClient, 'query').mockResolvedValue([
      { project_id: 'proj-a', status: 'in_review',   count: '2' },
      { project_id: 'proj-a', status: 'in_progress', count: '1' },
      { project_id: 'proj-a', status: 'qa_gate',     count: '3' }, // custom lane -> review
      { project_id: 'proj-b', status: 'todo',        count: '4' },
    ] as any);
    const resolve = jest.spyOn(WorkLaneDefinitionModel, 'resolveEffective')
      .mockImplementation(async (projectId: string) => (
        projectId === 'proj-a'
          ? [{ lane_key: 'qa_gate', semantic_role: 'review' }] as any
          : [] as any
      ));

    const counts = await WorkTaskDispatchModel.countByRole();

    expect(counts.review).toBe(5);    // 2 in_review + 3 custom qa_gate
    expect(counts.execution).toBe(5); // 1 in_progress + 4 todo
    expect(resolve).toHaveBeenCalledTimes(2); // one lookup per distinct project (cached)

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('GROUP BY e.project_id, t.status');
    expect(sql).toContain("LOWER(t.assignee) IN ('heartbeat', 'dispatcher', 'verifier')");
    expect(sql).toContain('NOT (p.status = ANY($1::text[]))');
  });

  it('falls back to the default status role map when no lane matches', async () => {
    jest.spyOn(postgresClient, 'query').mockResolvedValue([
      { project_id: 'p', status: 'blocked',  count: '2' },
      { project_id: 'p', status: 'planning', count: '1' },
    ] as any);
    jest.spyOn(WorkLaneDefinitionModel, 'resolveEffective').mockResolvedValue([] as any);

    const counts = await WorkTaskDispatchModel.countByRole();
    expect(counts.blocked).toBe(2);
    expect(counts.planning).toBe(1);
  });
});
