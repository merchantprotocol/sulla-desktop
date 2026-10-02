import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const settingsGet: any = jest.fn();

jest.unstable_mockModule('../../database/PostgresClient', () => ({
  postgresClient: { query: jest.fn(), queryOne: jest.fn(), transaction: jest.fn() },
}));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: (...args: any[]) => settingsGet(...args) },
}));

let policy: typeof import('../RoutineConcurrencyPolicy');

function settings(map: Record<string, any>) {
  settingsGet.mockImplementation((key: string, def: any) => Promise.resolve(key in map ? map[key] : def));
}

describe('RoutineConcurrencyPolicy.resolveLimit', () => {
  beforeAll(async() => {
    policy = await import('../RoutineConcurrencyPolicy');
  });

  beforeEach(() => {
    settingsGet.mockReset();
  });

  it('returns the legacy fallback unchanged when the feature is disabled', async() => {
    settings({ automatedProjectManagementEnabled: false });
    expect(await policy.RoutineConcurrencyPolicy.resolveLimit('execution', 7)).toBe(7);
  });

  it('falls back to the built-in per-kind default when disabled and no legacy value given', async() => {
    settings({ automatedProjectManagementEnabled: false });
    expect(await policy.RoutineConcurrencyPolicy.resolveLimit('dreaming')).toBe(policy.DEFAULT_ROUTINE_LIMITS.dreaming);
  });

  it('mirrors the single total concurrent-agent limit for every kind when enabled', async() => {
    settings({ automatedProjectManagementEnabled: true, [policy.TOTAL_LIMIT_KEY]: 4 });
    expect(await policy.RoutineConcurrencyPolicy.resolveLimit('planning', 1)).toBe(4);
    expect(await policy.RoutineConcurrencyPolicy.resolveLimit('review', 9)).toBe(4);
  });

  it('falls back to DEFAULT_TOTAL_LIMIT when enabled with no total limit set yet', async() => {
    settings({ automatedProjectManagementEnabled: true });
    expect(await policy.RoutineConcurrencyPolicy.resolveLimit('execution')).toBe(policy.DEFAULT_TOTAL_LIMIT);
  });

  it('clamps the total limit to [0, MAX]', async() => {
    settings({ automatedProjectManagementEnabled: true, [policy.TOTAL_LIMIT_KEY]: 999 });
    expect(await policy.RoutineConcurrencyPolicy.resolveLimit('review')).toBe(policy.MAX_ROUTINE_CONCURRENCY);
  });

  it('exposes all six protected kinds', () => {
    expect(policy.PROTECTED_ROUTINE_KINDS).toEqual(['planning', 'execution', 'review', 'repair', 'dreaming', 'other']);
  });
});
