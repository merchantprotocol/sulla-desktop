import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../PostgresClient';
import { up as createWorkflows } from '../../migrations/0023_create_workflows_table';
import { up as createWorkItems } from '../../migrations/0044_create_work_items_tables';
import { up as addCoreWorkflowFields } from '../../migrations/0055_add_system_and_content_hash_to_workflows';
import { up as createLaneDefinitions } from '../../migrations/0069_create_work_lane_definitions';
import { up as createLaneWorkflowBindings } from '../../migrations/0070_create_lane_workflow_bindings';
import {
  LANE_ENTRY_INPUT_ENVELOPE, LANE_OUTCOME_OUTPUT_ENVELOPE,
  WorkLaneWorkflowBindingModel,
} from '../WorkLaneWorkflowBindingModel';

const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const describeWithPostgres = connectionString ? describe : describe.skip;

describeWithPostgres('WorkLaneWorkflowBindingModel migrated PostgreSQL integration', () => {
  let pool: Pool;
  const originalQuery = postgresClient.query;
  const originalQueryOne = postgresClient.queryOne;
  const originalTransaction = postgresClient.transaction;

  beforeAll(async() => {
    pool = new Pool({ connectionString, max: 8 });
    await pool.query(createWorkflows);
    await pool.query(addCoreWorkflowFields);
    await pool.query(createWorkItems);
    await pool.query(createLaneDefinitions);
    await pool.query(createLaneWorkflowBindings);

    (postgresClient as any).query = async(text: string, params: unknown[] = []) =>
      (await pool.query(text, params)).rows;
    (postgresClient as any).queryOne = async(text: string, params: unknown[] = []) =>
      (await pool.query(text, params)).rows[0] ?? null;
    (postgresClient as any).transaction = async(callback: (client: any) => Promise<unknown>) => {
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
    };

    const contract = {
      laneKeys:      ['todo', 'in_review'],
      semanticRoles: ['execution', 'review'],
      input:         LANE_ENTRY_INPUT_ENVELOPE,
      output:        LANE_OUTCOME_OUTPUT_ENVELOPE,
    };
    await pool.query(`
      INSERT INTO work_projects (id, slug, title) VALUES ('project-1', 'project-1', 'Project 1');
      INSERT INTO work_epics (id, project_id, title) VALUES ('epic-1', 'project-1', 'Epic 1');
      INSERT INTO work_tasks (id, project_id, epic_id, title) VALUES ('task-1', 'project-1', 'epic-1', 'Task 1');
      INSERT INTO work_lane_definitions
        (id, lane_key, scope, display_name, semantic_role, system_required)
      VALUES
        ('lane-todo', 'todo', 'global_default', 'Todo', 'execution', true),
        ('lane-review', 'in_review', 'global_default', 'Review', 'review', true);
    `);
    await pool.query(`
      INSERT INTO workflows (id, name, status, enabled, system, definition)
      VALUES ('workflow-1', 'Workflow 1', 'production', true, false, $1::jsonb);
    `, [JSON.stringify({ laneContract: contract, revision: 1 })]);
    await WorkLaneWorkflowBindingModel.set({
      scope: 'global', workflowId: 'workflow-1', laneKey: 'todo', actor: 'integration-test',
    });
    await WorkLaneWorkflowBindingModel.set({
      scope: 'global', workflowId: 'workflow-1', laneKey: 'in_review', actor: 'integration-test',
    });
  }, 30_000);

  afterAll(async() => {
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).queryOne = originalQueryOne;
    (postgresClient as any).transaction = originalTransaction;
    await pool?.end();
  });

  it('serializes concurrent duplicates, records re-entry generations, and keeps immutable snapshots', async() => {
    const duplicateClaims = await Promise.all(Array.from({ length: 12 }, () =>
      WorkLaneWorkflowBindingModel.claimLaneEntry('task-1', 'todo', 'integration-test')));

    expect(duplicateClaims.filter(result => result.created)).toHaveLength(1);
    expect(new Set(duplicateClaims.map(result => result.entry.id))).toEqual(new Set([duplicateClaims[0].entry.id]));
    expect(duplicateClaims[0].entry).toMatchObject({
      generation: 1,
      lane_key:   'todo',
      status:     'pending',
    });

    const firstSnapshot = duplicateClaims[0].entry.workflow_snapshot;
    await pool.query(`
      UPDATE workflows
         SET definition = jsonb_set(definition, '{revision}', '2'::jsonb)
       WHERE id = 'workflow-1'
    `);

    const review = await WorkLaneWorkflowBindingModel.claimLaneEntry('task-1', 'in_review', 'integration-test');
    const todoAgain = await WorkLaneWorkflowBindingModel.claimLaneEntry('task-1', 'todo', 'integration-test');
    const duplicateTodo = await WorkLaneWorkflowBindingModel.claimLaneEntry('task-1', 'todo', 'integration-test');

    expect(review).toMatchObject({ created: true, entry: { generation: 2, previous_lane_key: 'todo', lane_key: 'in_review' } });
    expect(todoAgain).toMatchObject({ created: true, entry: { generation: 3, previous_lane_key: 'in_review', lane_key: 'todo' } });
    expect(duplicateTodo).toMatchObject({ created: false, entry: { id: todoAgain.entry.id, generation: 3 } });

    const entries = await WorkLaneWorkflowBindingModel.listLaneEntries('task-1');
    expect(entries.map(entry => entry.generation)).toEqual([3, 2, 1]);
    expect(firstSnapshot).toMatchObject({ revision: 1 });
    expect(entries.find(entry => entry.generation === 1)?.workflow_snapshot).toEqual(firstSnapshot);
    expect(entries.find(entry => entry.generation === 2)?.workflow_snapshot).toMatchObject({ revision: 2 });
  }, 30_000);
});
