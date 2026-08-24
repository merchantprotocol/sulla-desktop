import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';
import type { WipLimits } from '../../../services/ProjectAutomationWipLimits';

const unlimited: WipLimits = {
  backlog: null, planning: null, execution: null, review: null,
  blocked: null, terminal: null, manual: null,
};

describe('WorkTaskDispatchModel.countByRole (issue #711)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('aggregates autonomous work by resolved semantic role, honouring custom lanes', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [
      { semantic_role: 'review', count: '5' },
      { semantic_role: 'execution', count: '5' },
    ] });

    const counts = await WorkTaskDispatchModel.countByRoleWithClient({ query } as any);

    expect(counts.review).toBe(5);    // 2 in_review + 3 custom qa_gate
    expect(counts.execution).toBe(5); // 1 in_progress + 4 todo
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("scope = 'project'");
    expect(sql).toContain('GROUP BY semantic_role');
    expect(sql).toContain("LOWER(t.assignee) IN ('heartbeat', 'dispatcher', 'verifier')");
    expect(sql).toContain('NOT (p.status = ANY($1::text[]))');
  });

  it('falls back to the default status role map when no lane matches', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [
      { semantic_role: 'blocked', count: '2' },
      { semantic_role: 'planning', count: '1' },
    ] });

    const counts = await WorkTaskDispatchModel.countByRoleWithClient({ query } as any);
    expect(counts.blocked).toBe(2);
    expect(counts.planning).toBe(1);
  });

  it('serializes WIP evaluation and rejects a saturated claim before selecting a task', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ semantic_role: 'execution', count: '3' }] });
    const { postgresClient } = await import('../../PostgresClient');
    jest.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNext(
      'sulla-desktop',
      'runtime-1',
      { ...unlimited, execution: 3 },
    )).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[1][0]).toContain('GROUP BY semantic_role');
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('FOR UPDATE OF t SKIP LOCKED'))).toBe(false);
  });
});
