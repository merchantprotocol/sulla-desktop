import { afterEach, describe, expect, it, jest } from '@jest/globals';

const postgresClient = {
  initialize:  jest.fn<() => Promise<void>>(),
  query:       jest.fn<(sql: string) => Promise<unknown[]>>(),
  transaction: jest.fn(),
  end:         jest.fn(),
};

jest.unstable_mockModule('../PostgresClient', () => ({ postgresClient }));
jest.unstable_mockModule('../migrations', () => ({ migrationsRegistry: [] }));
jest.unstable_mockModule('../seeders', () => ({ seedersRegistry: [] }));
jest.unstable_mockModule('../models/SullaSettingsModel', () => ({ SullaSettingsModel: { bootstrap: jest.fn() } }));
jest.unstable_mockModule('../registry/ProjectRegistry', () => ({ projectRegistry: { initialize: jest.fn() } }));
jest.unstable_mockModule('../registry/SkillsRegistry', () => ({ skillsRegistry: { initialize: jest.fn() } }));

const { DatabaseManager } = await import('../DatabaseManager');

describe('DatabaseManager initialization', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries after migration failure instead of poisoning the singleton as initialized', async() => {
    const initialize = postgresClient.initialize.mockResolvedValue(undefined);
    const query = postgresClient.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT name FROM sulla_migrations')) {
        return Promise.reject(new Error('migration read failed'));
      }
      return Promise.resolve([]);
    });
    const manager = new DatabaseManager();

    await expect(manager.initialize()).rejects.toThrow('migration read failed');
    await expect(manager.initialize()).rejects.toThrow('migration read failed');

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.filter(([sql]) => sql === 'SELECT 1')).toHaveLength(2);
  });
});
