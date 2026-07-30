import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { KnowledgeGraphModel } from '../KnowledgeGraphModel';

describe('KnowledgeGraphModel', () => {
  let originalQuery: any;
  let originalQueryOne: any;
  let originalQueryWithResult: any;
  let originalTransaction: any;

  beforeAll(() => {
    originalQuery = postgresClient.query;
    originalQueryOne = postgresClient.queryOne;
    originalQueryWithResult = postgresClient.queryWithResult;
    originalTransaction = postgresClient.transaction;
  });

  afterEach(() => {
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).queryOne = originalQueryOne;
    (postgresClient as any).queryWithResult = originalQueryWithResult;
    (postgresClient as any).transaction = originalTransaction;
    jest.restoreAllMocks();
  });

  it('inserts a node, stores a normalized alias, and resolves aliases round-trip', async() => {
    (postgresClient as any).queryOne = jest.fn((sql: string, params: any[]) => {
      if (sql.includes('INSERT INTO knowledge_nodes')) {
        return Promise.resolve({
          id:                 params[0],
          node_type:          params[1],
          title:              params[2],
          summary:            params[3],
          detail:             params[4],
          source:             params[5],
          archived:           params[6],
          merged_into:        params[7],
          link_count:         0,
          recall_count:       0,
          last_recalled_at:   null,
          created_at:         '2026-07-29T00:00:00.000Z',
          updated_at:         '2026-07-29T00:00:00.000Z',
        });
      }
      if (sql.includes('INSERT INTO node_aliases')) {
        return Promise.resolve({
          alias:      params[0],
          alias_norm: 'ripplecore',
          node_id:    params[1],
        });
      }
      return Promise.resolve(null);
    });
    (postgresClient as any).query = jest.fn(() => Promise.resolve([{
      node_id:   'node-1',
      title:     'RippleCore',
      node_type: 'entity',
      alias:     'RippleCore',
      match:     'exact',
      sim:       1,
    }]));

    const node = await KnowledgeGraphModel.upsertNode({
      id:         'node-1',
      title:      'RippleCore',
      summary:    'Core Data Ripple project',
      node_type:  'entity',
      source:     'test',
    });
    const alias = await KnowledgeGraphModel.addAlias(node.id, 'Ripple-Core');
    const resolved = await KnowledgeGraphModel.resolveAliases(['RippleCore', 'ripple-core']);

    expect(node.id).toBe('node-1');
    expect(alias.alias_norm).toBe('ripplecore');
    expect(postgresClient.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('VALUES ($1, norm_alias($1), $2)'),
      ['Ripple-Core', 'node-1'],
    );
    expect(postgresClient.query).toHaveBeenCalledWith(
      expect.stringContaining('norm_alias(term) AS term_norm'),
      [['RippleCore', 'ripple-core']],
    );
    expect(resolved).toEqual([{
      node_id:   'node-1',
      title:     'RippleCore',
      node_type: 'entity',
      alias:     'RippleCore',
      match:     'exact',
      sim:       1,
    }]);
  });

  it('normalizes aliases through the database norm_alias function', async() => {
    (postgresClient as any).queryOne = jest.fn((sql: string, params: any[]) => Promise.resolve({
      alias:      params[0],
      alias_norm: 'cafe#12',
      node_id:    params[1],
    }));

    const alias = await KnowledgeGraphModel.addAlias('node-cafe', 'Café #12!');

    expect(alias.alias_norm).toBe('cafe#12');
    expect(postgresClient.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('norm_alias($1)'),
      ['Café #12!', 'node-cafe'],
    );
  });

  it('maintains link_count in the same statement when inserting links', async() => {
    const client: any = {
      query: jest.fn((sql: string) => {
        expect(sql).toContain('WITH inserted AS');
        expect(sql).toContain('UPDATE knowledge_nodes n');
        expect(sql).toContain('SET link_count = link_count + 1');
        expect(sql).toContain('WHERE i.was_inserted');
        expect(sql).toContain('n.id IN (i.src_id, i.dst_id)');
        return Promise.resolve({
          rows: [{
            src_id:         'a',
            dst_id:         'b',
            relation_type:  'belongs_to',
            strength:       0.4,
            fire_count:     0,
            last_fired_at:  null,
            confirmed:      false,
            created_at:     '2026-07-29T00:00:00.000Z',
          }],
        });
      }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => Promise.resolve(callback(client)));

    const link = await KnowledgeGraphModel.linkNodes('a', 'b', 'belongs_to', 0.4);

    expect(link.src_id).toBe('a');
    expect(link.dst_id).toBe('b');
    expect(postgresClient.transaction).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(expect.any(String), ['a', 'b', 'belongs_to', 0.4]);
  });

  it('reinforces links using strength + 0.2 * (1 - strength)', async() => {
    (postgresClient as any).queryOne = jest.fn((sql: string, params: any[]) => {
      expect(sql).toContain('strength = strength + 0.2 * (1 - strength)');
      expect(sql).toContain('fire_count = fire_count + 1');
      expect(sql).toContain('last_fired_at = now()');
      expect(params).toEqual(['a', 'b', 'related_to']);
      return Promise.resolve({
        src_id:         'a',
        dst_id:         'b',
        relation_type:  'related_to',
        strength:       0.44,
        fire_count:     2,
        last_fired_at:  '2026-07-29T00:00:00.000Z',
        confirmed:      false,
        created_at:     '2026-07-29T00:00:00.000Z',
      });
    });

    const reinforced = await KnowledgeGraphModel.reinforceLink('a', 'b');

    expect(reinforced.strength).toBeCloseTo(0.44);
    expect(reinforced.fire_count).toBe(2);
  });

  it('bumps recall counters and soft-archives nodes', async() => {
    (postgresClient as any).query = jest.fn((_sql: string, params: any[]) => Promise.resolve(params[0].map((id: string) => ({
      id,
      recall_count:     1,
      last_recalled_at: '2026-07-29T00:00:00.000Z',
    }))));
    (postgresClient as any).queryWithResult = jest.fn(() => Promise.resolve({
      rowCount: 1,
      rows:     [],
      command:  'UPDATE',
      oid:      0,
      fields:   [],
    }));

    const recalled = await KnowledgeGraphModel.bumpRecalled(['a', 'b', 'a', '']);
    const archived = await KnowledgeGraphModel.archiveNode('a');

    expect(postgresClient.query).toHaveBeenCalledWith(
      expect.stringContaining('recall_count = recall_count + 1'),
      [['a', 'b']],
    );
    expect(recalled).toHaveLength(2);
    expect(archived).toBe(true);
    expect(postgresClient.queryWithResult).toHaveBeenCalledWith(
      expect.stringContaining('SET archived = true'),
      ['a'],
    );
  });

  it('spreadActivation short-circuits on empty/blank anchors without querying', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    const rows = await KnowledgeGraphModel.spreadActivation(['', '   ']);

    expect(rows).toEqual([]);
    expect(postgresClient.query).not.toHaveBeenCalled();
  });

  it('spreadActivation dedupes anchors and forwards traversal params in order', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([
      { id: 'a', activation: 1, hop: 0 },
      { id: 'b', activation: 0.4, hop: 1 },
    ]));

    const rows = await KnowledgeGraphModel.spreadActivation(
      ['a', 'a', ' b '],
      { maxHops: 2, decay: 0.5, minEdge: 0.1, limit: 8 },
    );

    // Recursive spreading-activation CTE, not an agent loop.
    expect(postgresClient.query).toHaveBeenCalledWith(
      expect.stringContaining('WITH RECURSIVE anchors AS'),
      [['a', 'b'], 2, 0.5, 0.1, 8],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'a', hop: 0, activation: 1 });
  });

  it('spreadActivation applies the ≤2-hop and limit defaults', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await KnowledgeGraphModel.spreadActivation(['a']);

    expect(postgresClient.query).toHaveBeenCalledWith(
      expect.any(String),
      [['a'], 2, 0.5, 0, 12],
    );
  });
});
