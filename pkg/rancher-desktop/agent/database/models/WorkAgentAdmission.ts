import { RoutineConcurrencyPolicy } from '../../services/RoutineConcurrencyPolicy';

/** SQL fragments used only with trusted aliases, inside projects-agent-admission. */
export function liveAgentTasksSql(): string {
  return `SELECT task_id FROM work_task_dispatches WHERE status = 'running'
    UNION SELECT task_id FROM work_task_planning_runs WHERE status = 'active'
    UNION SELECT task_id FROM work_task_stage_claims WHERE status = 'active'
    UNION SELECT task_id FROM work_lane_entry_automations WHERE status = 'running'`;
}

/**
 * Writer-evidence guard for orphan recovery. Appends predicates that are true
 * only when nothing indicates a live writer for the task: no active stage
 * claim heartbeat inside the window, no running/suspended workflow execution
 * with a fresh heartbeat or unexpired lease, and no running agent job that
 * references the task, and the execution is not in this process's live-writer
 * registry. `taskId`/`executionId` are trusted column expressions; `minutes`
 * and `liveExecutions` are bound parameter placeholders such as `$1::int` and
 * `$3::text[]`.
 */
export function noWriterEvidenceSql(taskId: string, executionId: string, minutes: string, liveExecutions: string): string {
  return `AND NOT (COALESCE(${ executionId }, '') = ANY(${ liveExecutions }))
    AND NOT EXISTS (
      SELECT 1 FROM work_task_stage_claims claim
       WHERE claim.task_id = ${ taskId } AND claim.status = 'active'
         AND claim.heartbeat_at >= now() - (${ minutes } * interval '1 minute')
    )
    AND NOT EXISTS (
      SELECT 1 FROM workflow_executions execution
       WHERE execution.execution_id = ${ executionId }
         AND execution.status IN ('running', 'suspended')
         AND (execution.heartbeat_at >= now() - (${ minutes } * interval '1 minute')
           OR execution.lease_expires_at > now())
    )
    AND NOT EXISTS (
      SELECT 1 FROM agent_jobs job
        JOIN work_tasks task ON task.id = ${ taskId }
       WHERE job.status = 'running'
         AND (job.job_id = task.source_ref OR COALESCE(job.results, '[]'::jsonb)::text LIKE '%' || task.id || '%')
    )`;
}

function canonicalReferenceSql(value: string): string {
  const reference = `regexp_replace(btrim(${ value }),
    '^https?://(www[.])?github[.]com/([^/]+/[^/]+)/(pull|issues)/([0-9]+)([/#?].*)?$',
    '\\2#\\4', 'i')`;
  return `CASE WHEN ${ reference } ~ '^[^/[:space:]]+/[^/#[:space:]]+#[0-9]+$'
    THEN lower(${ reference }) ELSE NULLIF(btrim(${ value }), '') END`;
}

function artifactReferencesSql(taskId: string): string {
  return `SELECT ${ canonicalReferenceSql('refs.value') } AS identity FROM (
    SELECT github_issue AS value FROM work_tasks WHERE id = ${ taskId }
    UNION ALL SELECT value FROM (
      SELECT custody FROM work_task_artifact_custody WHERE task_id = ${ taskId }
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) latest CROSS JOIN LATERAL (VALUES
      (latest.custody->>'prUrl'), (latest.custody->>'artifactUrl'),
      (latest.custody->>'artifactId'), (latest.custody->>'worktreePath')
    ) custody_refs(value)
    UNION ALL SELECT value FROM (
      SELECT artifact_url, artifact_location FROM work_task_dispatches WHERE task_id = ${ taskId }
        AND (artifact_url IS NOT NULL OR artifact_location IS NOT NULL)
      ORDER BY started_at DESC, id DESC LIMIT 1
    ) latest_dispatch CROSS JOIN LATERAL (VALUES
      (latest_dispatch.artifact_url), (latest_dispatch.artifact_location)
    ) dispatch_refs(value)
  ) refs WHERE NULLIF(btrim(refs.value), '') IS NOT NULL`;
}

/**
 * The task/PR remains visible in enumeration. Admission reserves its existing
 * identities by inserting a live writer before releasing the shared lock.
 * Only the named service may take over its same-task delegation marker; that
 * marker starts no agent. Custom workflows never get this exception.
 */
export async function agentAdmissionSql(taskAlias: string, delegationOwner?: string): Promise<string> {
  const limit = await RoutineConcurrencyPolicy.resolveTotalLimit();
  const taskId = `${ taskAlias }.id`;
  const delegation = delegationOwner
    ? `AND COALESCE(lane.workflow_snapshot->'laneContract'->>'owner', '') <> '${ delegationOwner }'`
    : '';
  return `AND (SELECT COUNT(*) FROM (${ liveAgentTasksSql() }) live
      WHERE live.task_id <> ${ taskId }) < ${ limit }
    AND NOT EXISTS (SELECT 1 FROM work_task_dispatches d
      WHERE d.task_id = ${ taskId } AND d.status = 'running')
    AND NOT EXISTS (SELECT 1 FROM work_task_stage_claims c
      WHERE c.task_id = ${ taskId } AND c.status = 'active')
    AND NOT EXISTS (SELECT 1 FROM work_task_planning_runs planning
      WHERE planning.task_id = ${ taskId } AND planning.status = 'active')
    AND NOT EXISTS (SELECT 1 FROM work_lane_entry_automations lane
      WHERE lane.task_id = ${ taskId } AND lane.status = 'running' ${ delegation })
    AND NOT EXISTS (
      SELECT 1 FROM (${ liveAgentTasksSql() }) live
      CROSS JOIN LATERAL (${ artifactReferencesSql('live.task_id') }) held
      JOIN LATERAL (${ artifactReferencesSql(taskId) }) wanted ON wanted.identity = held.identity
      WHERE live.task_id <> ${ taskId }
    )`;
}

