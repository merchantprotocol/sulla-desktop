// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { StopAttributionFormatter } from '../../agent/app/Formatters/StopAttributionFormatter';
import type { AgentStateRow } from '../../shared/agentState/AgentStateSnapshot';

export class AgentStateRowPresenter {
  constructor(private readonly stopFormatter: StopAttributionFormatter) {}

  statusLabel(row: AgentStateRow): string {
    if (row.killedByHuman) return 'Killed by human';
    return row.state;
  }

  stopAttribution(row: AgentStateRow): string {
    return this.stopFormatter.format(row.stoppedBy, row.stopReason);
  }
}
