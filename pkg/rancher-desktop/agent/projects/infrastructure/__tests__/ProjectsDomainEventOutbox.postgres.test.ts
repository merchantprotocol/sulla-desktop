import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../../database/PostgresClient';
import { up as createWorkItems } from '../../../database/migrations/0044_create_work_items_tables';
import { up as createDomainEventOutbox } from '../../../database/migrations/0086_create_projects_domain_event_outbox';
import { createPostgresProjectsRepositories } from '../PostgresProjectsRepositories';
import { ProjectsDomainEventOutbox } from '../ProjectsDomainEventOutbox';

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
});
