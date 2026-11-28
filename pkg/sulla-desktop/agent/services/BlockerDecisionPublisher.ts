// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobCheckinReceipt } from '../database/models/AgentJobMessagingModel';
import type { BlockerDecisionInput } from './DecisionService';

export interface BlockerDecisionAccess {
  reconcileBlockerDecision(input: BlockerDecisionInput): Promise<void>;
  openBlockerTaskKeys(jobIds: string[]): Promise<Set<string>>;
}

/** Publishes each durable worker blocker as one durable, answerable parent decision. */
export class BlockerDecisionPublisher {
  constructor(private readonly decisions: BlockerDecisionAccess) {}

  async publish(receipt: AgentJobCheckinReceipt, threadId: string, fallbackChannel: string): Promise<void> {
    const target = receipt.target;
    const conversationId = target.threadId || threadId;
    if (!conversationId) throw new Error('A delegated thread is required to publish a blocker decision.');

    await this.decisions.reconcileBlockerDecision({
      conversationId,
      channel: target.parentChannel || fallbackChannel || 'sulla-desktop',
      jobId: target.jobId,
      taskIndex: target.taskIndex,
      label: target.label || target.agentId || `task ${ target.taskIndex }`,
      blockers: receipt.checkin.blockers,
      blockersChanged: receipt.blockersChanged,
    });
  }

  openBlockerTaskKeys(jobIds: string[]): Promise<Set<string>> {
    return this.decisions.openBlockerTaskKeys(jobIds);
  }
}

/** Lazy lookup avoids a provider initialization cycle with DecisionService. */
export class RuntimeBlockerDecisionAccess implements BlockerDecisionAccess {
  async reconcileBlockerDecision(input: BlockerDecisionInput): Promise<void> {
    const { decisionService } = await import('./DecisionService');
    await decisionService.reconcileBlockerDecision(input);
  }

  async openBlockerTaskKeys(jobIds: string[]): Promise<Set<string>> {
    const { decisionService } = await import('./DecisionService');
    return decisionService.openBlockerTaskKeys(jobIds);
  }
}
