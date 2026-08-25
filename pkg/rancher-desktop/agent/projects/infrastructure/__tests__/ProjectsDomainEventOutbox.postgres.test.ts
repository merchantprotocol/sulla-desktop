import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../../database/PostgresClient';
import { up as createWorkItems } from '../../../database/migrations/0044_create_work_items_tables';
import { up as createDomainEventOutbox } from '../../../database/migrations/0086_create_projects_domain_event_outbox';
import { createPostgresProjectsRepositories } from '../PostgresProjectsRepositories';
import { ProjectsDomainEventOutbox } from '../ProjectsDomainEventOutbox';
import { WorkItemsModel } from '../../../database/models/WorkItemsModel';
import { ProjectsOrchestrationEventService } from '../../application/ProjectsOrchestrationEventService';
import { TaskLifecycleOrchestrationService } from '../../application/TaskLifecycleOrchestrationService';

const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const describeWithPostgres = connectionString ? describe : describe.skip;

describeWithPostgres('Projects domain-event outbox (migrated PostgreSQL)', () => {
  let bootstrapPool: Pool;
  let pool: Pool;
  const schema = `projects_outbox_${ randomUUID().replaceAll('-', '') }`;
  const originalQuery = postgresClient.query;
  const originalTransaction = postgresClient.transaction;

  beforeAll(async() => {
    bootstrapPool = new Pool({ connectionString, max: 1 });
    await bootstrapPool.query(`CREATE SCHEMA "${ schema }"`);
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${ schema }` });
    await pool.query(createWorkItems);
    await pool.query(createDomainEventOutbox);
    (postgresClient as any).query = async(text: string, params: unknown[] = []) =>
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
  });

  afterAll(async() => {
    jest.restoreAllMocks();
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).transaction = originalTransaction;
    await pool?.end();
    await bootstrapPool?.query(`DROP SCHEMA IF EXISTS "${ schema }" CASCADE`);
    await bootstrapPool?.end();
  });

  beforeEach(async() => {
    await pool.query('TRUNCATE work_project_domain_events, work_tasks, work_epics, work_projects CASCADE');
    await pool.query(`
      INSERT INTO work_projects (id, slug, title) VALUES ('p1', 'p1', 'P1');
      INSERT INTO work_epics (id, project_id, title) VALUES ('e1', 'p1', 'E1');
      INSERT INTO work_tasks (id, project_id, epic_id, title, status)
      VALUES ('t1', 'p1', 'e1', 'T1', 'todo');
    `);
  });

  it('reclaims an expired processing lease after a crash and settles by exact owner', async() => {
    await postgresClient.transaction(async(client) => {
      await createPostgresProjectsRepositories(client).events.append({
        id: 'event-1', taskId: 't1', generation: 1,
        eventType: 'projects.task.transitioned', idempotencyKey: 'transition:t1:1',
        payload: { fromLane: 'backlog', toLane: 'todo' }, occurredAt: new Date(),
      });
    });
    const first = await ProjectsDomainEventOutbox.claim('owner-a', 1, 15);
    expect(first).toHaveLength(1);
    await pool.query(`UPDATE work_project_domain_events SET leased_until = now() - interval '1 second' WHERE id = 'event-1'`);
    const reclaimed = await ProjectsDomainEventOutbox.claim('owner-b', 1, 15);
    expect(reclaimed[0]).toMatchObject({ id: 'event-1', lease_owner: 'owner-b', attempts: 2 });
    await expect(ProjectsDomainEventOutbox.complete('event-1', 'owner-a')).resolves.toBe(false);
    await expect(ProjectsDomainEventOutbox.complete('event-1', 'owner-b')).resolves.toBe(true);
  });

  it('rolls back task mutation and event append together', async() => {
    await expect(postgresClient.transaction(async(client) => {
      await client.query(`UPDATE work_tasks SET status = 'in_review' WHERE id = 't1'`);
      await createPostgresProjectsRepositories(client).events.append({
        id: 'event-rollback', taskId: 't1', generation: 1,
        eventType: 'projects.task.transitioned', idempotencyKey: 'transition:t1:rollback',
        payload: {}, occurredAt: new Date(),
      });
      throw new Error('abort transition');
    })).rejects.toThrow('abort transition');
    expect((await pool.query(`SELECT status FROM work_tasks WHERE id = 't1'`)).rows[0].status).toBe('todo');
    expect((await pool.query(`SELECT id FROM work_project_domain_events WHERE id = 'event-rollback'`)).rows).toHaveLength(0);
  });

  it('replays every lifecycle frontier through the runtime dispatcher after restart', async() => {
    const lifecycle = jest.spyOn(TaskLifecycleOrchestrationService, 'handleCommittedTransition').mockResolvedValue();
    // Keep the runtime read path real: WorkItemsModel reads through the
    // disposable migrated pool installed in beforeAll.
    const cases = [
      ['in_progress', 'in_review', 'execution-review'],
      ['in_review', 'todo', 'review-repair'],
      ['in_review', 'planning', 'review-planning'],
      ['in_review', 'blocked', 'review-wait'],
      ['in_review', 'done', 'review-done'],
      ['blocked', 'planning', 'blocked-planning'],
      ['blocked', 'in_review', 'blocked-wait-release'],
    ] as const;

    let generation = 10;
    for (const [fromLane, toLane, scenario] of cases) {
      generation++;
      await pool.query('UPDATE work_tasks SET status = $1 WHERE id = $2', [toLane, 't1']);
      await postgresClient.transaction(async(client) => {
        await createPostgresProjectsRepositories(client).events.append({
          id: `event-${ scenario }`, taskId: 't1', generation,
          eventType: 'projects.task.transitioned',
          idempotencyKey: `transition:t1:${ generation }`,
          payload: { fromLane, toLane, laneAutomated: false, scenario },
          occurredAt: new Date(),
        });
      });

      // A new service instance models process restart: no in-memory queue or
      // owner state is reused; the committed outbox row is the sole handoff.
      const restarted = new ProjectsOrchestrationEventService(`restart-owner-${ generation }`, async() => undefined);
      await expect(restarted.drain(1)).resolves.toEqual({ completed: 1, retried: 0, unhandled: 0 });
      expect(lifecycle).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 't1', status: toLane }), fromLane, undefined,
      );
      const stored = await pool.query('SELECT status FROM work_project_domain_events WHERE id = $1', [`event-${ scenario }`]);
      expect(stored.rows[0].status).toBe('completed');
    }

    expect(lifecycle).toHaveBeenCalledTimes(cases.length);
    // Guard the test against accidentally replacing the real current-task
    // lookup with a mocked shortcut.
    expect(jest.isMockFunction(WorkItemsModel.getTask)).toBe(false);
  });
});
