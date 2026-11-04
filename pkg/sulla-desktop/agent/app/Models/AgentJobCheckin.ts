// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Model } from '@sulla/foundation';

export class AgentJobCheckin extends Model<Record<string, unknown>> {
  static table = 'agent_job_checkins';
  static primaryKey = 'id';
  static casts = { task_index: 'number', files_touched: 'json', blockers: 'json', percent: 'number' } as const;
}
