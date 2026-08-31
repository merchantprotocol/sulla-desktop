import process from 'node:process';

import { Pool } from 'pg';

const [connectionString, schema, seam, taskId] = process.argv.slice(2);

if (!connectionString || !schema || !seam || !taskId) {
  throw new Error('usage: dispatcherCrashWorker <url> <schema> <seam> <task-id>');
}

const pool = new Pool({
  connectionString,
  max:     1,
  options: `-c search_path=${ schema }`,
});

async function seedRunning(): Promise<void> {
  await pool.query(`
    INSERT INTO work_tasks (id, project_id, epic_id, title, status, assignee)
    VALUES ($1, 'p1', 'e1', $2, 'in_progress', 'dispatcher')
  `, [taskId, `Crash seam ${ seam }`]);
  await pool.query(`
    INSERT INTO work_task_stage_claims
      (id, task_id, capability_key, stage, owner, runtime_instance_id, status, heartbeat_at)
    VALUES ($1, $2, 'todo-execution', 'in_progress', 'dispatcher', 'dead-runtime', 'active', now() - interval '2 hours')
  `, [`stage-${ taskId }`, taskId]);
  await pool.query(`
    INSERT INTO work_task_dispatches
      (id, task_id, agent_id, thread_id, kind, attempt, status, heartbeat_at)
    VALUES ($1, $2, 'sulla-desktop', $3, 'execution', 1, 'running', now() - interval '2 hours')
  `, [`dispatch-${ taskId }`, taskId, `thread-${ taskId }`]);
  await pool.query(`
    INSERT INTO dispatcher_liveness (id, last_tick_started_at, next_expected_tick_at, last_outcome, checking)
    VALUES (true, now(), now() - interval '1 minute', 'checking', true)
    ON CONFLICT (id) DO UPDATE SET
      last_tick_started_at = now(), next_expected_tick_at = now() - interval '1 minute',
      last_outcome = 'checking', checking = true
  `);
}

async function addExternalPullRequest(): Promise<void> {
  await pool.query(`
    INSERT INTO fault_soak_external_prs (task_id, url)
    VALUES ($1, $2)
  `, [taskId, `https://github.test/pull/${ taskId }`]);
}

async function appendJournal(): Promise<void> {
  await pool.query(`
    INSERT INTO work_task_outcome_journal
      (id, dispatch_id, task_id, dispatch_status, task_status, task_assignee, comment, result)
    VALUES ($1, $2, $3, 'completed', 'in_review', 'heartbeat', 'durable result', 'worker completed')
  `, [`journal-${ taskId }`, `dispatch-${ taskId }`, taskId]);
}

async function finalizeJournal(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE work_task_dispatches SET status = 'completed', result = 'worker completed', finished_at = now() WHERE id = $1`, [`dispatch-${ taskId }`]);
    await client.query(`UPDATE work_tasks SET status = 'in_review', assignee = 'heartbeat', updated_at = now() WHERE id = $1`, [taskId]);
    await client.query(`UPDATE work_task_stage_claims SET status = 'released', released_at = now() WHERE task_id = $1 AND status = 'active'`, [taskId]);
    await client.query(`UPDATE work_task_outcome_journal SET consumed_at = now() WHERE id = $1`, [`journal-${ taskId }`]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

async function crash(): Promise<never> {
  process.stdout.write(`FAULT_READY:${ seam }\n`);
  process.kill(process.pid, 'SIGKILL');
  return new Promise(() => {});
}

await seedRunning();
switch (seam) {
case 'claim-commit-before-graph':
  await crash();
  break;
case 'worker-return-before-journal':
  await addExternalPullRequest();
  await pool.query(`
    INSERT INTO workflow_executions
      (execution_id, workflow_id, workflow_name, workflow_slug, status, trigger_input, completed_at)
    VALUES ($1, 'dispatcher-worker', 'Dispatcher worker', 'dispatcher-worker', 'completed', '', now())
  `, [`workflow-${ taskId }`]);
  await pool.query(`UPDATE work_task_dispatches SET workflow_execution_id = $2 WHERE id = $1`, [`dispatch-${ taskId }`, `workflow-${ taskId }`]);
  await crash();
  break;
case 'journal-before-finalize':
  await addExternalPullRequest();
  await appendJournal();
  await crash();
  break;
case 'finalize-before-liveness':
  await addExternalPullRequest();
  await appendJournal();
  await finalizeJournal();
  await crash();
  break;
case 'recover-stale-mid-batch': {
  const secondTask = `${ taskId }-second`;
  await pool.query(`
    INSERT INTO work_tasks (id, project_id, epic_id, title, status, assignee)
    VALUES ($1, 'p1', 'e1', 'Second stale task', 'in_progress', 'dispatcher')
  `, [secondTask]);
  await pool.query(`
    INSERT INTO work_task_dispatches
      (id, task_id, agent_id, thread_id, kind, attempt, status, heartbeat_at)
    VALUES ($1, $2, 'sulla-desktop', $3, 'execution', 1, 'running', now() - interval '2 hours')
  `, [`dispatch-${ secondTask }`, secondTask, `thread-${ secondTask }`]);
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query(`UPDATE work_task_dispatches SET status = 'stale' WHERE id = $1`, [`dispatch-${ taskId }`]);
  await crash();
  break;
}
default:
  throw new Error(`unknown seam ${ seam }`);
}
