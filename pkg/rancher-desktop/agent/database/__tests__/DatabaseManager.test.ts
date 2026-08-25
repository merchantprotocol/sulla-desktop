import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { DatabaseManager } from '../DatabaseManager';
import { postgresClient } from '../PostgresClient';

describe('DatabaseManager initialization', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries after migration failure instead of poisoning the singleton as initialized', async() => {
    const initialize = jest.spyOn(postgresClient, 'initialize').mockResolvedValue(undefined);
    const query = jest.spyOn(postgresClient, 'query').mockImplementation(((sql: string) => {
      if (sql.includes('SELECT name FROM sulla_migrations')) {
        return Promise.reject(new Error('migration read failed'));
      }
      return Promise.resolve([]);
    }) as any);
    const manager = new DatabaseManager();

    await expect(manager.initialize()).rejects.toThrow('migration read failed');
    await expect(manager.initialize()).rejects.toThrow('migration read failed');

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.filter(([sql]) => sql === 'SELECT 1')).toHaveLength(2);
  });
});
