import { afterEach, describe, expect, it, jest } from '@jest/globals';

const query = jest.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>();

jest.unstable_mockModule('../../PostgresClient', () => ({ postgresClient: { query } }));

const {
  delegationSituation, delegationTaskId, safeFinishDelegation, safeRejectDelegation, safeStartDelegation,
} = await import('../AgentDelegationModel');

afterEach(() => { query.mockReset() });

describe('delegation outcome log', () => {
  it('records a launch with the parent situation and the carried task id', async() => {
    query.mockResolvedValue([]);
    const id = await safeStartDelegation({
      via:            'spawn_agent',
      parentAgentId:  'account-manager',
      parentThreadId: 't1',
      childAgentId:   'coding-manager',
      childThreadId:  'c1',
      refId:          'job-1',
      taskId:         'AwBS',
      situation:      'ship the signup fix',
      brief:          'brief',
    });
    expect(id).toMatch(/^delegation-/);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO agent_delegations');
    expect(params).toEqual([id, 'spawn_agent', 'account-manager', 't1', 'coding-manager', 'c1', 'job-1', 'AwBS', 'ship the signup fix', 'brief']);
  });

  it('closes a row with its outcome and records rejections as finished rows', async() => {
    query.mockResolvedValue([]);
    await safeFinishDelegation('delegation-1', { outcome: 'failed', detail: 'blocked: needs login' });
    expect(query.mock.calls[0][0]).toContain('UPDATE agent_delegations');
    expect(query.mock.calls[0][1]).toEqual(['delegation-1', 'failed', 'blocked: needs login', null]);

    query.mockClear();
    await safeRejectDelegation({ via: 'agent_tab', parentAgentId: 'p', childAgentId: 'nope' }, 'unknown agent');
    expect(query.mock.calls[1][1]).toEqual([expect.stringMatching(/^delegation-/), 'rejected', 'unknown agent', false]);
  });

  it('never throws when the log write fails', async() => {
    query.mockRejectedValue(new Error('db down'));
    await expect(safeStartDelegation({ via: 'spawn_agent', parentAgentId: 'p', childAgentId: 'c' })).resolves.toBeNull();
    await expect(safeFinishDelegation('x', { outcome: 'completed' })).resolves.toBeUndefined();
  });

  it('uses the latest real user text as the situation', () => {
    expect(delegationSituation([
      { role: 'user', content: 'build the portal<turn_context>now=x</turn_context>' },
      { role: 'assistant', content: 'on it' },
      { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
      { role: 'user', content: 'recall', metadata: { source: 'subconscious' } },
    ])).toBe('build the portal');
  });

  it('only fills task_id from what the call or parent already carries', () => {
    expect(delegationTaskId('AwBS', {})).toBe('AwBS');
    expect(delegationTaskId(undefined, { ownedProjectTaskIds: ['T1'] })).toBe('T1');
    expect(delegationTaskId(undefined, { ownedProjectTaskIds: ['T1', 'T2'] })).toBeNull();
    expect(delegationTaskId(undefined, {})).toBeNull();
  });
});
