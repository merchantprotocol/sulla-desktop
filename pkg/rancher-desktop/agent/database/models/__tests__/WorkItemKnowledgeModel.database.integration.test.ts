/** @jest-environment node */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../PostgresClient';
import { up as knowledgeGraphMigration } from '../../migrations/0029_create_knowledge_graph';
import { up as workItemsMigration } from '../../migrations/0044_create_work_items_tables';
import { up as associationMigration } from '../../migrations/0063_create_work_item_knowledge_links';
import { WorkItemKnowledgeModel } from '../WorkItemKnowledgeModel';

import mockModules from '@pkg/utils/testUtils/mockModules';

mockModules({
  electron:            undefined,
  '@pkg/main/ipcMain': { getIpcMainProxy: () => ({ handle: jest.fn() }) },
});

const databaseUrl = process.env.SULLA_ASSOCIATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('work item knowledge associations on a migrated PostgreSQL database', () => {
  let pool: Pool;

  function routeModelToTestDatabase() {
    jest.spyOn(postgresClient, 'query').mockImplementation(async(text: string, params: any[] = []) => {
      const result = await pool.query(text, params);
      return result.rows as any;
    });
    jest.spyOn(postgresClient, 'queryOne').mockImplementation(async(text: string, params: any[] = []) => {
      const result = await pool.query(text, params);
      return (result.rows[0] ?? null);
    });
    jest.spyOn(postgresClient, 'queryWithResult').mockImplementation((text: string, params: any[] = []) => pool.query(text, params) as any);
    jest.spyOn(postgresClient, 'transaction').mockImplementation(async(callback: any) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
  }

  beforeAll(async() => {
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await pool.query(knowledgeGraphMigration);
    await pool.query(workItemsMigration);
    await pool.query(associationMigration);
    await pool.query(`
      INSERT INTO work_projects (id, slug, title) VALUES ('p1', 'p1', 'Project One');
      INSERT INTO work_epics (id, project_id, slug, title) VALUES ('e1', 'p1', 'e1', 'Epic One');
      INSERT INTO work_tasks (id, project_id, epic_id, title) VALUES ('t1', 'p1', 'e1', 'Task One');
      INSERT INTO knowledge_nodes (id, title, summary) VALUES ('n1', 'Node One', 'Durable context');
    `);
    routeModelToTestDatabase();
  }, 30_000);

  afterAll(async() => {
    jest.restoreAllMocks();
    await pool?.end();
  });

  it('serializes a real concurrent attach, survives pool restart, and crosses runtime-facing adapters', async() => {
    const input = {
      itemKind:        'task' as const,
      itemId:          't1',
      knowledgeNodeId: 'n1',
      relationType:    'evidence',
      actor:           'integration-test',
      source:          'test',
    };
    const attempts = await Promise.all(Array.from({ length: 8 }, () => WorkItemKnowledgeModel.link(input)));
    expect(new Set(attempts.map(row => row.id)).size).toBe(1);
    await expect(pool.query(
      `SELECT count(*)::int count FROM work_item_knowledge_links
       WHERE knowledge_node_id = 'n1' AND task_id = 't1' AND relation_type = 'evidence' AND archived = false`,
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });

    await WorkItemKnowledgeModel.link({
      itemKind: 'project', itemId: 'p1', knowledgeNodeId: 'n1', relationType: 'context', actor: 'integration-test',
    });

    // A new pool simulates the application/database client boundary after restart.
    await pool.end();
    pool = new Pool({ connectionString: databaseUrl, max: 4 });

    const { listKnowledgeForWorkItem, listWorkForKnowledge, unlinkKnowledgeForWorkItem } = await import('../../../../main/workItemsEvents');
    const taskView = await listKnowledgeForWorkItem({ itemKind: 'task', itemId: 't1', includeInherited: true });
    expect(taskView.map(row => [row.relation_type, row.scope])).toEqual(expect.arrayContaining([
      ['evidence', 'direct'], ['context', 'inherited'],
    ]));
    const reverse = await listWorkForKnowledge({ knowledgeNodeId: 'n1' });
    expect(reverse.map(row => row.item_kind)).toEqual(expect.arrayContaining(['project', 'task']));

    await expect(unlinkKnowledgeForWorkItem(input)).resolves.toBe(true);
    const afterDetach = await listKnowledgeForWorkItem({ itemKind: 'task', itemId: 't1', includeInherited: true });
    expect(afterDetach).toHaveLength(1);
    expect(afterDetach[0]).toMatchObject({ relation_type: 'context', scope: 'inherited' });
  }, 30_000);
});
