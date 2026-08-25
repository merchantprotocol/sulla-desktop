/** @jest-environment node */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';

import { up as createWorkItems } from '../../../database/migrations/0044_create_work_items_tables';
import { up as addTaskActors } from '../../../database/migrations/0047_add_work_task_actor';
import { PostgresProjectsUnitOfWork } from '../PostgresProjectsUnitOfWork';

const integration = process.env.PROJECTS_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

integration('PostgresProjectsUnitOfWork migrated PostgreSQL', () => {
  const schema = `projects_oop_${ randomUUID().replaceAll('-', '') }`;
  const config = {
    host:     '127.0.0.1',
    port:     30116,
    user:     'sulla',
    password: process.env.SULLA_POSTGRES_PASSWORD ?? 'sulla_dev_password',
    database: 'sulla',
    max:      4,
  };
  let pool = new Pool(config);

  const acquire = async() => {
    const client = await pool.connect();
    await client.query(`SET search_path TO "${ schema }"`);
    return client;
  };

  beforeAll(async() => {
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${ schema }"`);
      await client.query(`SET search_path TO "${ schema }"`);
      await client.query(createWorkItems);
      await client.query(addTaskActors);
      await client.query(`INSERT INTO work_projects (id, slug, title) VALUES ('project-1', 'project-1', 'Project')`);
      await client.query(`INSERT INTO work_epics (id, project_id, title) VALUES ('epic-1', 'project-1', 'Epic')`);
      await client.query(`INSERT INTO work_tasks (id, project_id, epic_id, title) VALUES ('task-1', 'project-1', 'epic-1', 'Task')`);
    } finally {
      client.release();
    }
  });

  afterAll(async() => {
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${ schema }" CASCADE`);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('rolls back a multi-record lifecycle command', async() => {
    const unitOfWork = new PostgresProjectsUnitOfWork(acquire);
    await expect(unitOfWork.execute(async(repositories) => {
      await repositories.tasks.compareAndSetLane({
        taskId: 'task-1', expectedLane: 'todo', destinationLane: 'in_progress', actor: 'test',
      });
      await repositories.comments.append({ id: 'rollback-comment', taskId: 'task-1', body: 'rollback', author: 'test' });
      throw new Error('rollback probe');
    })).rejects.toThrow('rollback probe');

    const client = await acquire();
    try {
      const task = await client.query(`SELECT status FROM work_tasks WHERE id = 'task-1'`);
      const comment = await client.query(`SELECT id FROM work_task_comments WHERE id = 'rollback-comment'`);
      expect(task.rows[0].status).toBe('todo');
      expect(comment.rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('allows exactly one concurrent compare-and-set winner and survives pool restart', async() => {
    const first = new PostgresProjectsUnitOfWork(acquire);
    const second = new PostgresProjectsUnitOfWork(acquire);
    const results = await Promise.all([
      first.execute(repositories => repositories.tasks.compareAndSetLane({
        taskId: 'task-1', expectedLane: 'todo', destinationLane: 'in_progress', actor: 'first',
      })),
      second.execute(repositories => repositories.tasks.compareAndSetLane({
        taskId: 'task-1', expectedLane: 'todo', destinationLane: 'planning', actor: 'second',
      })),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    await pool.end();
    pool = new Pool(config);
    const client = await acquire();
    try {
      const persisted = await client.query(`SELECT status FROM work_tasks WHERE id = 'task-1'`);
      expect(['in_progress', 'planning']).toContain(persisted.rows[0].status);
    } finally {
      client.release();
    }
  });
});
