/**
 * Migration 0114 — one delegation record: agent tabs become agent_jobs.
 *
 * Hidden sub-agents and agent tabs were two stores (agent_jobs and
 * agent_tab_contracts), so a tab never showed up in its parent's sub-agent
 * rail. A tab is now a job with visibility 'tab': one task whose contract,
 * depth and result live in the task JSON, like a hidden worker's.
 *
 * Open and returned tab contracts are copied in as tab jobs. The job id IS
 * the old contract id, so open tabs (which carry contractId) keep returning
 * through the same id. agent_tab_contracts is left in place, frozen: nothing
 * writes to it after this migration. Returned rows count as delivered — the
 * old path already injected their result into the parent.
 */
export const up = `
  ALTER TABLE agent_jobs
    ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'hidden',
    ADD COLUMN IF NOT EXISTS parent_agent_id TEXT;

  CREATE INDEX IF NOT EXISTS idx_agent_jobs_open_tabs
    ON agent_jobs (parent_thread_id)
    WHERE visibility = 'tab' AND status = 'running';

  INSERT INTO agent_jobs (
    job_id, status, task_count, results, created_at, finished_at,
    parent_channel, parent_thread_id, parent_agent_id, completion_delivered_at,
    tasks, visibility
  )
  SELECT
    c.id,
    CASE c.status WHEN 'open' THEN 'running' ELSE 'completed' END,
    1,
    CASE WHEN c.status = 'returned' THEN jsonb_build_array(jsonb_build_object(
      'label',    c.title,
      'status',   'completed',
      'output',   COALESCE(c.result::text, ''),
      'threadId', c.child_thread_id,
      'contract', COALESCE(c.contract_spec->>'name', 'result'),
      'result',   c.result
    )) ELSE '[]'::jsonb END,
    c.created_at,
    c.returned_at,
    c.parent_channel,
    c.parent_thread_id,
    c.parent_agent_id,
    CASE WHEN c.status = 'returned' THEN COALESCE(c.returned_at, c.created_at) END,
    jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'agentId',    c.child_agent_id,
      'label',      c.title,
      'prompt',     c.brief,
      'status',     CASE c.status WHEN 'open' THEN 'running' ELSE 'completed' END,
      'threadId',   c.child_thread_id,
      'startedAt',  (extract(epoch FROM c.created_at) * 1000)::bigint,
      'finishedAt', (extract(epoch FROM c.returned_at) * 1000)::bigint,
      'returnedAt', (extract(epoch FROM c.returned_at) * 1000)::bigint,
      'visibility', 'tab',
      'contract',   CASE WHEN c.contract_spec = '{}'::jsonb THEN jsonb_build_object('name', 'result') ELSE c.contract_spec END,
      'depth',      c.depth,
      'result',     c.result
    ))),
    'tab'
  FROM agent_tab_contracts c
  WHERE c.status IN ('open', 'returned')
  ON CONFLICT (job_id) DO NOTHING;
`;

export const down = `
  DELETE FROM agent_jobs
   WHERE visibility = 'tab'
     AND job_id IN (SELECT id FROM agent_tab_contracts);
  DROP INDEX IF EXISTS idx_agent_jobs_open_tabs;
  ALTER TABLE agent_jobs
    DROP COLUMN IF EXISTS parent_agent_id,
    DROP COLUMN IF EXISTS visibility;
`;
