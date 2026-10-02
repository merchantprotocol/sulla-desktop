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

  it('skips AsyncLocalStorage in an Electron renderer and queries without a timeout', async() => {
    // In a renderer, AsyncLocalStorage.getStore() can abort V8 outright, so
    // the client must never touch it there.
    const original = Object.getOwnPropertyDescriptor(process, 'type');
    Object.defineProperty(process, 'type', { value: 'renderer', configurable: true });
    try {
      let RendererPostgresClient!: typeof PostgresClient;
      await jest.isolateModulesAsync(async() => {
        RendererPostgresClient = (await import('../PostgresClient')).PostgresClient;
      });
      const poolClient = {
        query:   jest.fn(() => Promise.resolve({ rows: [{ ok: true }] })),
        release: jest.fn(),
      };
      const postgres = new RendererPostgresClient();

      expect((postgres as any).statementTimeout).toBeNull();
      jest.spyOn(postgres, 'getClient').mockResolvedValue(poolClient as any);
      const rows = await postgres.withStatementTimeout(30_000, () => postgres.query('SELECT 1'));

      expect(rows).toEqual([{ ok: true }]);
      expect(poolClient.query.mock.calls).toEqual([['SELECT 1', []]]);
      expect(poolClient.release).toHaveBeenCalledTimes(1);
    } finally {
      if (original) {
        Object.defineProperty(process, 'type', original);
      } else {
        delete (process as any).type;
      }
    }
  });
});
