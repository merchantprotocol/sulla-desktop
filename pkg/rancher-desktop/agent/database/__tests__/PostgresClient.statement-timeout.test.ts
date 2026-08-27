import { describe, expect, it, jest } from '@jest/globals';

import { PostgresClient } from '../PostgresClient';

describe('PostgresClient statement timeout scope', () => {
  it('sets and resets a timeout around a direct query', async() => {
    const poolClient = {
      query:   jest.fn((sql: string) => Promise.resolve({ rows: sql === 'SELECT 42' ? [{ value: 42 }] : [] })),
      release: jest.fn(),
    };
    const postgres = new PostgresClient();

    jest.spyOn(postgres, 'getClient').mockResolvedValue(poolClient as any);
    const rows = await postgres.withStatementTimeout(30_000, () => postgres.query<{ value: number }>('SELECT 42'));

    expect(rows).toEqual([{ value: 42 }]);
    expect(poolClient.query.mock.calls).toEqual([
      ["SELECT set_config('statement_timeout', $1, $2)", ['30000ms', false]],
      ['SELECT 42', []],
      ['RESET statement_timeout'],
    ]);
    expect(poolClient.release).toHaveBeenCalledTimes(1);
  });

  it('uses a transaction-local timeout for transaction callbacks', async() => {
    const poolClient = {
      query:   jest.fn(() => Promise.resolve({ rows: [] })),
      release: jest.fn(),
    };
    const postgres = new PostgresClient();

    jest.spyOn(postgres, 'getClient').mockResolvedValue(poolClient as any);
    await postgres.withStatementTimeout(15_000, () => postgres.transaction(async(client) => {
      await client.query('SELECT 1');
    }));

    expect(poolClient.query.mock.calls).toEqual([
      ['BEGIN'],
      ["SELECT set_config('statement_timeout', $1, $2)", ['15000ms', true]],
      ['SELECT 1'],
      ['COMMIT'],
    ]);
    expect(poolClient.release).toHaveBeenCalledTimes(1);
  });
});
