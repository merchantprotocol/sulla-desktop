// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AgentCompletionInboxService } from '../Services/AgentCompletionInboxService';
import { AgentCompletionRecoveryService } from '../Services/AgentCompletionRecoveryService';
import { CompletionFormatter } from '../Services/CompletionFormatter';
import { CompletionIdleDispatcher } from '../Services/CompletionIdleDispatcher';
import { getPendingCompletions } from '../../tools/agents/jobRegistry';

export const COMPLETION_RESULT_LIMIT = 8_000;

export class AgentCompletionServiceProvider {
  readonly inbox: AgentCompletionInboxService;
  readonly recovery: AgentCompletionRecoveryService;

  constructor() {
    const dispatcher = new CompletionIdleDispatcher();
    this.inbox = new AgentCompletionInboxService(
      dispatcher,
      new CompletionFormatter(COMPLETION_RESULT_LIMIT),
    );
    this.recovery = new AgentCompletionRecoveryService({ getPendingCompletions }, this.inbox);
  }

  dispose(): void {
    this.recovery.dispose();
    this.inbox.dispose();
  }
}

export const agentCompletionProvider = new AgentCompletionServiceProvider();
