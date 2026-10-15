/**
 * @jest-environment node
 */
import { beforeAll, describe, expect, it, jest } from '@jest/globals';

const committed = new Set<string>();

const postgresClient = {
  transaction: jest.fn(async(callback: (client: any) => Promise<any>) => {
    await Promise.resolve();
    const pending = new Set(committed);
    const client = {
      query: jest.fn(async(sql: string, params: unknown[]) => {
        await Promise.resolve();
        if (/^\s*SELECT/.test(sql)) return { rowCount: 0, rows: [] };
        if (sql.includes('INSERT INTO function_definitions')) {
          pending.add(`function:${ params[0] }`);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('INSERT INTO installed_packages')) {
          pending.add(`package:${ params[0] }`);
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      }),
    };
    const result = await callback(client);
    committed.clear();
    for (const value of pending) committed.add(value);
    return result;
  }),
  query: jest.fn(),
};

let installPackageManifest: typeof import('../databaseInstaller').installPackageManifest;

beforeAll(async() => {
  ({ installPackageManifest } = await import('../databaseInstaller'));
});

describe('atomic package install', () => {
  it('rolls back every preceding item when any contained item is invalid', async() => {
    committed.clear();

    await expect(installPackageManifest('tpl-package', {
      apiVersion: 'sulla/v1',
      kind:       'package',
      slug:       'sales-kit',
      name:       'Sales Kit',
      title:      'Close more deals',
      version:    '1.0.0',
      contents:   [
        {
          kind:     'function',
          slug:     'score-lead',
          version:  '1.0.0',
          manifest: {
            name:  'Score lead',
            spec:  { runtime: 'python', entrypoint: 'main.py::handler' },
            files: { 'main.py': 'def handler(inputs): return {"score": 1}' },
          },
        },
        {
          kind:     'recipe',
          slug:     'broken-crm',
          version:  '1.0.0',
          manifest: { id: 'broken-crm', name: 'Broken CRM' },
        },
      ],
    }, null, postgresClient as any)).rejects.toThrow('missing its compose file');

    expect(committed).toEqual(new Set());
    expect(postgresClient.transaction).toHaveBeenCalledTimes(1);
  });
});
