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
describe('configurable routine admission', () => {
  beforeAll(async() => { policy = await import('../RoutineConcurrencyPolicy'); });
  beforeEach(() => {
    jest.clearAllMocks();
    settingsGet.mockImplementation((key: string, fallback: any) => Promise.resolve(
      key === 'routineConcurrencyTotalLimit' ? 3 : fallback));
    query.mockResolvedValue({ rows: [{ count: '100' }] });
    transaction.mockImplementation((callback: any) => callback({ query }));
  });
  it('uses the saved global limit for every kind', async() => {
    for (const kind of policy.PROTECTED_ROUTINE_KINDS) {
      expect(await policy.RoutineConcurrencyPolicy.resolveLimit(kind, 1)).toBe(3);
    }
    expect(await policy.RoutineConcurrencyPolicy.resolveTotalLimit()).toBe(3);
  });
  it('refuses a sixth reservation without inserting a slot', async() => {
    settingsGet.mockResolvedValue(5);
    query.mockResolvedValue({ rows: [{ count: '5' }] });
    expect(await policy.RoutineConcurrencyPolicy.acquire('execution', 99)).toBeNull();
    expect(query.mock.calls.some(([sql]: any[]) => sql.startsWith('INSERT'))).toBe(false);
  });
  it('allows the fifth reservation when the saved limit is eight', async() => {
    settingsGet.mockResolvedValue(8);
    query.mockResolvedValue({ rows: [{ count: '4' }] });
    expect(await policy.RoutineConcurrencyPolicy.acquire('review', 99)).toBeTruthy();
    expect(query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls.filter(([sql]: any[]) => sql.startsWith('INSERT'))).toHaveLength(1);
  });
  it.each([undefined, null, '', 'broken', 0, -1, 2.5, Infinity, true, Number.MAX_SAFE_INTEGER + 1])(
    'falls back to five for invalid stored value %s', async(value) => {
      settingsGet.mockResolvedValue(value);
      expect(await policy.RoutineConcurrencyPolicy.resolveTotalLimit()).toBe(5);
    });
  it('reads changes at admission time and drains without terminating existing workers', async() => {
    query.mockResolvedValue({ rows: [{ count: '5' }] });
    settingsGet.mockResolvedValue(8);
    expect(await policy.RoutineConcurrencyPolicy.acquire('execution', 3)).toBeTruthy();
    settingsGet.mockResolvedValue(2);
    expect(await policy.RoutineConcurrencyPolicy.acquire('execution', 8)).toBeNull();
    expect(query.mock.calls.some(([sql]: any[]) => sql.startsWith('DELETE'))).toBe(false);
    query.mockResolvedValue({ rows: [{ count: '1' }] });
    expect(await policy.RoutineConcurrencyPolicy.acquire('execution', 8)).toBeTruthy();
  });
  it('retains the explicit automation stop', async() => {
    settingsGet.mockResolvedValue(false);
    expect(await policy.RoutineConcurrencyPolicy.isEnabled()).toBe(false);
  });
});
