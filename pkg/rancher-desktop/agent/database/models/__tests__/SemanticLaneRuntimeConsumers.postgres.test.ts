import { randomUUID } from 'node:crypto';

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
import { up as createWorkTaskDispatches } from '../../migrations/0062_create_work_task_dispatches';
import { up as addVerificationDispatches } from '../../migrations/0064_add_verification_dispatches';
import { up as createWorkTaskWaits } from '../../migrations/0065_create_work_task_waits';
import { up as createWorkTaskPlanningRuns } from '../../migrations/0067_create_work_task_planning_runs';
import { up as extendDispatchCustody } from '../../migrations/0068_extend_work_task_dispatch_custody';
import { up as createLaneDefinitions } from '../../migrations/0069_create_work_lane_definitions';
import { up as createLaneWorkflowBindings } from '../../migrations/0070_create_lane_workflow_bindings';
import { up as scopeLaneWorkflowExecutions } from '../../migrations/0071_scope_lane_workflow_executions';
import { up as addReviewDispositionEvidence } from '../../migrations/0072_add_review_disposition_evidence';
import { up as createLifecycleCapabilities } from '../../migrations/0073_create_lifecycle_capabilities';
import { up as addSemanticLaneRuntimeHelpers } from '../../migrations/0074_semantic_lane_runtime_helpers';
import { WorkItemsModel } from '../WorkItemsModel';
import { WorkLaneDefinitionModel } from '../WorkLaneDefinitionModel';
import {
  LANE_ENTRY_INPUT_ENVELOPE,
  LANE_OUTCOME_OUTPUT_ENVELOPE,
  WorkLaneWorkflowBindingModel,
} from '../WorkLaneWorkflowBindingModel';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';
import { WorkTaskPlanningRunModel } from '../WorkTaskPlanningRunModel';
import { WorkflowExecutionModel } from '../WorkflowExecutionModel';

const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const describeWithPostgres = connectionString ? describe : describe.skip;
const forceDispatcherCheckMock: any = jest.fn(() => Promise.resolve());
const planningTransitionMock: any = jest.fn(() => Promise.resolve());

jest.unstable_mockModule('../../../services/TaskDispatcherService', () => ({
  getTaskDispatcherService: () => ({ forceCheck: forceDispatcherCheckMock }),
}));
jest.unstable_mockModule('../../../services/PlanningCouncilService', () => ({
  PlanningCouncilService: { handleTaskStatusTransition: planningTransitionMock },
}));

