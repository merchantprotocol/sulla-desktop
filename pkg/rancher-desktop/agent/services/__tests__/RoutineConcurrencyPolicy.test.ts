import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const settingsGet: any = jest.fn();
const query: any = jest.fn();
const transaction: any = jest.fn();
jest.unstable_mockModule('../../database/PostgresClient', () => ({
  postgresClient: { query, queryOne: jest.fn(), transaction },
}));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: (...args: any[]) => settingsGet(...args) },
}));
let policy: typeof import('../RoutineConcurrencyPolicy');
describe('five-worker routine admission', () => {
  beforeAll(async() => { policy = await import('../RoutineConcurrencyPolicy'); });
  beforeEach(() => {
    jest.clearAllMocks();
    settingsGet.mockImplementation((key: string, fallback: any) => Promise.resolve(
      key === 'routineConcurrencyTotalLimit' ? 3 : fallback));
    query.mockResolvedValue({ rows: [{ count: '100' }] });
    transaction.mockImplementation((callback: any) => callback({ query }));
  });
  it('uses the global five-worker limit for every kind', async() => {
    for (const kind of policy.PROTECTED_ROUTINE_KINDS) {
      expect(await policy.RoutineConcurrencyPolicy.resolveLimit(kind, 1)).toBe(5);
    }
    expect(await policy.RoutineConcurrencyPolicy.resolveTotalLimit()).toBe(5);
  });
  it('refuses a sixth reservation without inserting a slot', async() => {
    query.mockResolvedValue({ rows: [{ count: '5' }] });
    expect(await policy.RoutineConcurrencyPolicy.acquire('execution', 99)).toBeNull();
    expect(query.mock.calls.some(([sql]: any[]) => sql.startsWith('INSERT'))).toBe(false);
  });
  it('allows the fifth reservation under the admission lock', async() => {
    query.mockResolvedValue({ rows: [{ count: '4' }] });
    expect(await policy.RoutineConcurrencyPolicy.acquire('review', 99)).toBeTruthy();
    expect(query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls.filter(([sql]: any[]) => sql.startsWith('INSERT'))).toHaveLength(1);
  });
  it('retains the explicit automation stop', async() => {
    settingsGet.mockResolvedValue(false);
    expect(await policy.RoutineConcurrencyPolicy.isEnabled()).toBe(false);
  });
});
