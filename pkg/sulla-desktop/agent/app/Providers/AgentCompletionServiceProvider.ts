// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AgentCompletionInboxService } from '../Services/AgentCompletionInboxService';
import { AgentCompletionRecoveryService, CompletionDeliveryPolicy, SystemCompletionRecoveryTimer } from '../Services/AgentCompletionRecoveryService';
import { CompletionFormatter } from '../Services/CompletionFormatter';
import { CompletionIdleDispatcher } from '../Services/CompletionIdleDispatcher';
import { CustodyCompletionOwnerSource } from '../Services/CustodyCompletionOwnerSource';
import { PendingCompletionRegistrySource } from '../Services/PendingCompletionRegistrySource';

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
    this.recovery = new AgentCompletionRecoveryService(
      new PendingCompletionRegistrySource(),
      this.inbox,
      new CompletionDeliveryPolicy(),
      Date.now,
      new SystemCompletionRecoveryTimer(),
      new CustodyCompletionOwnerSource(),
    );
    this.recovery.start();
  }

  dispose(): void {
    this.recovery.dispose();
    this.inbox.dispose();
  }
}

export const agentCompletionProvider = new AgentCompletionServiceProvider();
