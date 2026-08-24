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
  MAX_ROUTINE_CONCURRENCY,
  PROTECTED_ROUTINE_KINDS,
  perKindLimitKey,
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

  it('uses the per-kind setting when enabled', async() => {
    settings({ automatedProjectManagementEnabled: true, [perKindLimitKey('planning')]: 4 });
    expect(await RoutineConcurrencyPolicy.resolveLimit('planning', 1)).toBe(4);
  });

  it('clamps to [0, MAX]', async() => {
    settings({ automatedProjectManagementEnabled: true, [perKindLimitKey('review')]: 999 });
    expect(await RoutineConcurrencyPolicy.resolveLimit('review')).toBe(MAX_ROUTINE_CONCURRENCY);
    settings({ automatedProjectManagementEnabled: true, [perKindLimitKey('review')]: -5 });
    expect(await RoutineConcurrencyPolicy.resolveLimit('review')).toBe(0);
  });

  it('falls back to the legacy key for execution when the per-kind key is unset', async() => {
    settings({ automatedProjectManagementEnabled: true, taskDispatcherConcurrency: 5 });
    expect(await RoutineConcurrencyPolicy.resolveLimit('execution', 3)).toBe(5);
  });

  it('uses the built-in default when nothing is configured and enabled', async() => {
    settings({ automatedProjectManagementEnabled: true });
    expect(await RoutineConcurrencyPolicy.resolveLimit('dreaming')).toBe(DEFAULT_ROUTINE_LIMITS.dreaming);
  });

  it('exposes all six protected kinds', () => {
    expect(PROTECTED_ROUTINE_KINDS).toEqual(['planning', 'execution', 'review', 'repair', 'dreaming', 'other']);
  });
});
