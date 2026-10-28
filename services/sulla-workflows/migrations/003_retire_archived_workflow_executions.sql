-- SPDX-License-Identifier: GPL-2.0-or-later
UPDATE workflow_executions AS execution
   SET status = 'failed', auto_restart = FALSE,
       completed_at = COALESCE(execution.completed_at, NOW()),
       terminal_at = COALESCE(execution.terminal_at, NOW()),
       terminal_reason = 'workflow_archived',
       error = COALESCE(execution.error, 'workflow_archived'),
       owner_id = NULL, lease_token = NULL, lease_expires_at = NULL,
       updated_at = NOW()
  FROM workflows AS workflow
 WHERE workflow.id = execution.workflow_id
   AND workflow.status = 'archive'
   AND execution.status IN ('running', 'suspended');
