// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJob } from '../../tools/agents/jobRegistry';
import type { PendingCompletionSource } from './AgentCompletionRecoveryService';

/** Defers registry loading so completion-service construction cannot create an agent-provider import cycle. */
export class PendingCompletionRegistrySource implements PendingCompletionSource {
  async getPendingCompletions(): Promise<AgentJob[]> {
    const { getPendingCompletions } = await import('../../tools/agents/jobRegistry');
    return getPendingCompletions();
  }
}
