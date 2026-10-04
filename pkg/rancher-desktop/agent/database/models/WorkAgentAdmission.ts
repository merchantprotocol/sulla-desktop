/** SQL fragments used only with trusted aliases, inside projects-agent-admission. */
export function liveAgentTasksSql(): string {
  return `SELECT task_id FROM work_task_dispatches WHERE status = 'running'
    UNION SELECT task_id FROM work_task_planning_runs WHERE status = 'active'
    UNION SELECT task_id FROM work_task_stage_claims WHERE status = 'active'
    UNION SELECT task_id FROM work_lane_entry_automations WHERE status = 'running'`;
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
export function agentAdmissionSql(taskAlias: string, delegationOwner?: string): string {
  const taskId = `${ taskAlias }.id`;
  const delegation = delegationOwner
    ? `AND COALESCE(lane.workflow_snapshot->'laneContract'->>'owner', '') <> '${ delegationOwner }'`
    : '';
  return `AND (SELECT COUNT(DISTINCT live.task_id) FROM (${ liveAgentTasksSql() }) live
      WHERE live.task_id <> ${ taskId }) < 3
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
