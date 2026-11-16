// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { CompletionOwnerSource } from './AgentCompletionRecoveryService';
import type { CustodyRecord, CustodyTransactionClient } from './JobCustodyTypes';

/**
 * Defers loading the job provider so completion-service construction cannot
 * create an agent-provider import cycle; routes recovered completions to the
 * job/task's current custody owner.
 */
export class CustodyCompletionOwnerSource implements CompletionOwnerSource {
  async withOwner<T>(jobId: string, taskIndex: number | undefined, operation: (client: CustodyTransactionClient, owner: CustodyRecord) => Promise<T>): Promise<T | undefined> {
    const { agentJobProvider } = await import('../Providers/AgentJobServiceProvider');
    return agentJobProvider.custody.withOwner(jobId, taskIndex, operation);
  }
}
