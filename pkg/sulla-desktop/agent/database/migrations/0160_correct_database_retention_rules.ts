// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Apply the corrected 48-hour ledger and 30-day checkpoint retention rules to existing rows. */
export const up = `
  DO $$
  DECLARE affected integer;
  BEGIN
    LOOP
      WITH expired AS (
        SELECT ctid FROM subject_memory.sent
        WHERE sent_at < NOW() - INTERVAL '48 hours'
        ORDER BY sent_at LIMIT 500
      )
      DELETE FROM subject_memory.sent AS sent USING expired WHERE sent.ctid = expired.ctid;
      GET DIAGNOSTICS affected = ROW_COUNT;
      EXIT WHEN affected = 0;
    END LOOP;

    LOOP
      WITH expired AS (
        SELECT checkpoint.id
        FROM workflow_checkpoints AS checkpoint
        JOIN workflow_executions AS execution USING (execution_id)
        WHERE execution.status = 'completed'
           OR (execution.status NOT IN ('running', 'suspended', 'waiting', 'queued', 'pending')
               AND checkpoint.created_at < NOW() - INTERVAL '30 days')
        ORDER BY checkpoint.created_at LIMIT 500
      )
      DELETE FROM workflow_checkpoints AS checkpoint USING expired WHERE checkpoint.id = expired.id;
      GET DIAGNOSTICS affected = ROW_COUNT;
      EXIT WHEN affected = 0;
    END LOOP;
  END $$;
`;

// Retention deletion is irreversible; a down migration cannot restore removed history.
export const down = '';
