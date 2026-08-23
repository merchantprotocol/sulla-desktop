import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { KnowledgeGraphModel } from '../KnowledgeGraphModel';

describe('KnowledgeGraphModel #516 compatibility', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('retains the idempotent schema bootstrap and alias-resolution row contract', async() => {
    const query = jest.spyOn(postgresClient, 'query') as any;
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{
      node_id:   'node-1',
      title:     'RippleCore',
      node_type: 'entity',
      alias:     'RippleCore',
      match:     'exact',
      sim:       1,
    }]);

    await KnowledgeGraphModel.ensureSchema();
    const resolved = await KnowledgeGraphModel.resolveAliases(['RippleCore']);

    expect(query.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS knowledge_nodes');
    expect(query.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS node_aliases');
    expect(query.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS node_links');
    expect(query.mock.calls[1][0]).toContain("'exact'::text AS match");
    expect(resolved).toEqual([expect.objectContaining({ node_id: 'node-1', match: 'exact', sim: 1 })]);
    expect(resolved[0]).not.toHaveProperty('id');
  });

  it('retains #516 getNode behavior without silently filtering archived rows', async() => {
    const queryOne = jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({ id: 'archived', archived: true } as any);
    await expect(KnowledgeGraphModel.getNode('archived')).resolves.toMatchObject({ archived: true });
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 LIMIT 1'), ['archived']);
  });

  it('retains addAlias normalization and graph link/reinforcement APIs', async() => {
    jest.spyOn(postgresClient, 'queryOne')
      .mockResolvedValueOnce({ alias: 'Café #12!', alias_norm: 'cafe#12', node_id: 'node-a' })
      .mockResolvedValueOnce({ src_id: 'node-a', dst_id: 'node-b', relation_type: 'related_to', strength: 0.44 });
    const client = {
      query: jest.fn(() => Promise.resolve({
        rows: [{
          src_id: 'node-a', dst_id: 'node-b', relation_type: 'related_to', strength: 0.3,
        }],
      })),
    } as any;
    jest.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => callback(client));

    await expect(KnowledgeGraphModel.addAlias('node-a', 'Café #12!')).resolves.toMatchObject({ alias_norm: 'cafe#12' });
    await expect(KnowledgeGraphModel.linkNodes('node-a', 'node-b')).resolves.toMatchObject({ strength: 0.3 });
    await expect(KnowledgeGraphModel.reinforceLink('node-a', 'node-b')).resolves.toMatchObject({ strength: 0.44 });
    expect(client.query.mock.calls[0][0]).toContain('SET link_count = link_count + 1');
  });

  it('retains recall counters and soft archive behavior', async() => {
    jest.spyOn(postgresClient, 'query').mockResolvedValue([{ id: 'node-a', recall_count: 1 }] as any);
    jest.spyOn(postgresClient, 'queryWithResult').mockResolvedValue({ rowCount: 1 } as any);

    await expect(KnowledgeGraphModel.bumpRecalled(['node-a', 'node-a', ''])).resolves.toHaveLength(1);
    await expect(KnowledgeGraphModel.archiveNode('node-a')).resolves.toBe(true);
    expect(postgresClient.query).toHaveBeenCalledWith(expect.stringContaining('recall_count = recall_count + 1'), [['node-a']]);
  });

  it('adapts alias resolution to full nodes without changing resolveAliases', async() => {
    jest.spyOn(KnowledgeGraphModel, 'resolveAliases').mockResolvedValue([
      { node_id: 'node-b', title: 'B', node_type: 'entity', alias: 'B', match: 'exact', sim: 1 },
      { node_id: 'node-a', title: 'A', node_type: 'entity', alias: 'A', match: 'fuzzy', sim: 0.8 },
    ]);
    jest.spyOn(postgresClient, 'query').mockResolvedValue([
      { id: 'node-a', title: 'A' }, { id: 'node-b', title: 'B' },
    ] as any);

    const nodes = await KnowledgeGraphModel.resolveAliasNodes(['B', 'A']);
    expect(nodes.map(node => node.id)).toEqual(['node-b', 'node-a']);
  });
});