describeWithPostgres('semantic lane runtime migrated PostgreSQL transition', () => {
  let bootstrapPool: Pool;
  let pool: Pool;
  let schemaCreated = false;
  const schema = `semantic_lane_${ randomUUID().replaceAll('-', '') }`;
  const originalQuery = postgresClient.query;
  const originalQueryOne = postgresClient.queryOne;
  const originalQueryAll = postgresClient.queryAll;
  const originalTransaction = postgresClient.transaction;

  beforeAll(async() => {
    bootstrapPool = new Pool({ connectionString, max: 1 });
    await bootstrapPool.query(`CREATE SCHEMA "${ schema }"`);
    schemaCreated = true;
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${ schema }` });

    for (const migration of [
      createWorkflows,
      createWorkflowExecutions,
      addCoreWorkflowFields,
      createWorkItems,
      addWorkTaskActor,
      addWorkTaskActivity,
      createWorkTaskDispatches,
      addVerificationDispatches,
      createWorkTaskWaits,
      createWorkTaskPlanningRuns,
      extendDispatchCustody,
      createLaneDefinitions,
      createLaneWorkflowBindings,
      scopeLaneWorkflowExecutions,
      addReviewDispositionEvidence,
      createLifecycleCapabilities,
      addSemanticLaneRuntimeHelpers,
    ]) await pool.query(migration);

    (postgresClient as any).query = async(text: string, params: unknown[] = []) =>
      (await pool.query(text, params)).rows;
    (postgresClient as any).queryOne = async(text: string, params: unknown[] = []) =>
      (await pool.query(text, params)).rows[0] ?? null;
    (postgresClient as any).queryAll = async(text: string, params: unknown[] = []) =>
      (await pool.query(text, params)).rows;
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

    await pool.query(`
      INSERT INTO work_projects (id, slug, title) VALUES ('project-semantic', 'semantic', 'Semantic lanes');
      INSERT INTO work_epics (id, project_id, title) VALUES ('epic-semantic', 'project-semantic', 'Runtime');
      INSERT INTO work_lane_definitions
        (id, lane_key, scope, project_id, display_name, position, semantic_role, system_required)
      VALUES
        ('global-backlog', 'backlog', 'global_default', NULL, 'Backlog', 0, 'backlog', true),
        ('global-todo', 'todo', 'global_default', NULL, 'Todo', 10, 'execution', true),
        ('global-progress', 'in_progress', 'global_default', NULL, 'In progress', 20, 'execution', true),
        ('global-planning', 'planning', 'global_default', NULL, 'Planning', 30, 'planning', true),
        ('global-review', 'in_review', 'global_default', NULL, 'Review', 40, 'review', true),
        ('global-blocked', 'blocked', 'global_default', NULL, 'Blocked', 50, 'blocked', true),
        ('global-done', 'done', 'global_default', NULL, 'Done', 60, 'terminal', true),
        ('project-ready', 'ready-custom', 'project', 'project-semantic', 'Ready custom', 5, 'execution', false),
        ('project-building', 'building-custom', 'project', 'project-semantic', 'Building custom', 25, 'execution', false),
        ('project-planning', 'plan-custom', 'project', 'project-semantic', 'Plan custom', 28, 'planning', false),
        ('project-review', 'qa-custom', 'project', 'project-semantic', 'QA custom', 35, 'review', false),
        ('project-complete', 'complete-custom', 'project', 'project-semantic', 'Complete custom', 55, 'terminal', false),
        ('project-manual', 'manual-custom', 'project', 'project-semantic', 'Manual custom', 70, 'manual', false);
    `);

    const laneContract = {
      laneKeys:      ['ready-custom'],
      semanticRoles: ['execution'],
      input:         LANE_ENTRY_INPUT_ENVELOPE,
      output:        LANE_OUTCOME_OUTPUT_ENVELOPE,
    };
    await pool.query(`
      INSERT INTO workflows (id, name, status, enabled, system, definition)
      VALUES ('workflow-semantic', 'Semantic runtime', 'production', true, false, $1::jsonb)
    `, [JSON.stringify({ laneContract, revision: 1 })]);
    await WorkLaneWorkflowBindingModel.set({
      scope:      'project',
      projectId:  'project-semantic',
      workflowId: 'workflow-semantic',
      laneKey:    'ready-custom',
      actor:      'integration-test',
    });
  }, 30_000);

  afterAll(async() => {
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).queryOne = originalQueryOne;
    (postgresClient as any).queryAll = originalQueryAll;
    (postgresClient as any).transaction = originalTransaction;
    await pool?.end();
    if (bootstrapPool && schemaCreated) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${ schema }" CASCADE`);
    }
    await bootstrapPool?.end();
  });

  afterEach(() => {
    forceDispatcherCheckMock.mockClear();
    planningTransitionMock.mockClear();
    jest.restoreAllMocks();
  });

  it('runs a custom execution lane snapshot through custom review and terminal disposition', async() => {
    jest.spyOn(LaneEntryAutomationService, 'dispatchEntry').mockImplementation(async(id) =>
      (await WorkLaneWorkflowBindingModel.getLaneEntry(id))!);

    await WorkItemsModel.insertTask({
      id:       'task-semantic-default',
      epic_id:  'epic-semantic',
      title:    'Semantic default',
      assignee: 'sulla',
      actor:    'heartbeat',
    });
    await expect(WorkItemsModel.getTask('task-semantic-default')).resolves.toMatchObject({
      status: 'ready-custom', assignee: 'dispatcher',
    });
    await pool.query(`
      UPDATE work_tasks SET status = 'manual-custom', assignee = 'sulla'
       WHERE id = 'task-semantic-default'
    `);

    await WorkItemsModel.insertTask({
      id:       'task-semantic-e2e',
      epic_id:  'epic-semantic',
      title:    'Semantic E2E',
      status:   'backlog',
      assignee: 'sulla',
      actor:    'integration-test',
    });
    const entered = await WorkItemsModel.updateTask('task-semantic-e2e', {
      status: 'ready-custom', actor: 'heartbeat',
    });
    expect(entered).toMatchObject({ status: 'ready-custom', assignee: 'dispatcher' });

    const executionEntry = (await WorkLaneWorkflowBindingModel.listLaneEntries('task-semantic-e2e'))[0];
    expect(executionEntry).toMatchObject({
      generation:        1,
      lane_key:          'ready-custom',
      resolution_source: 'project',
      workflow_id:       'workflow-semantic',
      status:            'pending',
      workflow_snapshot: { revision: 1 },
    });

    await WorkLaneWorkflowBindingModel.markStarted(executionEntry.id, 'execution-semantic-e2e');
    await WorkflowExecutionModel.markRunning({
      executionId:     'execution-semantic-e2e',
      workflowId:      'workflow-semantic',
      workflowName:    'Semantic runtime',
      workflowSlug:    'semantic-runtime',
      scopeTaskId:     'task-semantic-e2e',
      scopeGeneration: 1,
    });
    await WorkflowExecutionModel.markCompleted('execution-semantic-e2e');
    expect(await WorkLaneWorkflowBindingModel.getLaneEntry(executionEntry.id)).toMatchObject({
      status: 'completed', outcome: { disposition: 'completed' },
    });

    await expect(WorkItemsModel.updateTask('task-semantic-e2e', {
      status: 'qa-custom', assignee: 'heartbeat', actor: 'integration-test',
    })).resolves.toMatchObject({ status: 'qa-custom' });
    const review = await WorkTaskDispatchModel.claimNextReview('reviewer-semantic');
    expect(review?.task).toMatchObject({ id: 'task-semantic-e2e', status: 'qa-custom' });

    await expect(WorkTaskDispatchModel.finalizeVerification(
      review!.dispatch.id, 'APPROVE', 'artifact-sha', 'artifact-sha', 'Custom lane accepted.',
    )).resolves.toBe('APPROVE');
    await expect(WorkItemsModel.getTask('task-semantic-e2e')).resolves.toMatchObject({
      status: 'complete-custom', assignee: null,
    });
    expect((await WorkItemsModel.getTask('task-semantic-e2e'))?.completed_at).not.toBeNull();
  }, 30_000);

  it('preserves manual and unknown lanes and degrades to stable-key ownership deterministically', async() => {
    await pool.query(`
      INSERT INTO work_tasks (id, project_id, epic_id, title, status, assignee)
      VALUES
        ('task-manual', 'project-semantic', 'epic-semantic', 'Manual', 'manual-custom', 'sulla'),
        ('task-unknown', 'project-semantic', 'epic-semantic', 'Unknown', 'legacy-unknown', 'sulla')
    `);
    const roles = await pool.query(`
      SELECT id, resolve_work_task_lane_role(id, status) AS role
        FROM work_tasks WHERE id IN ('task-manual', 'task-unknown') ORDER BY id
    `);
    expect(roles.rows).toEqual([
      { id: 'task-manual', role: 'manual' },
      { id: 'task-unknown', role: 'manual' },
    ]);
    await expect(WorkTaskDispatchModel.claimNext('worker-semantic')).resolves.toBeNull();

    await pool.query(`
      UPDATE work_lane_definitions
         SET archived = true, enabled = false
       WHERE semantic_role = 'blocked'
    `);
    await expect(WorkLaneDefinitionModel.runtimeCapability('project-semantic')).resolves.toMatchObject({
      ready: false, catalogPresent: true, missingRoles: ['blocked'],
    });
    await expect(WorkLaneDefinitionModel.semanticRoleForStatus(
      'project-semantic', 'ready-custom',
    )).resolves.toBe('manual');
    await expect(WorkLaneDefinitionModel.semanticRoleForStatus(
      'project-semantic', 'todo',
    )).resolves.toBe('execution');

    const destinations = await pool.query(`
      SELECT
        resolve_project_lane_key('project-semantic', 'execution', 'todo') AS execution_entry,
        resolve_project_lane_key('project-semantic', 'execution', 'in_progress', true) AS execution_active,
        resolve_project_lane_key('project-semantic', 'review', 'in_review') AS review,
        resolve_project_lane_key('project-semantic', 'terminal', 'done') AS terminal
    `);
    expect(destinations.rows[0]).toEqual({
      execution_entry:  'todo',
      execution_active: 'in_progress',
      review:           'in_review',
      terminal:         'done',
    });

    const degradedCustom = await WorkItemsModel.insertTask({
      id:       'task-degraded-custom',
      epic_id:  'epic-semantic',
      title:    'Degraded custom',
      status:   'ready-custom',
      assignee: 'sulla',
      actor:    'heartbeat',
    });
    const degradedTodo = await WorkItemsModel.insertTask({
      id:       'task-degraded-todo',
      epic_id:  'epic-semantic',
      title:    'Degraded todo',
      assignee: 'sulla',
      actor:    'heartbeat',
    });
    expect(degradedCustom.assignee).toBe('sulla');
    expect(degradedTodo).toMatchObject({ status: 'todo', assignee: 'dispatcher' });

    const claim = await WorkTaskDispatchModel.claimNext('worker-degraded');
    expect(claim?.task).toMatchObject({ id: 'task-degraded-todo', status: 'todo' });
    await expect(WorkItemsModel.getTask('task-degraded-todo')).resolves.toMatchObject({
      status: 'in_progress', assignee: 'dispatcher',
    });
    await expect(WorkItemsModel.getTask('task-degraded-custom')).resolves.toMatchObject({
      status: 'ready-custom', assignee: 'sulla',
    });

    await pool.query(`
      INSERT INTO work_tasks (id, project_id, epic_id, title, status, assignee)
      VALUES ('task-degraded-blocked', 'project-semantic', 'epic-semantic', 'Blocked', 'blocked', 'heartbeat');
      INSERT INTO work_task_waits (id, task_id, wait_kind, target_key)
      VALUES ('wait-degraded-blocked', 'task-degraded-blocked', 'human_gate', 'approval');
      INSERT INTO work_task_comments (id, task_id, body, author)
      VALUES ('comment-degraded-blocked', 'task-degraded-blocked', 'Approved', 'human');
    `);
    await expect(WorkItemsModel.getTask('task-degraded-blocked')).resolves.toMatchObject({
      status: 'in_review', assignee: 'heartbeat',
    });
  }, 30_000);

  it('recovers custom planning lanes and visibly degrades before stable-key fallback', async() => {
    await pool.query(`
      UPDATE work_lane_definitions
         SET archived = false, enabled = true
       WHERE semantic_role = 'blocked';
      INSERT INTO work_tasks (id, project_id, epic_id, title, status, assignee)
      VALUES ('task-stale-custom', 'project-semantic', 'epic-semantic', 'Custom stale planning', 'plan-custom', 'planning-council');
      INSERT INTO work_task_planning_runs
        (id, task_id, workflow_id, status, trigger_status, heartbeat_at)
      VALUES
        ('planning-stale-custom', 'task-stale-custom', 'core-routine-plan-project-task', 'active', 'plan-custom', now() - interval '2 hours');
    `);

    await expect(WorkTaskPlanningRunModel.recoverStale(45)).resolves.toEqual(['task-stale-custom']);

    await pool.query(`
      UPDATE work_lane_definitions
         SET archived = true, enabled = false
       WHERE semantic_role = 'blocked';
      INSERT INTO work_tasks (id, project_id, epic_id, title, status, assignee)
      VALUES
        ('task-stale-legacy', 'project-semantic', 'epic-semantic', 'Legacy stale planning', 'planning', 'planning-council'),
        ('task-stale-degraded-custom', 'project-semantic', 'epic-semantic', 'Degraded custom planning', 'plan-custom', 'planning-council');
      INSERT INTO work_task_planning_runs
        (id, task_id, workflow_id, status, trigger_status, heartbeat_at)
      VALUES
        ('planning-stale-legacy', 'task-stale-legacy', 'core-routine-plan-project-task', 'active', 'planning', now() - interval '2 hours'),
        ('planning-stale-degraded-custom', 'task-stale-degraded-custom', 'core-routine-plan-project-task', 'active', 'plan-custom', now() - interval '2 hours');
    `);

    await expect(WorkTaskPlanningRunModel.recoverStale(45)).resolves.toEqual(['task-stale-legacy']);
    const capability = await pool.query(`
      SELECT health, fallback_mode, fallback_active, last_error
        FROM lifecycle_capabilities
       WHERE capability_key = 'planning-council'
    `);
    expect(capability.rows[0]).toMatchObject({
      health:          'degraded',
      fallback_mode:   'keep_current',
      fallback_active: true,
    });
    expect(capability.rows[0].last_error).toContain('Required semantic lane roles are missing: blocked');
  }, 30_000);
});
