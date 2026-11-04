// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Model } from '@sulla/foundation';

export class AgentJob extends Model<Record<string, unknown>> {
  static table = 'agent_jobs';
  static primaryKey = 'job_id';
  static casts = { task_count: 'number', results: 'json', tasks: 'json', project_task_ids: 'json' } as const;
}
