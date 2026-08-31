const settingsGet = jest.fn();

jest.mock('../../database/PostgresClient', () => ({
  postgresClient: { query: jest.fn(), queryOne: jest.fn(), transaction: jest.fn() },
}));
jest.mock('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: (...args: any[]) => settingsGet(...args) },
}));

import {
  RoutineConcurrencyPolicy,
  DEFAULT_ROUTINE_LIMITS,
  DEFAULT_TOTAL_LIMIT,
  MAX_ROUTINE_CONCURRENCY,
  PROTECTED_ROUTINE_KINDS,
  TOTAL_LIMIT_KEY,
} from '../RoutineConcurrencyPolicy';

function settings(map: Record<string, any>) {
  settingsGet.mockImplementation(async(key: string, def: any) => (key in map ? map[key] : def));
}

describe('RoutineConcurrencyPolicy.resolveLimit', () => {
  beforeEach(() => settingsGet.mockReset());

  it('returns the legacy fallback unchanged when the feature is disabled', async() => {
    settings({ automatedProjectManagementEnabled: false });
    expect(await RoutineConcurrencyPolicy.resolveLimit('execution', 7)).toBe(7);
  });

  it('falls back to the built-in per-kind default when disabled and no legacy value given', async() => {
    settings({ automatedProjectManagementEnabled: false });
    expect(await RoutineConcurrencyPolicy.resolveLimit('dreaming')).toBe(DEFAULT_ROUTINE_LIMITS.dreaming);
  });

  it('mirrors the single total concurrent-agent limit for every kind when enabled', async() => {
    settings({ automatedProjectManagementEnabled: true, [TOTAL_LIMIT_KEY]: 4 });
    expect(await RoutineConcurrencyPolicy.resolveLimit('planning', 1)).toBe(4);
    expect(await RoutineConcurrencyPolicy.resolveLimit('review', 9)).toBe(4);
  });

  it('falls back to DEFAULT_TOTAL_LIMIT when enabled with no total limit set yet', async() => {
    settings({ automatedProjectManagementEnabled: true });
    expect(await RoutineConcurrencyPolicy.resolveLimit('execution')).toBe(DEFAULT_TOTAL_LIMIT);
  });

  it('clamps the total limit to [0, MAX]', async() => {
    settings({ automatedProjectManagementEnabled: true, [TOTAL_LIMIT_KEY]: 999 });
    expect(await RoutineConcurrencyPolicy.resolveLimit('review')).toBe(MAX_ROUTINE_CONCURRENCY);
  });

  it('exposes all six protected kinds', () => {
    expect(PROTECTED_ROUTINE_KINDS).toEqual(['planning', 'execution', 'review', 'repair', 'dreaming', 'other']);
  });
});
