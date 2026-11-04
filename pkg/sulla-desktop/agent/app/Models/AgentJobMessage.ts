// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Model } from '@sulla/foundation';

export class AgentJobMessage extends Model<Record<string, unknown>> {
  static table = 'agent_job_messages';
  static primaryKey = 'id';
  static casts = { task_index: 'number' } as const;
}
