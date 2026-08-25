/**
 * Isolated regression coverage for LifecycleCapabilityModel.heartbeatStage.
 * Kept in its own file rather than appended to LifecycleCapabilityModel.test.ts
 * because that file currently fails to compile/pass on main independent of this
 * change (pre-existing assertActorCanManageTask arg-count drift and a stale
 * resolveRecoveryTask SQL assertion) — see dHAe Phase 5 task MBJx follow-up
 * comment for the exact repro command.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { LifecycleCapabilityModel } from '../LifecycleCapabilityModel';

describe('LifecycleCapabilityModel.heartbeatStage', () => {
  const originalQueryOne = postgresClient.queryOne;

  afterEach(() => {
    (postgresClient as any).queryOne = originalQueryOne;
    jest.restoreAllMocks();
  });

  it('renews heartbeat_at for an active claim and returns the updated row', async() => {
    const claim = {
      id:                  'stage-1',
      task_id:             'task-1',
      capability_key:      'todo-execution',
      stage:               'todo',
      owner:               'dispatcher',
      runtime_instance_id: 'rt-1',
      status:              'active',
      claimed_at:          '2026-08-25T00:00:00.000Z',
      heartbeat_at:        '2026-08-25T00:05:00.000Z',
      released_at:         null,
    } as any;
    const queryOne: any = jest.fn(() => Promise.resolve(claim));
    (postgresClient as any).queryOne = queryOne;

    await expect(LifecycleCapabilityModel.heartbeatStage('stage-1')).resolves.toEqual(claim);
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('SET heartbeat_at = now()'),
      ['stage-1'],
    );
    expect(queryOne.mock.calls[0][0]).toContain("WHERE id = $1 AND status = 'active'");
  });

  it('returns null when the claim is missing or no longer active', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve(null));

    await expect(LifecycleCapabilityModel.heartbeatStage('stage-missing')).resolves.toBeNull();
  });
});
