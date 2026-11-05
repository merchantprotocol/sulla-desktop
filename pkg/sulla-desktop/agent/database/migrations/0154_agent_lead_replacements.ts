// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresClient } from '../PostgresClient';

export async function up(client:PostgresClient):Promise<void>{await client.query(`CREATE TABLE IF NOT EXISTS agent_lead_replacements (
  old_job_id TEXT NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
  old_task_index INTEGER NOT NULL,
  replacement_job_id TEXT,
  replacement_task_index INTEGER,
  replacement_thread_id TEXT,
  child_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  audit_done BOOLEAN NOT NULL DEFAULT FALSE,
  wrap_up_done BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(old_job_id,old_task_index)
)`);}
export async function down(client:PostgresClient):Promise<void>{await client.query(`DROP TABLE IF EXISTS agent_lead_replacements`);}
