import { TextDecoder, TextEncoder } from 'node:util';

import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

async function loadPgModules() {
  const pgQueryModule = await import('../pg_query');
  const pgQueryAllModule = await import('../pg_queryall');
  const pgQueryOneModule = await import('../pg_queryone');
  const pgExecuteModule = await import('../pg_execute');
  const postgresModule = await import('../../../database/PostgresClient');

  return {
    pgQueryModule,
    pgQueryAllModule,
    pgQueryOneModule,
    pgExecuteModule,
    postgresClient: postgresModule.postgresClient as any,
  };
}

describe('pg_query / pg_execute sql field handling', () => {
  let postgresClient: any;
  let originalQuery: any;
  let originalQueryAll: any;
  let originalQueryOne: any;
  let originalQueryWithResult: any;

  beforeAll(async() => {
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;

    const modules = await loadPgModules();
    postgresClient = modules.postgresClient;
    originalQuery = postgresClient.query;
    originalQueryAll = postgresClient.queryAll;
    originalQueryOne = postgresClient.queryOne;
    originalQueryWithResult = postgresClient.queryWithResult;
  });

  afterEach(() => {
    postgresClient.query = originalQuery;
    postgresClient.queryAll = originalQueryAll;
    postgresClient.queryOne = originalQueryOne;
    postgresClient.queryWithResult = originalQueryWithResult;
  });

  it('pg_query accepts query alias and long SQL strings without schema rejection', async() => {
    const { pgQueryModule } = await loadPgModules();

    postgresClient.query = jest.fn(async() => [{ id: 1, name: 'alpha' }]);

    const worker = configureWorker(new pgQueryModule.PgQueryWorker(), pgQueryModule.pgQueryRegistration);
    const longSql = `SELECT 1 AS one -- ${ 'x'.repeat(12000) }`;

    const result = await worker.invoke({
      query:  longSql,
      params: [],
    });

    expect(result.success).toBe(true);
    expect(postgresClient.query).toHaveBeenCalledTimes(1);
    expect(postgresClient.query).toHaveBeenCalledWith(longSql.trim(), []);
    expect(result.result as string).toContain('Rows Returned: 1');
    expect(result.result as string).toContain('"id": 1');
    expect(result.result as string).toContain('"name": "alpha"');
  });

  it('pg_query safely handles undefined query results without crashing', async() => {
    const { pgQueryModule } = await loadPgModules();

    postgresClient.query = jest.fn(async() => undefined);

    const worker = configureWorker(new pgQueryModule.PgQueryWorker(), pgQueryModule.pgQueryRegistration);
    const result = await worker.invoke({ sql: 'SELECT 1', params: [] });

    expect(result.success).toBe(true);
    expect(result.result as string).toContain('Rows Returned: 0');
    expect(result.result as string).toContain('Rows: []');
  });

  it('pg_queryall includes result rows in output', async() => {
    const { pgQueryAllModule } = await loadPgModules();

    postgresClient.queryAll = jest.fn(async() => [
      { id: 1, value: 'a' },
      { id: 2, value: 'b' },
    ]);

    const worker = configureWorker(new pgQueryAllModule.PgQueryAllWorker(), pgQueryAllModule.pgQueryAllRegistration);
    const result = await worker.invoke({ sql: 'SELECT id, value FROM table_x', params: [] });

    expect(result.success).toBe(true);
    expect(result.result as string).toContain('Rows Returned: 2');
    expect(result.result as string).toContain('"id": 1');
    expect(result.result as string).toContain('"value": "b"');
  });

  it('pg_queryone includes returned row in output', async() => {
    const { pgQueryOneModule } = await loadPgModules();

    postgresClient.queryOne = jest.fn(async() => ({ id: 42, status: 'ok' }));

    const worker = configureWorker(new pgQueryOneModule.PgQueryOneWorker(), pgQueryOneModule.pgQueryOneRegistration);
    const result = await worker.invoke({ sql: 'SELECT id, status FROM table_x LIMIT 1', params: [] });

    expect(result.success).toBe(true);
    expect(result.result as string).toContain('Row Returned: Yes');
    expect(result.result as string).toContain('"id": 42');
    expect(result.result as string).toContain('"status": "ok"');
  });

  it('pg_execute accepts statement alias in nested input payloads', async() => {
    const { pgExecuteModule } = await loadPgModules();

    postgresClient.queryWithResult = jest.fn(async() => ({
      command:  'UPDATE',
      rowCount: 1,
      rows:     [{ id: 1, touched: true }],
      oid:      null,
    }));

    const worker = configureWorker(new pgExecuteModule.PgExecuteWorker(), pgExecuteModule.pgExecuteRegistration);

    const result = await worker.invoke({
      input: {
        statement: 'UPDATE test_table SET touched = true WHERE id = 1',
        params:    [],
      },
    });

    expect(result.success).toBe(true);
    expect(postgresClient.queryWithResult).toHaveBeenCalledTimes(1);
    expect(postgresClient.queryWithResult).toHaveBeenCalledWith('UPDATE test_table SET touched = true WHERE id = 1', []);
    expect(result.result as string).toContain('Rows Affected: 1');
    expect(result.result as string).toContain('"touched": true');
  });

  it('pg_execute reports clear SQL error only when no alias field is present', async() => {
    const { pgExecuteModule } = await loadPgModules();

    const worker = configureWorker(new pgExecuteModule.PgExecuteWorker(), pgExecuteModule.pgExecuteRegistration);
    const result = await worker.invoke({ params: [] });

    expect(result.success).toBe(false);
    expect(result.result as string).toContain('Missing SQL statement');
    expect(result.result as string).not.toContain('Missing required field: sql');
  });
});
