import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { migrationsRegistry } from '../../migrations';
import { up } from '../../migrations/0063_create_work_item_knowledge_links';
import { KnowledgeGraphModel } from '../KnowledgeGraphModel';
import { WorkItemKnowledgeModel } from '../WorkItemKnowledgeModel';

describe('work item knowledge associations', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('ships FK integrity, exactly-one-target, soft archive, and per-target active uniqueness', () => {
    expect(migrationsRegistry.at(-1)?.name).toBe('0063_create_work_item_knowledge_links');
    expect(up).toContain('knowledge_node_id TEXT        NOT NULL REFERENCES knowledge_nodes(id)');
    expect(up).toContain('project_id        TEXT        REFERENCES work_projects(id)');
    expect(up).toContain('epic_id           TEXT        REFERENCES work_epics(id)');
    expect(up).toContain('task_id           TEXT        REFERENCES work_tasks(id)');
    expect(up).toContain('num_nonnulls(project_id, epic_id, task_id) = 1');
    expect(up).toContain('archived          BOOLEAN     NOT NULL DEFAULT false');
    expect(up).toContain('updated_by        TEXT');
    expect(up.match(/CREATE UNIQUE INDEX IF NOT EXISTS idx_wikl_active_/g)).toHaveLength(3);
    expect(up.match(/WHERE .* archived = false/g)).toHaveLength(3);
  });

  it('serializes competing attaches and restores a matching archived link', async() => {
    const restored = { id: 'link-1', archived: false, knowledge_node_id: 'canonical' };
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ id: 'canonical', archived: false, merged_into: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1', archived: false }] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{ id: 'link-1', archived: true, note: null }] })
      .mockResolvedValueOnce({ rows: [restored] });
    jest.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => callback({ query }));

    const result = await WorkItemKnowledgeModel.link({
      itemKind: 'task', itemId: 'task-1', knowledgeNodeId: 'merged-node', actor: 'scribe',
    });

    expect(result).toBe(restored);
    expect(query.mock.calls[2][0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[3][0]).toContain('ORDER BY archived ASC');
    expect(query.mock.calls[4][0]).toContain('SET archived = false');
    expect(query.mock.calls[4][1][3]).toBe('scribe');
  });

  it('computes task inheritance at read time in direct, epic, project order without writes', async() => {
    jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({ archived: false });
    const query = jest.spyOn(postgresClient, 'query').mockResolvedValue([]);
    await WorkItemKnowledgeModel.listForItem('task', 'task-1', { includeInherited: true, limit: 17 });
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("SELECT t.id, 'task'::text kind");
    expect(sql).toContain("SELECT e.id, 'epic'");
    expect(sql).toContain("SELECT p.id, 'project'");
    expect(sql).toContain("CASE WHEN l.ord = 0 THEN 'direct' ELSE 'inherited' END scope");
    expect(sql).toContain('ORDER BY l.ord ASC');
    expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/);
    expect(query.mock.calls[0][1]).toEqual(['task-1', true, false, null, 17]);
  });

  it('bounds reverse lookup and returns hierarchy ancestry without N+1 queries', async() => {
    jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({ id: 'node-1', archived: false });
    const query = jest.spyOn(postgresClient, 'query').mockResolvedValue([]);
    await WorkItemKnowledgeModel.listForNode('node-1', { limit: 5000 });
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('project_title');
    expect(sql).toContain('epic_title');
    expect(sql).toContain('LIMIT $4');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]?.[3]).toBe(200);
  });

  it('fails closed for invalid work kinds and missing node or item ids', async() => {
    await expect(WorkItemKnowledgeModel.listForItem('bogus' as any, 'x')).rejects.toThrow('Invalid item_kind');
    jest.spyOn(postgresClient, 'queryOne').mockResolvedValue(null);
    await expect(WorkItemKnowledgeModel.listForItem('task', 'missing')).rejects.toThrow('task not found');
    await expect(WorkItemKnowledgeModel.listForNode('missing')).rejects.toThrow('Knowledge node not found');
  });

  it('fails unlink closed for missing and archived targets before touching links', async() => {
    const lookup = jest.spyOn(postgresClient, 'queryOne');
    lookup.mockResolvedValueOnce(null);
    await expect(WorkItemKnowledgeModel.unlink({
      itemKind: 'task', itemId: 'missing', knowledgeNodeId: 'node-1',
    })).rejects.toThrow('task not found: missing');

    lookup.mockResolvedValueOnce({ archived: true });
    await expect(WorkItemKnowledgeModel.unlink({
      itemKind: 'epic', itemId: 'archived', knowledgeNodeId: 'node-1',
    })).rejects.toThrow('epic is archived: archived');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('canonicalizes and deduplicates work links during a node merge', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({
        rows: [
          { id: 'source', archived: false, merged_into: null },
          { id: 'canonical', archived: false, merged_into: null },
        ],
      })
      .mockResolvedValue({ rows: [] });
    jest.spyOn(postgresClient, 'transaction').mockImplementation((callback: any) => callback({ query }));
    await KnowledgeGraphModel.mergeNode('source', 'canonical');
    expect(query.mock.calls[1][0]).toContain('UPDATE work_item_knowledge_links');
    expect(query.mock.calls[1][0]).toContain('NOT EXISTS');
    expect(query.mock.calls[2][0]).toContain('SET archived = true');
  });
});
