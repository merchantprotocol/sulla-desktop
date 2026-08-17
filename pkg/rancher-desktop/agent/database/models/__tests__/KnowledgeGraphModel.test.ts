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

  it('recallByTerms resolves, spreads, fetches, and bumps nodes without touching node_links', async() => {
    const client: any = {
      query: jest.fn((sql: string, params?: any[]) => {
        if (sql.startsWith('SET LOCAL statement_timeout')) {
          expect(sql).toBe('SET LOCAL statement_timeout = 3000');
          return Promise.resolve({ rows: [] });
        }

        expect(sql).toContain('WITH RECURSIVE input_terms AS');
        expect(sql).toContain('JOIN node_aliases a');
        expect(sql).toContain('WITH RECURSIVE input_terms AS');
        expect(sql).toContain('UPDATE knowledge_nodes n');
        expect(sql).toContain('recall_count = n.recall_count + 1');
        expect(sql).not.toMatch(/UPDATE\s+node_links/i);
        expect(sql).not.toMatch(/INSERT\s+INTO\s+node_links/i);
        expect(params).toEqual([['Issue #517', 'voice recall'], 2, 0.5, 0, 12]);

        return Promise.resolve({
          rows: [{
            id:                 'issue-517',
            node_type:          'issue',
            title:              'GitHub issue #517',
            summary:            'Recall agent graph retrieval',
            detail:             null,
            link_count:         8,
            recall_count:       4,
            last_recalled_at:   null,
            archived:           false,
            merged_into:        null,
            source:             'test',
            created_at:         '2026-07-30T00:00:00.000Z',
            updated_at:         '2026-07-30T00:00:00.000Z',
            activation:         1,
            hop:                0,
          }],
        });
      }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => Promise.resolve(callback(client)));

    const rows = await KnowledgeGraphModel.recallByTerms(['Issue #517', 'voice recall', 'Issue #517']);

    expect(postgresClient.transaction).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'issue-517', activation: 1, hop: 0 });
  });

  it('writeEpisode rejects a missing event.title without opening a transaction', async() => {
    (postgresClient as any).transaction = jest.fn();
    (postgresClient as any).query = jest.fn();

    await expect(KnowledgeGraphModel.writeEpisode({ event: { title: '   ' } } as any))
      .rejects.toThrow('writeEpisode: event.title is required');
    expect(postgresClient.transaction).not.toHaveBeenCalled();
    expect(postgresClient.query).not.toHaveBeenCalled();
  });

  it('writeEpisode creates event/project/lesson/blocker/entity and Hebbian-reinforces a pair in one transaction', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([])); // resolveAliases → no reuse

    const client: any = {
      query: jest.fn((sql: string) => {
        if (sql.includes('INSERT INTO knowledge_nodes')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO node_aliases')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO node_links')) return Promise.resolve({ rows: [{ was_inserted: true }] });
        if (sql.includes('UPDATE knowledge_nodes')) return Promise.resolve({ rows: [] });
        if (sql.includes("relation_type = 'related_to'")) return Promise.resolve({ rows: [{ ok: true }] });
        return Promise.resolve({ rows: [] });
      }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => Promise.resolve(callback(client)));

    const result = await KnowledgeGraphModel.writeEpisode({
      source:  'heartbeat',
      project: { title: 'Sulla Desktop', aliases: ['sulla-desktop'] },
      event:   { title: 'Rebased episodic scribe onto main', summary: 'Writer half now sits on d6eed29ea.' },
      lessons: [{ title: 'Rebase isolated worktrees, never the dirty primary checkout' }],
      blockers: [{ title: 'Primary checkout is dirty on feat/projects-workboard' }],
      entities: [{ title: 'EpisodicScribe' }],
      reinforcePairs: [['Sulla Desktop', 'EpisodicScribe']],
    });

    expect(postgresClient.transaction).toHaveBeenCalledTimes(1);
    expect(result.createdNodes).toBe(5); // project + event + lesson + blocker + entity
    expect(result.reusedNodes).toBe(0);
    expect(result.linksCreated).toBe(5); // belongs_to, learned_from, blocked_by, mentioned_in, related_to
    expect(result.reinforced).toBe(1);
    expect(result.episodeId).toMatch(/^evt_/);
    expect(result.nodeIds).toHaveLength(5);

    const inserts = client.query.mock.calls.filter((c: any[]) => String(c[0]).includes('INSERT INTO knowledge_nodes'));
    expect(inserts).toHaveLength(5);
    const types = inserts.map((c: any[]) => c[1][1]).sort();
    expect(types).toEqual(['blocker', 'entity', 'event', 'lesson', 'project']);
    expect(inserts.some((c: any[]) => c[1][5] === 'heartbeat')).toBe(true);

    const rels = client.query.mock.calls
      .filter((c: any[]) => String(c[0]).includes('INSERT INTO node_links'))
      .map((c: any[]) => c[1][2])
      .sort();
    expect(rels).toEqual(['belongs_to', 'blocked_by', 'learned_from', 'mentioned_in', 'related_to']);
  });

  it('writeEpisode stores provenance metadata and mirrors recall anchors', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([])); // resolveAliases → no reuse

    const client: any = {
      query: jest.fn((sql: string) => {
        if (sql.includes('INSERT INTO node_links')) return Promise.resolve({ rows: [{ was_inserted: true }] });
        if (sql.includes("relation_type = 'related_to'")) return Promise.resolve({ rows: [{ ok: true }] });
        return Promise.resolve({ rows: [] });
      }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => Promise.resolve(callback(client)));

    const result = await KnowledgeGraphModel.writeEpisode({
      source:   'heartbeat',
      metadata: {
        projectId:            'trXJ',
        epicId:               'iK4o',
        taskId:               'Yrn7',
        repo:                 '/Users/jonathonbyrdziak/Sites/sulla/sulla-desktop',
        artifact:             'pkg/rancher-desktop/agent/database/models/KnowledgeGraphModel.ts',
        timestamp:            '2026-08-17T13:25:00.000Z',
        sourceConversationId: 'conv_heartbeat_1786973100000',
        commitSha:            'abc1234',
        githubIssue:          '#518',
      },
      project: { title: 'Sulla Desktop' },
      event:   { title: 'Verified episodic memory write and recall', summary: 'Metadata anchors were made durable.' },
    });

    expect(result.createdNodes).toBe(10); // project + event + 8 metadata anchors

    const nodeInserts = client.query.mock.calls.filter((c: any[]) => String(c[0]).includes('INSERT INTO knowledge_nodes'));
    const eventInsert = nodeInserts.find((c: any[]) => c[1][1] === 'event');
    expect(eventInsert?.[1][4]).toContain('"taskId":"Yrn7"');
    expect(eventInsert?.[1][4]).toContain('"sourceConversationId":"conv_heartbeat_1786973100000"');

    const insertedTitles = nodeInserts.map((c: any[]) => c[1][2]);
    expect(insertedTitles).toEqual(expect.arrayContaining([
      'Yrn7',
      '/Users/jonathonbyrdziak/Sites/sulla/sulla-desktop',
      'pkg/rancher-desktop/agent/database/models/KnowledgeGraphModel.ts',
      'conv_heartbeat_1786973100000',
      '#518',
    ]));

    const aliases = client.query.mock.calls
      .filter((c: any[]) => String(c[0]).includes('INSERT INTO node_aliases'))
      .map((c: any[]) => c[1][0]);
    expect(aliases).toEqual(expect.arrayContaining(['task Yrn7', 'work task Yrn7', 'epic iK4o', 'project trXJ']));
  });

  it('writeEpisode reuses a project whose alias sim is ≥ 0.85 and still creates a fresh event', async() => {
    (postgresClient as any).query = jest.fn((_sql: string, params: any[]) => {
      const terms: string[] = params?.[0] ?? [];
      if (terms.some((t: string) => /sulla desktop/i.test(t))) {
        return Promise.resolve([{
          node_id: 'kn_sulladesktop', title: 'Sulla Desktop', node_type: 'project',
          alias: 'Sulla Desktop', match: 'exact', sim: 0.97,
        }]);
      }
      return Promise.resolve([]);
    });

    const client: any = {
      query: jest.fn((sql: string) => {
        if (sql.includes('INSERT INTO node_links')) return Promise.resolve({ rows: [{ was_inserted: true }] });
        return Promise.resolve({ rows: [] });
      }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => Promise.resolve(callback(client)));

    const result = await KnowledgeGraphModel.writeEpisode({
      project: { title: 'Sulla Desktop' },
      event:   { title: 'Cycle shipped the scribe rebase' },
    });

    expect(result.createdNodes).toBe(1); // event only
    expect(result.reusedNodes).toBe(1);  // project
    expect(result.nodeIds).toContain('kn_sulladesktop');
    expect(result.episodeId).not.toBe('kn_sulladesktop');
    expect(result.linksCreated).toBe(1); // event belongs_to reused project
  });

  it('writeEpisode does not reuse a fuzzy match below the 0.85 bar', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([{
      node_id: 'kn_other', title: 'Sulla Mobile', node_type: 'project',
      alias: 'Sulla', match: 'fuzzy', sim: 0.62,
    }]));

    const client: any = {
      query: jest.fn((sql: string) => {
        if (sql.includes('INSERT INTO node_links')) return Promise.resolve({ rows: [{ was_inserted: true }] });
        return Promise.resolve({ rows: [] });
      }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => Promise.resolve(callback(client)));

    const result = await KnowledgeGraphModel.writeEpisode({
      project: { title: 'Sulla Desktop' },
      event:   { title: 'Did not collide with Sulla Mobile' },
    });

    expect(result.createdNodes).toBe(2);
    expect(result.reusedNodes).toBe(0);
    expect(result.nodeIds).not.toContain('kn_other');
  });
});
