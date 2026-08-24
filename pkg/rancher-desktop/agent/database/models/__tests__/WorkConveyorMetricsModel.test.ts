import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { postgresClient } from '../../PostgresClient';
import { WorkConveyorMetricsModel } from '../WorkConveyorMetricsModel';

describe('WorkConveyorMetricsModel', () => {
  let originalQuery: any;
  let sqls: string[] = [];

  beforeAll(() => { originalQuery = (postgresClient as any).query; });
  afterEach(() => { (postgresClient as any).query = originalQuery; jest.restoreAllMocks(); sqls = []; });

  function mock(rows: any[]) {
    (postgresClient as any).query = jest.fn((sql: string, _params?: any[]) => {
      sqls.push(sql);
      return Promise.resolve(rows);
    });
  }

  it('stageCounts groups by semantic lane role (custom-lane safe) and returns the exact oldest item (AC#2)', async () => {
    mock([{ stage: 'execution', count: '3', oldest_task_id: 'task-9', oldest_title: 'Old one',
            oldest_entered_at: '2026-08-01T00:00:00.000Z', oldest_age_seconds: '86400' }]);
    const rows = await WorkConveyorMetricsModel.stageCounts({ projectId: 'p1' });
    expect(sqls[0]).toContain('resolve_work_task_lane_role');
    expect(sqls[0]).toContain('$1::text IS NULL OR');
    expect(rows[0]).toMatchObject({ stage: 'execution', count: 3, oldestTaskId: 'task-9', oldestAgeSeconds: 86400 });
  });

  it('empty-state: rate aggregates degrade to zero without NaN', async () => {
    mock([]);
    const rework = await WorkConveyorMetricsModel.reworkRate({});
    expect(rework).toEqual({ reviewed: 0, reworked: 0, reworkRate: 0, avgRepairLoops: 0 });
    const waits = await WorkConveyorMetricsModel.waitAdoption({});
    expect(waits.adoptionRate).toBe(0);
  });

  it('verifier throughput excludes duplicate and suppressed generations (AC#5)', async () => {
    mock([{ completed_reviews: '4', active_verification_leases: '1' }]);
    const v = await WorkConveyorMetricsModel.verifierThroughput({ windowHours: 24 });
    expect(sqls[0]).toContain('DISTINCT');
    expect(sqls[0]).toContain('review_generation_hash');
    expect(sqls[0].toLowerCase()).toContain('suppress');
    expect(v.completedReviews).toBe(4);
    expect(v.perDay).toBeCloseTo(4);
  });

  it('custody completeness distinguishes structured/legacy/missing/invalid incl migrated data (AC#3)', async () => {
    mock([{ artifact_type: 'pull_request', total: '5', structured: '3', legacy: '1', missing: '1', invalid: '0' }]);
    const rows = await WorkConveyorMetricsModel.custodyCompleteness({});
    expect(sqls[0]).toContain("'legacy-worker'");
    expect(rows[0]).toMatchObject({ artifactType: 'pull_request', total: 5, structured: 3, legacy: 1, missing: 1, invalid: 0 });
  });

  it('wait adoption counts only blocked tasks with an active matching durable wait (AC#4)', async () => {
    mock([{ blocked_total: '2', blocked_with_active_wait: '1' }]);
    const w = await WorkConveyorMetricsModel.waitAdoption({});
    expect(sqls[0]).toContain('resolve_work_task_lane_role');
    expect(sqls[0]).toContain("status = 'active'");
    expect(w).toEqual({ blockedTotal: 2, blockedWithActiveWait: 1, adoptionRate: 0.5 });
  });

  it('separates independent shipments from integration-train closures via artifact custody (AC#6)', async () => {
    mock([{ independent_shipments: '3', integration_train_closures: '2' }]);
    const s = await WorkConveyorMetricsModel.shipments({ windowHours: 168 });
    expect(sqls[0]).toContain('content_hash');
    expect(s).toEqual({ independentShipments: 3, integrationTrainClosures: 2 });
  });

  it('drill-down queries are bounded with LIMIT for query performance (AC#7)', async () => {
    mock([]);
    await WorkConveyorMetricsModel.oldestItems({ drillLimit: 10 }, 'execution');
    await WorkConveyorMetricsModel.staleLeaseItems({});
    expect(sqls[0]).toContain('LIMIT');
    expect(sqls[1]).toContain('LIMIT');
  });

  it('wipPressure reports a documented WIP limit and derived backpressure reason', async () => {
    mock([{ active_execution_wip: '6', active_verification_wip: '1', stale_wip: '0' }]);
    const wip = await WorkConveyorMetricsModel.wipPressure({ wipLimit: 6 });
    expect(wip.over).toBe(true);
    expect(wip.backpressureReason).toBe('wip_limit_reached');
  });
});
