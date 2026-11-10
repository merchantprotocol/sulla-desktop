// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobReviewItemRepository } from '../Repositories/AgentJobReviewItemRepository';

/** Prevents a task from returning while review findings remain unresolved. */
export class ReviewObligationGate {
  constructor(private readonly items: AgentJobReviewItemRepository) {}
  async refusal(jobId: string, taskIndex: number): Promise<string | null> {
    const open = await this.items.itemsForTask(jobId, taskIndex, true);
    if (!open.length) return null;
    return `Cannot return while review items remain open/acknowledged: ${open.map(item => `${item.id}: ${item.text}`).join('; ')}. Close each with reviewUpdates: fixed + commit sha or wont_fix + reason.`;
  }
}
