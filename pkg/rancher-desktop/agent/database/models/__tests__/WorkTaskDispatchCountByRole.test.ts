import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

import type { WipLimits } from '../../../services/ProjectAutomationWipLimits';

const unlimited: WipLimits = {
  backlog:   null,
  planning:  null,
  execution: null,
  review:    null,
  blocked:   null,
  terminal:  null,
  manual:    null,
};

describe('WorkTaskDispatchModel.countByRole (issue #711)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('aggregates autonomous work by resolved semantic role, honouring custom lanes', async() => {
    const query = jest.fn<(text: string, params?: unknown[]) => Promise<any>>().mockResolvedValue({
      rows: [
        { semantic_role: 'review', count: '5' },
        { semantic_role: 'execution', count: '5' },
      ],
    });

    const counts = await WorkTaskDispatchModel.countByRoleWithClient({ query } as any);

    expect(counts.review).toBe(5);    // 2 in_review + 3 custom qa_gate
    expect(counts.execution).toBe(5); // 1 in_progress + 4 todo
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("scope = 'project'");
    // Both lateral lane lookups expose a semantic_role input column. PostgreSQL
    // resolves GROUP BY names against inputs before select aliases, so grouping
    // by the alias is ambiguous in the real database. The ordinal targets the
    // resolved COALESCE expression unambiguously.
    expect(sql).toContain('GROUP BY 1');
    expect(sql).not.toContain('GROUP BY semantic_role');
    expect(sql).not.toContain('LOWER(t.assignee)');
    expect(sql).not.toContain('p.dispatch_enabled = true');
  });

  it('falls back to the default status role map when no lane matches', async() => {
    const query = jest.fn<(text: string, params?: unknown[]) => Promise<any>>().mockResolvedValue({
      rows: [
        { semantic_role: 'blocked', count: '2' },
        { semantic_role: 'planning', count: '1' },
      ],
    });

    const counts = await WorkTaskDispatchModel.countByRoleWithClient({ query } as any);
    expect(counts.blocked).toBe(2);
    expect(counts.planning).toBe(1);
  });

  it('keeps WIP telemetry from becoming a policy exclusion', async() => {
    const query = jest.fn<(text: string, params?: unknown[]) => Promise<any>>()
      .mockResolvedValue({ rows: [] });
    const { postgresClient } = await import('../../PostgresClient');
    jest.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNext(
      'sulla-desktop',
      'runtime-1',
      { ...unlimited, execution: 3 },
    )).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[1][0]).toContain('FOR UPDATE OF t SKIP LOCKED');
  });
});
