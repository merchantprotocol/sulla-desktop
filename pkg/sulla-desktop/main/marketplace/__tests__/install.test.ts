/**
 * @jest-environment node
 */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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
let installStandaloneArtifact: typeof import('../databaseInstaller').installStandaloneArtifact;

beforeAll(async() => {
  ({ installPackageManifest, installStandaloneArtifact } = await import('../databaseInstaller'));
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

describe('legacy marketplace integration install', () => {
  it('keeps YAML catalog integrations on integration_definitions with their manifest file intact', async() => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const database = {
      transaction: jest.fn(async(callback: (client: any) => Promise<any>) => callback({
        query: jest.fn(async(sql: string, params: unknown[]) => {
          queries.push({ sql, params });
          if (/^SELECT/.test(sql.trim())) return { rowCount: 0, rows: [] };
          return { rowCount: 1, rows: [] };
        }),
      })),
    };
    const manifest = {
      apiVersion: 'sulla/v1', kind: 'Integration', id: 'legacy-acme', name: 'Legacy Acme',
      description: 'Existing YAML catalog entry', category: 'Developer Tools', version: '1.0.0',
    };
    const files = { 'integration.yaml': 'apiVersion: sulla/v1\nkind: Integration\nid: legacy-acme\n' };

    await installStandaloneArtifact({
      id: 'tpl-legacy', kind: 'integration', slug: 'legacy-acme', version: '1.0.0', name: 'Legacy Acme',
    } as any, { manifest, files }, false, database as any);

    const insert = queries.find(query => query.sql.includes('INSERT INTO integration_definitions'));
    expect(insert).toBeDefined();
    expect(insert?.params[4]).toBe(JSON.stringify(files));
    expect(queries.some(query => query.sql.includes('integration_packages'))).toBe(false);
  });
});
