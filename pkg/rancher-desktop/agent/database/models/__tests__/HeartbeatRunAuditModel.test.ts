import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const queryMock: any = jest.fn(() => Promise.resolve({ rows: [] }));

jest.unstable_mockModule('../../PostgresClient', () => ({
  postgresClient: { query: queryMock },
}));

const { HeartbeatRunAuditModel, toAuditTimestamp } = await import('../HeartbeatRunAuditModel');

describe('HeartbeatRunAuditModel timestamps', () => {
  beforeEach(() => queryMock.mockClear());

  it('converts String(Date) output, which Postgres rejects, to ISO', () => {
    const moved = new Date('2026-09-02T17:06:56.000Z');
    expect(toAuditTimestamp(String(moved))).toBe('2026-09-02T17:06:56.000Z');
    expect(toAuditTimestamp(moved)).toBe('2026-09-02T17:06:56.000Z');
    expect(toAuditTimestamp('not a date')).toBeNull();
    expect(toAuditTimestamp('')).toBeNull();
    expect(toAuditTimestamp(null)).toBeNull();
  });

  it('writes completion rows with ISO timestamps', async() => {
    const startedAt = new Date('2026-09-27T07:54:01.000Z');
    await HeartbeatRunAuditModel.record({
      runId:                   'heartbeat_1',
      startedAt,
      completedAt:             new Date('2026-09-27T07:55:01.000Z'),
      eventType:               'completed',
      selectedTaskId:          'abcd',
      selectedTaskLastMovedAt: String(new Date('2026-09-02T17:06:56.000Z')),
    });

    const insert = queryMock.mock.calls.find((call: any[]) => String(call[0]).includes('INSERT INTO heartbeat_run_audit'));
    expect(insert).toBeDefined();
    const params = insert[1];
    expect(params[1]).toBe('2026-09-27T07:54:01.000Z');
    expect(params[2]).toBe('2026-09-27T07:55:01.000Z');
    expect(params[15]).toBe('2026-09-02T17:06:56.000Z');
  });
});
