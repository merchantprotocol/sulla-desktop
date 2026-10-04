/** @jest-environment node */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../PostgresClient';
import { WorkLaneWorkflowBindingModel } from '../WorkLaneWorkflowBindingModel';
import { WorkTaskPlanningRunModel } from '../WorkTaskPlanningRunModel';
import { WorkLaneDefinitionModel } from '../WorkLaneDefinitionModel';
import { LifecycleCapabilityModel } from '../LifecycleCapabilityModel';
import { WorkflowExecutionModel } from '../WorkflowExecutionModel';
import { ArtifactReceiptModel } from '../ArtifactReceiptModel';
import { taskLaneTargetSql } from '../WorkAgentAdmission';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

jest.unstable_mockModule('../../../services/ConversationLogger', () => ({ getConversationLogger: jest.fn() }));
jest.unstable_mockModule('../../../services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send: jest.fn() }) }));
jest.unstable_mockModule('../../../workflow/lockedCoreRoutineExecution', () => ({
  inheritSubAgentToolPolicy: jest.fn(), lockedCoreBlockedError: jest.fn(), resolveAgentTaskForDispatch: jest.fn(),
}));

const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const postgresSuite = connectionString ? describe : describe.skip;

postgresSuite('dispatcher broad admission against PostgreSQL', () => {
  const schema = `admission_${ randomUUID().replaceAll('-', '') }`;
  const original = { query: postgresClient.query, queryOne: postgresClient.queryOne, transaction: postgresClient.transaction };
  let bootstrap: Pool;
  let pool: Pool;

  beforeAll(async() => {
    bootstrap = new Pool({ connectionString });
    await bootstrap.query(`CREATE SCHEMA "${ schema }"`);
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${ schema }` });
    await pool.query(`
      CREATE TABLE work_projects (id text PRIMARY KEY, status text, dispatch_enabled boolean, archived boolean DEFAULT false);
      CREATE TABLE work_epics (id text PRIMARY KEY, project_id text, status text);
      CREATE TABLE work_tasks (
        id text PRIMARY KEY, project_id text, epic_id text, status text, archived boolean DEFAULT false,
        assignee text, labels text[], source_ref text, github_issue text,
        last_activity_at timestamptz DEFAULT now(), last_moved_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(), last_moved_by text, completed_at timestamptz
      );
      CREATE TABLE work_task_dispatches (
        id text PRIMARY KEY, task_id text, agent_id text, thread_id text, kind text, attempt int,
        status text DEFAULT 'running', started_at timestamptz DEFAULT now(), finished_at timestamptz,
        origin_dispatch_id text, origin_agent_id text, origin_evidence jsonb, reviewer_agent_ids text[],
        artifact_url text, artifact_location text, workflow_execution_id text, heartbeat_at timestamptz DEFAULT now(),
        error text, failure_reason text, review_generation_hash text, result text, verdict text, artifact_sha text,
        classifier_decision jsonb, selected_agents jsonb, worker_child_ids text[], review_count int DEFAULT 0, repair_count int DEFAULT 0,
        artifact_type text, artifact_ref text, content_hash text, reviewer_verdict text, review_evidence jsonb, terminal_reason text,
        disposition text, findings_fingerprint text, review_artifact_type text, review_artifact_types text[], review_artifacts jsonb,
        excluded_agent_ids text[], review_artifact_ref text, review_artifact_url text, review_artifact_hash text, review_checks jsonb, review_findings jsonb
      );
      CREATE TABLE work_task_outcome_journal (
        id text PRIMARY KEY, dispatch_id text UNIQUE, task_id text, dispatch_status text,
        task_status text, task_assignee text, comment text, result text, error text,
        evidence jsonb, receipt jsonb, created_at timestamptz DEFAULT now(), consumed_at timestamptz
      );
      CREATE TABLE work_task_stage_claims (
        id text PRIMARY KEY, task_id text, capability_key text, stage text, owner text,
        runtime_instance_id text, status text DEFAULT 'active', released_at timestamptz, heartbeat_at timestamptz DEFAULT now()
      );
      CREATE TABLE lifecycle_capabilities (
        capability_key text PRIMARY KEY, enabled boolean, health text, active_owner text,
        fallback_mode text, fallback_active boolean
      );
      CREATE TABLE work_task_waits (task_id text, status text);
      CREATE TABLE work_task_dependencies (dependent_task_id text, depends_on_task_id text, archived_at timestamptz);
      CREATE TABLE work_lane_entry_automations (
        id text PRIMARY KEY, task_id text, generation int, previous_lane_key text, lane_key text,
        binding_id text, workflow_id text, resolution_source text, fallback_reason text,
        binding_snapshot jsonb, workflow_snapshot jsonb, status text, actor text,
        execution_id text, started_at timestamptz, completed_at timestamptz, outcome jsonb, UNIQUE(task_id, generation)
      );
      CREATE TABLE work_task_artifact_custody (id text, task_id text, custody jsonb, transition text, work_kind text, created_by text, created_at timestamptz DEFAULT now());
      CREATE TABLE work_lane_definitions (position int DEFAULT 0, lane_key text, semantic_role text, system_required boolean,
        reset_at timestamptz, archived boolean DEFAULT false, enabled boolean DEFAULT true, scope text, project_id text);
      INSERT INTO work_lane_definitions (lane_key, semantic_role, system_required, scope)
        VALUES ('in_progress', 'execution', true, 'global_default'),
          ('qa', 'review', false, 'global_default'), ('shipped', 'terminal', false, 'global_default');
      CREATE TABLE work_lane_workflow_bindings (profile_id text, active boolean, archived boolean,
        scope text, epic_id text, lane_key text, project_id text, semantic_role text, created_at timestamptz);
      CREATE TABLE work_project_domain_events (id text, task_id text, generation int, generation_hash text,
        event_type text, idempotency_key text UNIQUE, payload jsonb, occurred_at timestamptz);
      CREATE TABLE work_task_planning_runs (id text PRIMARY KEY, task_id text, status text DEFAULT 'active',
        workflow_id text, execution_id text, trigger_status text, trigger_actor text, attempt int, error text,
        heartbeat_at timestamptz DEFAULT now(), finished_at timestamptz);
      CREATE TABLE workflow_executions (execution_id text PRIMARY KEY, status text, error text,
        lease_expires_at timestamptz, heartbeat_at timestamptz, completed_at timestamptz, updated_at timestamptz,
        scope_task_id text, auto_restart boolean DEFAULT true, owner_id text, lease_token text, leased_at timestamptz,
        attempt_count int DEFAULT 0, max_attempts int DEFAULT 3, terminal_at timestamptz, terminal_reason text,
        started_at timestamptz DEFAULT now());
      CREATE TABLE work_task_comments (id text, task_id text, body text, author text);
      CREATE TABLE agent_jobs (job_id text, status text, results jsonb);
      INSERT INTO work_projects (id, status, dispatch_enabled) VALUES ('enabled', 'working', true), ('paused', 'blocked', false);
      INSERT INTO lifecycle_capabilities VALUES
        ('todo-execution', true, 'healthy', 'dispatcher', 'manual_hold', false),
        ('in-review-verification', true, 'healthy', 'dispatcher', 'manual_hold', false);
    `);
    (postgresClient as any).queryOne = async(sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows[0] ?? null;
    (postgresClient as any).query = async(sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows;
    (postgresClient as any).transaction = async(callback: any) => {
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
  });

  beforeEach(async() => {
    jest.spyOn(ArtifactReceiptModel, 'insertIfAbsentWithClient').mockResolvedValue({ inserted: true, row: { id: 'receipt' } } as any);
    jest.spyOn(ArtifactReceiptModel, 'attachCommentWithClient').mockResolvedValue(undefined);
    jest.spyOn(WorkflowExecutionModel, 'markRunning').mockResolvedValue(undefined as any);
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: false, catalogPresent: false, missingRoles: ['planning'], degradedReason: 'fixture',
    });
    jest.spyOn(WorkLaneDefinitionModel, 'preferredLaneKey').mockResolvedValue('planning');
    await pool.query("DELETE FROM work_lane_definitions WHERE lane_key NOT IN ('in_progress', 'qa', 'shipped')");
    await pool.query('TRUNCATE work_task_outcome_journal, workflow_executions, work_tasks, work_task_dispatches, work_task_stage_claims, work_task_waits, work_task_dependencies, work_lane_entry_automations, work_task_planning_runs, work_task_artifact_custody, work_project_domain_events');
  });

  afterAll(async() => {
    jest.restoreAllMocks();
    Object.assign(postgresClient, original);
    await pool?.end();
    await bootstrap?.query(`DROP SCHEMA "${ schema }" CASCADE`);
    await bootstrap?.end();
  });

  it('enumerates more than 500 epicless tasks, including paused work, in recency order', async() => {
    await pool.query(`INSERT INTO work_tasks (id, project_id, status, last_activity_at, last_moved_at, updated_at, created_at)
      SELECT n::text, CASE WHEN n = 601 THEN 'paused' ELSE 'enabled' END, 'custom_lane',
        now() + n * interval '1 second', now(), now(), now() FROM generate_series(1, 601) n`);
    const candidates = await WorkTaskDispatchModel.enumerateCandidates();
    expect(candidates).toHaveLength(601);
    expect(candidates[0]).toMatchObject({ id: '601', project_dispatch_enabled: false, epic_id: null });
    expect(candidates[600].id).toBe('1');
  });

  it('claims waiting human-owned custom-lane work in place and rejects a duplicate claim', async() => {
    await pool.query(`INSERT INTO work_tasks (id, project_id, status, assignee, labels)
      VALUES ('custom', 'enabled', 'custom_lane', 'human', ARRAY['gated']), ('dependency', 'paused', 'todo', null, '{}');
      INSERT INTO work_task_waits VALUES ('custom', 'active');
      INSERT INTO work_task_dependencies VALUES ('custom', 'dependency', null)`);
    const claims = await Promise.all([1, 2].map(n => WorkTaskDispatchModel.claimNext('sulla-desktop', `runtime-${ n }`, undefined, 'custom')));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.task.status).toBe('custom_lane');
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM work_task_dispatches WHERE status='running'")).rows[0].count).toBe(1);
    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'dependency')).resolves.toBeNull();
  });

  it('enforces three total leases during concurrent mixed review/execution claims', async() => {
    await pool.query(`INSERT INTO work_tasks (id, project_id, status) VALUES
      ('a', 'enabled', 'in_review'), ('b', 'enabled', 'custom'), ('c', 'enabled', 'blocked'), ('d', 'enabled', 'in_review')`);
    const claims = await Promise.all([
      WorkTaskDispatchModel.claimNextReview('sulla-desktop', [], 'runtime-a', 'a'),
      WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime-b', undefined, 'b'),
      WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime-c', undefined, 'c'),
      WorkTaskDispatchModel.claimNextReview('sulla-desktop', [], 'runtime-d', 'd'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(3);
  });

  it('holds live lane writers and duplicate PRs without removing them from consideration', async() => {
    await pool.query(`INSERT INTO work_tasks (id, project_id, status, github_issue) VALUES
      ('a', 'enabled', 'custom', 'owner/repo#1'), ('b', 'enabled', 'custom', 'owner/repo#1'), ('lane', 'enabled', 'custom', null);
      INSERT INTO work_lane_entry_automations (id, task_id, status, workflow_snapshot) VALUES ('lane-entry', 'lane', 'running', '{}')`);
    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'a')).resolves.not.toBeNull();
    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'b')).resolves.toBeNull();
    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'lane')).resolves.toBeNull();
    expect(await WorkTaskDispatchModel.enumerateCandidates()).toHaveLength(3);
  });
  it('admits unresolved todo dependencies through real lane-entry and audit SQL', async() => {
    await pool.query(`INSERT INTO work_tasks (id, project_id, status) VALUES
      ('todo', 'enabled', 'todo'), ('prerequisite', 'paused', 'todo');
      INSERT INTO work_task_dependencies VALUES ('todo', 'prerequisite', null)`);
    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'todo'))
      .resolves.toMatchObject({ task: { status: 'in_progress' } });
    expect((await pool.query("SELECT * FROM work_lane_entry_automations WHERE task_id='todo'")).rows)
      .toHaveLength(1);
    expect((await pool.query("SELECT * FROM work_project_domain_events WHERE task_id='todo'")).rows)
      .toHaveLength(1);
  });

  async function taskWithLane(id: string, reference: string | null = null, owner?: string): Promise<void> {
    await pool.query(`INSERT INTO work_tasks (id, project_id, status, github_issue)
      VALUES ($1, 'enabled', 'planning', $2)`, [id, reference]);
    await pool.query(`INSERT INTO work_lane_entry_automations
      (id, task_id, generation, lane_key, status, workflow_snapshot)
      VALUES ($1, $2, 1, 'planning', 'pending', $3)`,
    [`entry-${ id }`, id, JSON.stringify(owner ? { laneContract: { owner } } : {})]);
  }

  const admit = (kind: string, id: string) => kind === 'lane'
    ? WorkLaneWorkflowBindingModel.markStarted(`entry-${ id }`, `exec-${ id }`)
    : kind === 'planning' ? WorkTaskPlanningRunModel.claim(id, 'planning')
      : WorkTaskDispatchModel.claimNext('sulla-desktop', `runtime-${ id }`, undefined, id);

  it.each([['lane', 'planning'], ['planning', 'lane'], ['lane', 'dispatch'], ['dispatch', 'lane']])(
    'prevents same-task writers in %s then %s order', async(first, second) => {
      await taskWithLane('same');
      await expect(admit(first, 'same')).resolves.not.toBeNull();
      await expect(admit(second, 'same')).resolves.toBeNull();
    });

  it.each([['lane', 'planning'], ['planning', 'lane'], ['lane', 'dispatch'],
    ['dispatch', 'lane'], ['planning', 'dispatch'], ['dispatch', 'planning']])(
    'reserves equivalent PR references across %s and %s', async(first, second) => {
      await taskWithLane('a', 'https://github.com/Owner/Repo/pull/925/files?diff=split');
      await taskWithLane('b', 'owner/repo#925');
      const results = await Promise.all([admit(first, 'a'), admit(second, 'b')]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await WorkTaskDispatchModel.enumerateCandidates()).toHaveLength(2);
    });

  it.each([['planning', 'a'], ['planning', 'b'], ['lane', 'a'], ['lane', 'b']])(
    'retains %s task and artifact reservations until termination, then admits %s', async(kind, nextTask) => {
      const { PlaybookController } = await import('../../../controllers/PlaybookController');
      await taskWithLane('a', 'owner/repo#925');
      await taskWithLane('b', 'https://github.com/owner/repo/pull/925');
      await expect(admit(kind, 'a')).resolves.not.toBeNull();
      jest.spyOn(WorkflowExecutionModel, 'settle').mockReset().mockResolvedValue({} as any);
      const executionId = 'exec-a';
      const state: any = { messages: [], metadata: { activeWorkflow: {
        executionId, workflowId: 'custom-reservation-test', status: 'running', nodeOutputs: {},
        definition: { name: 'Writer', nodes: [], edges: [] },
      } } };
      // Use the real planning/lane ledger settlement called by terminal callbacks.
      state.metadata.onRoutineTerminal = async() => {
        if (kind === 'planning') await WorkTaskPlanningRunModel.settleForTask('a', 'failed', 'Parent aborted');
        else await WorkLaneWorkflowBindingModel.markOutcome('entry-a', executionId, 'failed', {});
      };
      const execute = jest.fn(async() => state);
      const controller: any = new PlaybookController({ execute, getEntryPoint: () => 'agent', getNode: () => null });
      let finish!: () => void;
      controller.executeSubAgentUntracked = () => new Promise<void>(resolve => { finish = resolve; });
      const child = controller.executeSubAgent(state, 'writer', 'agent', 'repair', {});
      await pool.query(`INSERT INTO workflow_executions (execution_id, status, lease_expires_at, heartbeat_at)
        VALUES ($1, 'running', now() - interval '1 hour', now() - interval '1 hour')`, [executionId]);
      await pool.query("UPDATE workflow_executions SET scope_task_id='a' WHERE execution_id=$1", [executionId]);
      await expect(WorkflowExecutionModel.recover(executionId, 'replacement-runtime')).resolves.toBeNull();
      await pool.query("UPDATE workflow_executions SET attempt_count=max_attempts WHERE execution_id=$1", [executionId]);
      await expect(WorkflowExecutionModel.recover(executionId, 'replacement-runtime')).resolves.toBeNull();
      expect((await pool.query('SELECT status FROM workflow_executions WHERE execution_id=$1', [executionId])).rows[0].status).toBe('running');
      if (kind === 'planning') {
        await pool.query("UPDATE work_task_planning_runs SET execution_id=$1, heartbeat_at=now()-interval '1 hour' WHERE task_id='a'", [executionId]);
        await expect(WorkTaskPlanningRunModel.recoverStaleForTask('a', 1)).resolves.toBe(false);
        await expect(WorkTaskPlanningRunModel.recoverStale(1)).resolves.toEqual([]);
      } else {
        await pool.query("UPDATE work_lane_entry_automations SET workflow_id='custom-reservation-test' WHERE id='entry-a'");
        expect(await WorkLaneWorkflowBindingModel.listRecoverable(50, true)).toEqual([expect.objectContaining({ id: 'entry-a' })]);
        await expect(WorkLaneWorkflowBindingModel.resetInterruptedExecution('entry-a', executionId)).resolves.toBeNull();
        const { LaneEntryAutomationService } = await import('../../../services/LaneEntryAutomationService');
        await expect(LaneEntryAutomationService.drainRecoverable(50, true)).resolves.toEqual([]);
      }

      // Exercise the public path while the child is still unresolved, before
      // the runtime terminal callback has any opportunity to release custody.
      if (kind === 'planning') {
        const { PlanningCouncilService } = await import('../../../services/PlanningCouncilService');
        await pool.query("UPDATE work_tasks SET status='in_progress' WHERE id='a'");
        const task = (await pool.query("SELECT * FROM work_tasks WHERE id='a'")).rows[0];
        await PlanningCouncilService.handleTaskStatusTransition(task, 'planning', 'planning-council');
        expect((await pool.query("SELECT status FROM work_task_planning_runs WHERE task_id='a'")).rows[0].status).toBe('active');
      } else {
        const { ProjectsApplicationService } = await import('../../../projects/application/ProjectsApplicationService');
        const projects = new ProjectsApplicationService({
          getTask: async() => (await pool.query("SELECT * FROM work_tasks WHERE id='a'")).rows[0],
        } as any);
        const reported = await projects.settleStageGeneration({
          taskId: 'a', expectedGeneration: 1, status: 'completed', outcome: { report: 'done' },
        }, { actor: 'lane-writer', source: 'routine' });
        expect(reported.status).toBe('running');
        expect(reported.completed_at).toBeNull();
        expect(reported.outcome).toMatchObject({ requestedSettlement: { status: 'completed' } });
      }
      await expect(admit('dispatch', 'a')).resolves.toBeNull();
      await expect(admit('dispatch', 'b')).resolves.toBeNull();
      const release = controller.releaseWorkflow(state, state.metadata.activeWorkflow, 'failed', 'Parent aborted');
      await expect(admit('dispatch', 'a')).resolves.toBeNull();
      await expect(admit('dispatch', 'b')).resolves.toBeNull();
      expect(controller.hasUnconfirmedWorkers()).toBe(true);
      expect(WorkflowExecutionModel.settle).not.toHaveBeenCalled();
      finish();
      await child;
      await release;
      expect(controller.hasUnconfirmedWorkers()).toBe(false);
      // No tool-capable parent continuation exists after reservations release.
      expect(execute).not.toHaveBeenCalled();
      await expect(admit('dispatch', nextTask)).resolves.not.toBeNull();
    });

  it.each(['a', 'b'])('retains restarted dispatch ownership until writer termination, then admits %s', async(nextTask) => {
    await taskWithLane('a', 'owner/repo#925');
    await taskWithLane('b', 'https://github.com/owner/repo/pull/925');
    const claim = await WorkTaskDispatchModel.claimNext('sulla-desktop', 'old-runtime', undefined, 'a');
    expect(claim).not.toBeNull();
    let finish!: () => void;
    const survivingWriter = new Promise<void>(resolve => { finish = resolve; });
    await pool.query("UPDATE work_task_dispatches SET heartbeat_at=now()-interval '2 hours' WHERE id=$1", [claim!.dispatch.id]);
    await pool.query("UPDATE work_task_stage_claims SET heartbeat_at=now()-interval '2 hours' WHERE task_id='a'");
    if (nextTask === 'b') {
      // A legacy parent may already look terminal while its external child survives.
      await pool.query("INSERT INTO workflow_executions (execution_id, status) VALUES ('old-parent', 'completed')");
      await pool.query("UPDATE work_task_dispatches SET workflow_execution_id='old-parent', artifact_url='https://github.com/owner/repo/pull/925' WHERE id=$1", [claim!.dispatch.id]);
    }
    // The restarted process has no active map entries for the surviving writer.
    await expect(WorkTaskDispatchModel.recoverStale(0, [])).resolves.toEqual([]);
    expect((await pool.query('SELECT status FROM work_task_dispatches WHERE id=$1', [claim!.dispatch.id])).rows[0].status).toBe('running');
    expect((await pool.query("SELECT status FROM work_task_stage_claims WHERE task_id='a'")).rows[0].status).toBe('active');
    await expect(admit('dispatch', 'a')).resolves.toBeNull();
    await expect(admit('dispatch', 'b')).resolves.toBeNull();
    await expect(admit('lane', 'b')).resolves.toBeNull();
    await expect(admit('planning', 'b')).resolves.toBeNull();
    finish();
    await survivingWriter;
    // The owning runtime journals only after writer drain. A new runtime can
    // replay that durable confirmation without an in-memory active entry.
    const journalId = await WorkTaskDispatchModel.appendOutcomeJournal(claim!.dispatch.id, 'a', {
      dispatchStatus: 'completed', taskStatus: 'planning', taskAssignee: 'dispatcher',
      comment: 'Writer termination confirmed; unfinished work remains in its lane.',
    });
    await expect(WorkTaskDispatchModel.recoverPendingOutcomeJournals()).resolves.toEqual([journalId]);
    await expect(admit('dispatch', nextTask)).resolves.not.toBeNull();
  });

  it('reserves custody-only artifact references across mixed writers', async() => {
    await taskWithLane('a');
    await taskWithLane('b', 'owner/repo#925');
    await pool.query(`INSERT INTO work_task_artifact_custody (id, task_id, custody)
      VALUES ('custody-a', 'a', '{"prUrl":"https://github.com/OWNER/REPO/pull/925"}')`);
    await expect(admit('planning', 'a')).resolves.not.toBeNull();
    await expect(admit('lane', 'b')).resolves.toBeNull();
  });

  it('only starts the current lane generation and holds it behind a still-running old generation', async() => {
    await taskWithLane('a');
    await pool.query(`INSERT INTO work_lane_entry_automations
      (id, task_id, generation, lane_key, status, workflow_snapshot)
      VALUES ('new-a', 'a', 2, 'planning', 'pending', '{}')`);
    await expect(admit('lane', 'a')).resolves.toBeNull();
    await pool.query("UPDATE work_lane_entry_automations SET status='running' WHERE id='entry-a'");
    await expect(WorkLaneWorkflowBindingModel.markStarted('new-a', 'new-exec')).resolves.toBeNull();
    await pool.query("UPDATE work_lane_entry_automations SET status='completed' WHERE id='entry-a'");
    await expect(WorkLaneWorkflowBindingModel.markStarted('new-a', 'new-exec')).resolves.not.toBeNull();
  });

  it.each([['planning-council', 'planning'], ['task-dispatcher', 'dispatch']])(
    'allows only the named service to take over a %s delegation marker', async(owner, service) => {
      await taskWithLane('a', null, owner);
      await expect(admit('lane', 'a')).resolves.not.toBeNull();
      await expect(admit(service === 'planning' ? 'dispatch' : 'planning', 'a')).resolves.toBeNull();
      await expect(admit(service, 'a')).resolves.not.toBeNull();
      await expect(admit(service, 'a')).resolves.toBeNull();
    });

  it('bounds simultaneous lane, planning and dispatcher writers to three tasks', async() => {
    for (const id of ['a', 'b', 'c', 'd']) await taskWithLane(id);
    const results = await Promise.all([
      admit('lane', 'a'), admit('planning', 'b'), admit('dispatch', 'c'), admit('lane', 'd'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it('keeps public caller leases reserved through dispatcher runtime recovery until release', async() => {
    const { ProjectsApplicationService } = await import('../../../projects/application/ProjectsApplicationService');
    await taskWithLane('a', 'owner/repo#925');
    await taskWithLane('b', 'https://github.com/owner/repo/pull/925');
    await pool.query("UPDATE work_tasks SET status='in_progress' WHERE id='a'");
    const projects = new ProjectsApplicationService({
      getTask: async() => (await pool.query("SELECT * FROM work_tasks WHERE id='a'")).rows[0],
    } as any);
    const direct = await projects.claimTaskLease({ taskId: 'a', owner: 'dispatcher', runtimeInstanceId: 'public-caller' });
    expect(direct.claimed).toBe(true);
    for (const runtime of ['task-dispatcher-new', 'task-dispatcher-next']) {
      await expect(LifecycleCapabilityModel.recoverPreviousRuntime('todo-execution', runtime)).resolves.toEqual([]);
      await expect(admit('dispatch', 'a')).resolves.toBeNull();
      await expect(admit('dispatch', 'b')).resolves.toBeNull();
    }
    await projects.releaseTaskLease({ claimId: direct.claim!.id });
    await expect(admit('dispatch', 'b')).resolves.not.toBeNull();
  });

  it('routes custom review and terminal lanes by role without executing them as ordinary work', async() => {
    await pool.query(`INSERT INTO work_tasks (id, project_id, status) VALUES
      ('review', 'enabled', 'qa'), ('done', 'enabled', 'shipped')`);
    expect(await WorkTaskDispatchModel.enumerateCandidates()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'review', lane_role: 'review' }),
      expect.objectContaining({ id: 'done', lane_role: 'terminal' }),
    ]));
    await expect(admit('dispatch', 'review')).resolves.toBeNull();
    await expect(admit('dispatch', 'done')).resolves.toBeNull();
    await expect(WorkTaskDispatchModel.claimNextReview('sulla-desktop', [], 'review-runtime', 'review'))
      .resolves.toMatchObject({ task: { status: 'qa' }, stage_claim: { stage: 'qa' } });
  });

  it('keeps blocked work in place when planning takes ownership', async() => {
    await pool.query("INSERT INTO work_tasks (id, project_id, status) VALUES ('blocked', 'enabled', 'blocked')");
    await expect(WorkTaskPlanningRunModel.claim('blocked', 'blocked'))
      .resolves.toMatchObject({ task: { status: 'blocked' } });
    expect((await pool.query("SELECT status FROM work_tasks WHERE id='blocked'")).rows[0].status).toBe('blocked');
    expect((await pool.query('SELECT * FROM work_lane_entry_automations')).rows).toHaveLength(0);
  });

  it('reuses all three slots after legacy review checkpoints settle, including custom lanes', async() => {
    for (const id of ['a', 'b', 'c', 'next']) {
      await pool.query("INSERT INTO work_tasks (id, project_id, status) VALUES ($1, 'enabled', 'qa')", [id]);
    }
    for (const id of ['a', 'b', 'c']) {
      const claimed = await WorkTaskDispatchModel.claimNextReview('sulla-desktop', [], `runtime-${ id }`, id);
      expect(claimed).not.toBeNull();
      await WorkTaskDispatchModel.recordReviewLaunchWithExecution(claimed!.dispatch.id, {
        executionId: `review-${ id }`, workflowId: 'review', workflowName: 'review', workflowSlug: 'review',
        triggerInput: '', scopeTaskId: id, reviewerAgentIds: [],
      });
      expect((await pool.query('SELECT status FROM work_lane_entry_automations WHERE task_id=$1', [id])).rows[0].status)
        .toBe('completed');
      // Simulate checkpoints created by the earlier implementation.
      await pool.query("UPDATE work_lane_entry_automations SET status='running' WHERE task_id=$1", [id]);
      await WorkTaskDispatchModel.finalizeVerification(claimed!.dispatch.id, 'REWORK', 'a'.repeat(40), null, 'Repaired');
      expect((await pool.query('SELECT status FROM work_tasks WHERE id=$1', [id])).rows[0].status).toBe('qa');
    }
    expect((await pool.query("SELECT * FROM work_lane_entry_automations WHERE status='running'")).rows).toHaveLength(0);
    expect((await pool.query("SELECT * FROM work_task_stage_claims WHERE status='active'")).rows).toHaveLength(0);
    const claims = await Promise.all(['a', 'b', 'next'].map(id =>
      WorkTaskDispatchModel.claimNextReview('sulla-desktop', [], `next-${ id }`, id)));
    expect(claims.filter(Boolean)).toHaveLength(3);
  });

  it('records execution-to-custom-review checkpoint and transition, then supports generation-bound review', async() => {
    await pool.query("INSERT INTO work_tasks (id, project_id, status) VALUES ('finish', 'enabled', 'todo')");
    const claim = await WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'finish');
    expect(claim).not.toBeNull();
    await WorkTaskDispatchModel.finalize(claim!.dispatch.id, 'finish', {
      dispatchStatus: 'completed', taskStatus: 'in_review', taskAssignee: 'heartbeat', comment: 'Ready',
    });
    const entries = (await pool.query("SELECT * FROM work_lane_entry_automations WHERE task_id='finish' ORDER BY generation")).rows;
    expect(entries.map(row => row.lane_key)).toEqual(['in_progress', 'qa']);
    const events = (await pool.query("SELECT * FROM work_project_domain_events WHERE task_id='finish' ORDER BY generation")).rows;
    expect(events[1].payload).toMatchObject({ fromLane: 'in_progress', toLane: 'qa' });
    const review = await WorkTaskDispatchModel.claimNextReview('sulla-desktop', [], 'review-runtime', 'finish');
    await WorkTaskDispatchModel.recordReviewLaunchWithExecution(review!.dispatch.id, {
      executionId: 'review-finish', workflowId: 'review', workflowName: 'Review', workflowSlug: 'review',
      triggerInput: '', scopeTaskId: 'finish', reviewerAgentIds: [],
    });
    expect(WorkflowExecutionModel.markRunning).toHaveBeenLastCalledWith(expect.objectContaining({ scopeGeneration: 2 }), expect.anything());
  });

  it.each(['legacy', 'protected'])('records a %s review transition into the actual custom blocked lane', async(mode) => {
    await pool.query(`INSERT INTO work_lane_definitions (lane_key, semantic_role, scope, project_id)
      VALUES ('needs_attention', 'blocked', 'project', 'enabled');
      INSERT INTO work_tasks (id, project_id, status) VALUES ('review-block', 'enabled', 'qa')`);
    const claim = await WorkTaskDispatchModel.claimNextReview('sulla-desktop', [], 'runtime', 'review-block');
    if (mode === 'legacy') {
      await WorkTaskDispatchModel.finalizeVerification(claim!.dispatch.id, 'BLOCKED', 'a'.repeat(40), null, 'Human gate');
    } else {
      const artifacts: any[] = [{ type: 'projects_evidence', canonicalRef: 'task:review-block', hash: 'a'.repeat(64) }];
      const generationHash = WorkTaskDispatchModel.reviewGenerationHash(artifacts);
      await pool.query('UPDATE work_task_dispatches SET review_generation_hash=$2 WHERE id=$1', [claim!.dispatch.id, generationHash]);
      await WorkTaskDispatchModel.finalizeProtectedReview(claim!.dispatch.id, 'BLOCKED', {
        workflowExecutionId: 'review-block', reviewerAgentIds: [], excludedAgentIds: [], generationHash,
        artifactTypes: ['projects_evidence'], artifacts, artifactType: 'projects_evidence', artifactRef: 'task:review-block',
        artifactHash: 'a'.repeat(64), summary: 'Human gate', checks: [], findings: [],
      }, artifacts);
    }
    expect((await pool.query("SELECT status FROM work_tasks WHERE id='review-block'")).rows[0].status).toBe('needs_attention');
    const event = (await pool.query("SELECT * FROM work_project_domain_events WHERE task_id='review-block'")).rows[0];
    expect(event.payload).toMatchObject({ fromLane: 'qa', toLane: 'needs_attention' });
    expect((await pool.query("SELECT lane_key FROM work_lane_entry_automations WHERE task_id='review-block'")).rows[0].lane_key).toBe('needs_attention');
  });

  it('prefers successful Done over a project Cancelled override', async() => {
    await pool.query(`INSERT INTO work_lane_definitions (lane_key, semantic_role, scope, project_id)
      VALUES ('done', 'terminal', 'global_default', null), ('cancelled', 'terminal', 'project', 'enabled');
      INSERT INTO work_tasks (id, project_id, status) VALUES ('pass', 'enabled', 'qa')`);
    const target = (await pool.query(`SELECT ${ taskLaneTargetSql('t', "'done'") } AS target FROM work_tasks t WHERE id='pass'`)).rows[0];
    expect(target.target).toBe('done');
    const claim = await WorkTaskDispatchModel.claimNextReview('sulla-desktop', [], 'runtime', 'pass');
    await WorkTaskDispatchModel.finalizeVerification(claim!.dispatch.id, 'APPROVE', 'a'.repeat(40), 'a'.repeat(40), 'Passed');
    expect((await pool.query("SELECT status FROM work_tasks WHERE id='pass'")).rows[0].status).toBe('done');
  });

});