/** Resolve configured lane roles inside the same transaction as admission. */
export function taskLaneRoleSql(alias: string): string {
  return `COALESCE((SELECT lane.semantic_role FROM work_lane_definitions lane
    WHERE lane.lane_key = ${ alias }.status AND lane.reset_at IS NULL
      AND lane.archived = false AND lane.enabled = true
      AND (lane.scope = 'global_default' OR (lane.scope = 'project' AND lane.project_id = ${ alias }.project_id))
    ORDER BY CASE WHEN lane.scope = 'project' THEN 0 ELSE 1 END LIMIT 1),
    CASE ${ alias }.status WHEN 'in_review' THEN 'review'
      WHEN 'done' THEN 'terminal' WHEN 'cancelled' THEN 'terminal'
      WHEN 'planning' THEN 'planning' WHEN 'blocked' THEN 'blocked' ELSE 'execution' END)`;
}

/** Translate a lifecycle outcome into the project's configured destination. */
export function taskLaneTargetSql(alias: string, value: string): string {
  const destination = `COALESCE((SELECT lane.lane_key FROM work_lane_definitions lane
    WHERE lane.reset_at IS NULL AND lane.archived = false AND lane.enabled = true
      AND lane.semantic_role = CASE ${ value } WHEN 'in_review' THEN 'review'
        WHEN 'done' THEN 'terminal' WHEN 'blocked' THEN 'blocked' ELSE NULL END
      AND (lane.scope = 'global_default' OR (lane.scope = 'project' AND lane.project_id = ${ alias }.project_id))
      AND NOT EXISTS (SELECT 1 FROM work_lane_definitions override
        WHERE override.scope = 'project' AND override.project_id = ${ alias }.project_id
          AND override.lane_key = lane.lane_key AND override.reset_at IS NULL AND lane.scope = 'global_default')
      AND (${ value } <> 'done' OR lane.lane_key NOT IN ('cancelled', 'parked'))
    ORDER BY CASE WHEN lane.lane_key = ${ value } THEN 0 ELSE 1 END,
      CASE WHEN lane.scope = 'project' THEN 0 ELSE 1 END, lane.position, lane.lane_key LIMIT 1), ${ value })`;
  return approvalSafeTargetSql(alias, destination);
}

/** Keep consideration broad; stop automatic movement at the actual approval boundary. */
export function approvalSafeTargetSql(alias: string, destination: string, projectEntry = false): string {
  return `(WITH effective AS (
    SELECT DISTINCT ON (lane.lane_key) lane.* FROM work_lane_definitions lane
    WHERE lane.reset_at IS NULL
      AND (lane.scope = 'global_default' OR (lane.scope = 'project' AND lane.project_id = ${ alias }.project_id))
    ORDER BY lane.lane_key, CASE WHEN lane.scope = 'project' THEN 0 ELSE 1 END
  ), active AS (SELECT * FROM effective WHERE enabled = true AND archived = false)
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM active WHERE requires_human_approval) AND (
      NOT EXISTS (SELECT 1 FROM active WHERE lane_key = ${ destination })
      OR (${ projectEntry ? 'false' : `NOT EXISTS (SELECT 1 FROM active WHERE lane_key = ${ alias }.status)` }))
    THEN ${ alias }.status
    WHEN EXISTS (SELECT 1 FROM work_task_waits w WHERE w.task_id = ${ alias }.id
      AND w.status = 'active' AND w.wait_kind = 'human_gate')
      OR EXISTS (SELECT 1 FROM active WHERE lane_key = ${ alias }.status AND requires_human_approval)
    THEN ${ alias }.status
    ELSE COALESCE((SELECT gate.lane_key FROM active gate
      WHERE gate.requires_human_approval
        AND gate.position > ${ projectEntry ? "'-Infinity'::float8" : `(SELECT position FROM active WHERE lane_key = ${ alias }.status)` }
        AND gate.position < (SELECT position FROM active WHERE lane_key = ${ destination })
      ORDER BY gate.position, gate.lane_key LIMIT 1), ${ destination }) END)`;
}

/** Completion metadata follows this project's effective destination definition. */
export function taskTargetCompletedSql(alias: string, destination: string): string {
  return `COALESCE((SELECT lane.semantic_role = 'terminal' AND NOT lane.requires_human_approval
    AND lane.enabled = true AND lane.archived = false FROM work_lane_definitions lane
    WHERE lane.lane_key = ${ destination } AND lane.reset_at IS NULL
      AND (lane.scope = 'global_default' OR (lane.scope = 'project' AND lane.project_id = ${ alias }.project_id))
    ORDER BY CASE WHEN lane.scope = 'project' THEN 0 ELSE 1 END LIMIT 1),
    ${ destination } IN ('done', 'cancelled', 'parked'))`;
}
