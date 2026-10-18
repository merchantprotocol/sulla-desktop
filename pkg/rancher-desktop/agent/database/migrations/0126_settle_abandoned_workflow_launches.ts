/**
 * Runs left by the old manager launch path have a runner id but no evidence
 * that a runner ever acquired them. Preserve the audit row and settle only
 * that exact pre-lease shape.
 */
export const up = `
  UPDATE workflow_executions AS execution
     SET status = 'failed', auto_restart = FALSE,
         completed_at = COALESCE(execution.completed_at, NOW()),
         terminal_at = COALESCE(execution.terminal_at, NOW()),
         terminal_reason = 'abandoned_without_live_lease',
         error = COALESCE(execution.error, 'runner never acquired workflow lease'),
         runner_id = NULL, owner_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         updated_at = NOW()
   WHERE execution.status IN ('running', 'suspended')
     AND execution.runner_id IS NOT NULL
     AND execution.owner_id IS NULL
     AND execution.lease_token IS NULL
     AND execution.lease_expires_at IS NULL
     AND execution.heartbeat_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM workflow_checkpoints checkpoint
        WHERE checkpoint.execution_id = execution.execution_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM workflow_execution_events event
        WHERE event.execution_id = execution.execution_id
          AND event.event_type <> 'workflow_started'
     );
`;

// Terminal history is intentionally not resurrected on rollback.
export const down = ``;
