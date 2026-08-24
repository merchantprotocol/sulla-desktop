import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';

import { LaneEntryAutomationService } from '../../../services/LaneEntryAutomationService';
import { postgresClient } from '../../PostgresClient';
import { up as createWorkflows } from '../../migrations/0023_create_workflows_table';
import { up as createWorkflowExecutions } from '../../migrations/0026_create_workflow_executions_table';
import { up as createWorkItems } from '../../migrations/0044_create_work_items_tables';
import { up as addWorkTaskActor } from '../../migrations/0047_add_work_task_actor';
import { up as addCoreWorkflowFields } from '../../migrations/0055_add_system_and_content_hash_to_workflows';
import { up as addWorkTaskActivity } from '../../migrations/0061_add_work_task_activity';
import { up as createLaneDefinitions } from '../../migrations/0069_create_work_lane_definitions';
import { up as createLaneWorkflowBindings } from '../../migrations/0070_create_lane_workflow_bindings';
import { up as scopeLaneWorkflowExecutions } from '../../migrations/0071_scope_lane_workflow_executions';
import { WorkItemsModel } from '../WorkItemsModel';
import {
  LANE_ENTRY_INPUT_ENVELOPE, LANE_OUTCOME_OUTPUT_ENVELOPE,
  WorkLaneWorkflowBindingModel,
} from '../WorkLaneWorkflowBindingModel';
import { WorkflowExecutionModel } from '../WorkflowExecutionModel';

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
    await pool.query(createWorkflowExecutions);
    await pool.query(addCoreWorkflowFields);
    await pool.query(createWorkItems);
    await pool.query(addWorkTaskActor);
    await pool.query(addWorkTaskActivity);
    await pool.query(createLaneDefinitions);
    await pool.query(createLaneWorkflowBindings);
    await pool.query(scopeLaneWorkflowExecutions);

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

  afterEach(() => {
    jest.restoreAllMocks();
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

  it('commits the task status and lane outbox claim atomically, and rolls both back on claim failure', async() => {
    await pool.query(`
      INSERT INTO work_tasks (id, project_id, epic_id, title, status)
      VALUES
        ('task-atomic', 'project-1', 'epic-1', 'Atomic task', 'backlog'),
        ('task-rollback', 'project-1', 'epic-1', 'Rollback task', 'backlog');
    `);
    jest.spyOn(LaneEntryAutomationService, 'dispatchEntry').mockImplementation(async(id) =>
      (await WorkLaneWorkflowBindingModel.getLaneEntry(id))!);

    await expect(WorkItemsModel.updateTask('task-atomic', {
      status: 'todo', actor: 'integration-test',
    })).resolves.toMatchObject({ status: 'todo' });
    const atomic = await WorkLaneWorkflowBindingModel.listLaneEntries('task-atomic');
    expect(atomic).toHaveLength(1);
    expect(atomic[0]).toMatchObject({ generation: 1, lane_key: 'todo', status: 'pending' });

    await expect(WorkItemsModel.updateTask('task-rollback', {
      status: 'blocked', actor: 'integration-test',
    })).rejects.toThrow('No active task/lane context');
    expect(await WorkItemsModel.getTask('task-rollback')).toMatchObject({ status: 'backlog' });
    expect(await WorkLaneWorkflowBindingModel.listLaneEntries('task-rollback')).toEqual([]);
  }, 30_000);

  it('allows two tasks on one workflow while rejecting duplicate active task-generation scope', async() => {
    await Promise.all([
      WorkflowExecutionModel.markRunning({
        executionId:     'lane-exec-task-a-1',
        workflowId:      'workflow-1',
        workflowName:    'Workflow 1',
        workflowSlug:    'workflow-1',
        scopeTaskId:     'task-a',
        scopeGeneration: 1,
      }),
      WorkflowExecutionModel.markRunning({
        executionId:     'lane-exec-task-b-1',
        workflowId:      'workflow-1',
        workflowName:    'Workflow 1',
        workflowSlug:    'workflow-1',
        scopeTaskId:     'task-b',
        scopeGeneration: 1,
      }),
    ]);
    await expect(WorkflowExecutionModel.markRunning({
      executionId:     'duplicate-task-a-1',
      workflowId:      'workflow-1',
      workflowName:    'Workflow 1',
      workflowSlug:    'workflow-1',
      scopeTaskId:     'task-a',
      scopeGeneration: 1,
    })).rejects.toMatchObject({ code: '23505' });
  }, 30_000);

  it('settles the exact lane row from workflow terminal state and reclaims an interrupted generation', async() => {
    await pool.query(`
      INSERT INTO work_tasks (id, project_id, epic_id, title, status)
      VALUES ('task-runtime', 'project-1', 'epic-1', 'Runtime task', 'backlog');
    `);
    jest.spyOn(LaneEntryAutomationService, 'dispatchEntry').mockImplementation(async(id) =>
      (await WorkLaneWorkflowBindingModel.getLaneEntry(id))!);

    await WorkItemsModel.updateTask('task-runtime', { status: 'todo', actor: 'integration-test' });
    const generation1 = (await WorkLaneWorkflowBindingModel.listLaneEntries('task-runtime'))[0];
    const execution1 = 'lane-exec-task-runtime-1';
    await WorkLaneWorkflowBindingModel.markStarted(generation1.id, execution1);
    await WorkflowExecutionModel.markRunning({
      executionId:     execution1,
      workflowId:      'workflow-1',
      workflowName:    'Workflow 1',
      workflowSlug:    'workflow-1',
      scopeTaskId:     'task-runtime',
      scopeGeneration: 1,
    });
    await WorkflowExecutionModel.markCompleted(execution1);
    await WorkflowExecutionModel.markCompleted(execution1);
    expect(await WorkLaneWorkflowBindingModel.getLaneEntry(generation1.id)).toMatchObject({
      execution_id: execution1, status: 'completed', outcome: { disposition: 'completed' },
    });

    await WorkItemsModel.updateTask('task-runtime', { status: 'in_review', actor: 'integration-test' });
    const generation2 = (await WorkLaneWorkflowBindingModel.listLaneEntries('task-runtime'))[0];
    const execution2 = 'lane-exec-task-runtime-2';
    await WorkLaneWorkflowBindingModel.markStarted(generation2.id, execution2);
    await WorkflowExecutionModel.markRunning({
      executionId:     execution2,
      workflowId:      'workflow-1',
      workflowName:    'Workflow 1',
      workflowSlug:    'workflow-1',
      scopeTaskId:     'task-runtime',
      scopeGeneration: 2,
    });
    await expect(WorkLaneWorkflowBindingModel.resetInterruptedExecution(generation2.id, execution2))
      .resolves.toMatchObject({ status: 'pending', execution_id: null });

    await WorkLaneWorkflowBindingModel.markStarted(generation2.id, execution2);
    await WorkflowExecutionModel.markRunning({
      executionId:     execution2,
      workflowId:      'workflow-1',
      workflowName:    'Workflow 1',
      workflowSlug:    'workflow-1',
      scopeTaskId:     'task-runtime',
      scopeGeneration: 2,
    });
    const retried = await pool.query(
      'SELECT status, completed_at, error FROM workflow_executions WHERE execution_id = $1', [execution2]);
    expect(retried.rows[0]).toMatchObject({ status: 'running', completed_at: null, error: null });
    await WorkflowExecutionModel.markFailed(execution2, 'runtime failure');
    expect(await WorkLaneWorkflowBindingModel.getLaneEntry(generation2.id)).toMatchObject({
      execution_id: execution2,
      status:       'failed',
      outcome:      { disposition: 'runtime_failed', message: 'runtime failure' },
    });
  }, 30_000);
});
