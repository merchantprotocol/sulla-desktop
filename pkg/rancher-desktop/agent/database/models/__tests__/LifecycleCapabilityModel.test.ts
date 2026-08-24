import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { LifecycleCapabilityModel } from '../LifecycleCapabilityModel';
import { WorkLaneDefinitionModel } from '../WorkLaneDefinitionModel';

describe('LifecycleCapabilityModel', () => {
  const originalQuery = postgresClient.query;
  const originalQueryOne = postgresClient.queryOne;
  const originalTransaction = postgresClient.transaction;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(WorkLaneDefinitionModel, 'semanticRoleForStatus').mockImplementation((_projectId, status) => {
      const role = status === 'planning'
        ? 'planning'
        : status === 'blocked'
          ? 'blocked'
          : status === 'in_review'
            ? 'review'
            : status === 'todo' || status === 'in_progress'
              ? 'execution'
              : status === 'done' || status === 'cancelled'
                ? 'terminal'
                : status === 'backlog'
                  ? 'backlog'
                  : 'manual';
      return Promise.resolve(role);
    });
  });

  afterEach(() => {
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).queryOne = originalQueryOne;
    (postgresClient as any).transaction = originalTransaction;
  });

  it('denies Heartbeat while a healthy protected owner is active', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve({
      capability_key: 'planning-council',
      enabled:        true,
      health:         'healthy',
      active_owner:   'planning-council',
      fallback_mode:  'heartbeat',
    }));

    await expect(LifecycleCapabilityModel.assertActorCanManageTask('task-1', 'project-1', 'planning', 'heartbeat'))
      .rejects.toThrow('owned by planning-council');
  });

  it('keeps the legacy Heartbeat owner during incomplete rollout', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve(null));

    await expect(LifecycleCapabilityModel.assertActorCanManageTask('task-1', 'project-1', 'in_review', 'heartbeat'))
      .resolves.toBeUndefined();
  });

  it('lets Heartbeat claim an unavailable capability with explicit fallback', async() => {
    const capability = {
      capability_key: 'in-review-verification',
      enabled:        true,
      health:         'unavailable',
      active_owner:   'review-routine',
      fallback_mode:  'heartbeat',
    } as any;
    const inserted = {
      id:                  'stage-1',
      task_id:             'task-1',
      capability_key:      'in-review-verification',
      stage:               'in_review',
      owner:               'heartbeat',
      runtime_instance_id: 'hb-1',
      status:              'active',
    } as any;
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [capability] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [inserted] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(LifecycleCapabilityModel.claimStage(
      'task-1', 'in-review-verification', 'in_review', 'heartbeat', 'hb-1',
    )).resolves.toMatchObject({ claimed: true, claim: { id: 'stage-1' } });
  });

  it('returns the same claim for a duplicate wake and rejects a second owner', async() => {
    const capability = {
      capability_key: 'stale-recovery',
      enabled:        false,
      health:         'unavailable',
      active_owner:   null,
      fallback_mode:  'heartbeat',
    } as any;
    const existing = {
      id:                  'stage-1',
      task_id:             'task-1',
      stage:               'stale-recovery',
      owner:               'heartbeat',
      runtime_instance_id: 'wake-1',
      status:              'active',
    } as any;
    let query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [capability] })
      .mockResolvedValueOnce({ rows: [existing] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));
    await expect(LifecycleCapabilityModel.claimStage(
      'task-1', 'stale-recovery', 'stale-recovery', 'heartbeat', 'wake-1',
    )).resolves.toMatchObject({ claimed: true, claim: { id: 'stage-1' } });

    query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ ...capability, enabled: true, health: 'healthy', active_owner: 'recovery-service' }] })
      .mockResolvedValueOnce({ rows: [existing] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));
    await expect(LifecycleCapabilityModel.claimStage(
      'task-1', 'stale-recovery', 'stale-recovery', 'heartbeat', 'wake-2',
    )).resolves.toMatchObject({ claimed: false, reason: 'stale-recovery is owned by recovery-service' });
  });

  it('recovers only claims from a previous runtime, never by age', async() => {
    const query: any = jest.fn(() => Promise.resolve({ rows: [{ task_id: 'task-1' }] }));
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(LifecycleCapabilityModel.recoverPreviousRuntime('todo-execution', 'runtime-new'))
      .resolves.toEqual(['task-1']);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('runtime_instance_id <> $2'),
      ['todo-execution', 'runtime-new'],
    );
    expect((query).mock.calls[0][0]).not.toContain('interval');
  });

  it('renders compact truthful state for all lifecycle capabilities', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([
      {
        capability_key:  'planning-council',
        version:         2,
        enabled:         true,
        health:          'healthy',
        active_owner:    'planning-council',
        last_success_at: '2026-08-23T20:00:00.000Z',
        exception_count: 0,
        fallback_mode:   'heartbeat',
        fallback_active: false,
      },
      {
        capability_key:  'todo-execution',
        version:         1,
        enabled:         false,
        health:          'unavailable',
        active_owner:    null,
        last_success_at: null,
        exception_count: 1,
        fallback_mode:   'manual_hold',
        fallback_active: true,
      },
      {
        capability_key:  'in-review-verification',
        version:         1,
        enabled:         true,
        health:          'healthy',
        active_owner:    'dispatcher',
        last_success_at: '2026-08-23T20:00:00.000Z',
        exception_count: 0,
        fallback_mode:   'manual_hold',
        fallback_active: false,
        details:         { backlog: 12, active: 3, reclaimed: 2, suppressedDuplicates: 4, failures: 1 },
      },
    ]));

    const digest = await LifecycleCapabilityModel.buildDigest();
    expect(digest).toContain('planning-council@2=healthy owner:planning-council');
    expect(digest).toContain('todo-execution@1=disabled owner:hold');
    expect(digest).toContain('fallback:manual_hold*');
    expect(digest).toContain('backlog:12 active:3 reclaimed:2 suppressed:4 failures:1');
  });

  it('hides healthy protected stages and preserves explicit Heartbeat fallbacks', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([
      {
        capability_key: 'planning-council',
        enabled:        true,
        health:         'healthy',
        active_owner:   'planning-council',
        fallback_mode:  'heartbeat',
      },
      {
        capability_key: 'todo-execution',
        enabled:        true,
        health:         'unavailable',
        active_owner:   'dispatcher',
        fallback_mode:  'heartbeat',
      },
      {
        capability_key: 'in-review-verification',
        enabled:        false,
        health:         'unavailable',
        active_owner:   null,
        fallback_mode:  'manual_hold',
      },
    ]));
    const tasks = [
      { id: 'plan', project_id: 'project-1', status: 'planning' },
      { id: 'todo', project_id: 'project-1', status: 'todo' },
      { id: 'review', project_id: 'project-1', status: 'in_review' },
      { id: 'backlog', project_id: 'project-1', status: 'backlog' },
    ];

    await expect(LifecycleCapabilityModel.filterHeartbeatEligible(tasks))
      .resolves.toEqual([tasks[1], tasks[3]]);
  });

  it('deduplicates a degraded capability into one deterministic recovery task', async() => {
    const degraded = {
      capability_key:      'durable-waits',
      version:             1,
      enabled:             true,
      health:              'degraded',
      active_owner:        'wait-monitor',
      runtime_instance_id: 'wait-1',
      last_success_at:     null,
      exception_count:     3,
      fallback_mode:       'heartbeat',
      fallback_active:     true,
      last_error:          'provider unavailable',
      recovery_task_id:    null,
    } as any;
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve(degraded));
    const query: any = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [degraded] })
      .mockResolvedValueOnce({ rows: [{ project_id: 'project-1', epic_id: 'epic-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await LifecycleCapabilityModel.report({
      key:               'durable-waits',
      enabled:           true,
      health:            'degraded',
      owner:             'wait-monitor',
      runtimeInstanceId: 'wait-1',
      fallbackMode:      'heartbeat',
      error:             'provider unavailable',
    });

    expect(query.mock.calls[2][0]).toContain('ON CONFLICT (id) DO UPDATE');
    expect(query.mock.calls[2][1][0]).toBe('caprec-durable-waits');
    expect(query.mock.calls[3][1]).toEqual(['durable-waits', 'caprec-durable-waits']);
  });

  it('closes the systemic recovery item when the capability becomes healthy', async() => {
    const healthy = {
      capability_key:      'durable-waits',
      version:             1,
      enabled:             true,
      health:              'healthy',
      active_owner:        'wait-monitor',
      runtime_instance_id: 'wait-2',
      last_success_at:     '2026-08-23T20:00:00.000Z',
      exception_count:     0,
      fallback_mode:       'heartbeat',
      fallback_active:     false,
      last_error:          null,
      recovery_task_id:    'caprec-durable-waits',
    } as any;
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve(healthy));
    const query: any = jest.fn(() => Promise.resolve({ rows: [] }));
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await LifecycleCapabilityModel.report({
      key:               'durable-waits',
      enabled:           true,
      health:            'healthy',
      owner:             'wait-monitor',
      runtimeInstanceId: 'wait-2',
      fallbackMode:      'heartbeat',
    });

    expect(query.mock.calls[0][0]).toContain("resolve_project_lane_key(project_id, 'terminal', 'done')");
    expect(query.mock.calls[0][0]).toContain("resolve_work_task_lane_role(id, status) <> 'terminal'");
    expect(query.mock.calls[0][1]).toEqual(['caprec-durable-waits']);
    expect(query.mock.calls[1][0]).toContain('SET recovery_task_id = NULL');
  });
});
