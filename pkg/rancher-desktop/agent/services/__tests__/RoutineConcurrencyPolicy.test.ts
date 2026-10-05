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
describe('prompt-directed routine admission', () => {
  beforeAll(async() => { policy = await import('../RoutineConcurrencyPolicy'); });
  beforeEach(() => {
    jest.clearAllMocks();
    settingsGet.mockImplementation((key: string, fallback: any) => Promise.resolve(
      key === 'routineConcurrencyTotalLimit' ? 3 : fallback));
    query.mockResolvedValue({ rows: [{ count: '100' }] });
    transaction.mockImplementation((callback: any) => callback({ query }));
  });
  it('ignores legacy limits for every routine kind', async() => {
    for (const kind of policy.PROTECTED_ROUTINE_KINDS) {
      expect(await policy.RoutineConcurrencyPolicy.resolveLimit(kind, 1)).toBe(Infinity);
    }
    expect(await policy.RoutineConcurrencyPolicy.resolveTotalLimit()).toBeNull();
  });
  it('records more than 32 concurrent routines despite an old three-job setting', async() => {
    const ids = await Promise.all(Array.from({ length: 40 }, (_, index) =>
      policy.RoutineConcurrencyPolicy.acquire('execution', 3, { taskId: `task-${ index }` })));
    expect(new Set(ids).size).toBe(40);
    expect(ids.every(Boolean)).toBe(true);
    expect(query.mock.calls.filter(([sql]: any[]) => sql.startsWith('INSERT INTO work_routine_slots'))).toHaveLength(40);
  });
  it('retains the explicit automation stop', async() => {
    settingsGet.mockResolvedValue(false);
    expect(await policy.RoutineConcurrencyPolicy.isEnabled()).toBe(false);
  });
});
