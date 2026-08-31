import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { postgresClient } from '../../PostgresClient';
import { WorkflowExecutionModel } from '../WorkflowExecutionModel';

jest.mock('../../PostgresClient', () => ({ postgresClient: { queryOne: jest.fn(), queryAll: jest.fn(), query: jest.fn(), transaction: jest.fn() } }));
const db = postgresClient as any;

describe('WorkflowExecutionModel leases', () => {
  beforeEach(() => jest.clearAllMocks());
  it('claims and renews only through the durable owner/token boundary', async() => {
    db.queryOne.mockResolvedValue({ execution_id: 'e1', status: 'running', owner_id: 'r1', lease_token: 't1' });
    expect(await WorkflowExecutionModel.acquireLease('e1', 'r1', 60000, 't1')).not.toBeNull();
    expect(db.queryOne.mock.calls[0][0]).toContain('lease_expires_at <= NOW()');
    await WorkflowExecutionModel.renewHeartbeat('e1', 'r1', 't1', 60000);
    expect(db.queryOne.mock.calls[1][0]).toContain('owner_id = $2 AND lease_token = $3');
  });
  it('finds stale leases only, so old fresh-heartbeat work is excluded', async() => {
    db.queryAll.mockResolvedValue([{ execution_id: 'expired' }]);
    await WorkflowExecutionModel.findStaleExecutions(new Date());
    expect(db.queryAll.mock.calls[0][0]).toContain('lease_expires_at <= $1');
    expect(db.queryAll.mock.calls[0][0]).not.toContain('started_at <');
  });
  it('settles idempotently with a compare-and-set update', async() => {
    db.queryOne.mockResolvedValueOnce({ execution_id: 'e1', status: 'completed' }).mockResolvedValueOnce(null);
    expect(await WorkflowExecutionModel.settle('e1', 'completed')).not.toBeNull();
    expect(await WorkflowExecutionModel.settle('e1', 'completed')).toBeNull();
    expect(db.queryOne.mock.calls[0][0]).toContain("status IN ('running', 'suspended')");
    expect(db.queryOne.mock.calls[0][0]).toContain('lane_settled AS');
  });
  it('expires leases during graceful suspension so boot recovery cannot miss them', async() => {
    db.queryAll.mockResolvedValue([]);
    await WorkflowExecutionModel.suspendAllRunning();
    expect(db.queryAll.mock.calls[0][0]).toContain('lease_expires_at = NOW()');
  });
  it('retires only old executions with no owner, lease, or heartbeat', async() => {
    const client: any = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ execution_id: 'stale' }] })
      .mockResolvedValueOnce({ rows: [] }) };
    db.transaction.mockImplementation(async(fn: any) => fn(client));
    expect(await WorkflowExecutionModel.reapStaleLeaselessExecutions()).toEqual(['stale']);
    expect(client.query.mock.calls[0][0]).toContain("owner_id IS NULL");
    expect(client.query.mock.calls[0][0]).toContain("heartbeat_at IS NULL");
    expect(client.query.mock.calls[0][0]).toContain("INTERVAL '1 hour'");
    expect(client.query.mock.calls[1][0]).toContain('work_lane_entry_automations');
  });
  it('recovers through one transaction and reads the last checkpoint', async() => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ execution_id: 'e1', status: 'running', attempt_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ sequence: 4 }] }) };
    db.transaction.mockImplementation(async(fn: any) => fn(client));
    const result = await WorkflowExecutionModel.recover('e1', 'runtime-1');
    expect(result?.checkpoint.sequence).toBe(4);
    expect(client.query.mock.calls[0][0]).toContain('attempt_count = attempt_count + 1');
  });
});
