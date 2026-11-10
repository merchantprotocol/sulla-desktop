// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobTask } from '../../tools/agents/jobRegistry';

/** Builds the actionable response for an orchestrator addressing a returned task with unread output. */
export class PendingReturnedTaskMessage {
  forTask(task: AgentJobTask): string | undefined {
    if (!(task.returnedAt || task.finishedAt) || !task.completion || task.completionDeliveredAt) return undefined;
    const returnedAt = task.returnedAt ?? task.finishedAt!;
    return `Task returned at ${new Date(returnedAt).toISOString()}; its result is pending in your inbox — read it first.`;
  }
}
