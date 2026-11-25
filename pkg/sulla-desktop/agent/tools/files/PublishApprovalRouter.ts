// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentJobTaskTarget } from '../../database/models/AgentJobMessagingModel';
import type { DecisionRecord } from '@pkg/shared/decisions';
import { DecisionRouteResolver } from '../../services/DecisionRouteResolver';

export interface PublishApprovalTaskReader {
  taskForThread(threadId: string): Promise<AgentJobTaskTarget | null>;
}

export type PublishApprovalRequester = NonNullable<DecisionRecord['requestedBy']> & { jobId: string; taskIndex: number };

/** Where the approval card is shown: the asker's own chat, or the visible chat above a hidden asker. */
export type PublishApprovalCardTarget =
  | { kind: 'requester_chat' }
  | { kind: 'ancestor_chat'; channel: string; threadId: string };

/** Who hears the outcome: the asking job task through its mailbox, or the asking chat. */
export type PublishApprovalOutcomeTarget =
  | { kind: 'job_task'; jobId: string; taskIndex: number }
  | { kind: 'chat'; channel: string; threadId: string };

type RoutedDecision = Pick<DecisionRecord, 'conversationId' | 'channel' | 'requestedBy'>;

/**
 * The single place that decides where a Files publish approval travels:
 * who asked, which chat shows the card and who is told the outcome. Every
 * answer comes from persisted job ancestry and the decision record, never
 * from tool input or transcript text.
 */
export class PublishApprovalRouter {
  private static readonly UNNAMED_AGENT = 'default agent';
  private readonly routes: DecisionRouteResolver;

  constructor(private readonly tasks: PublishApprovalTaskReader) { this.routes = new DecisionRouteResolver(tasks) }

  /** The delegated task that is asking, or undefined for a chat the human talks to directly. */
  async requester(threadId: string): Promise<PublishApprovalRequester | undefined> {
    const task = await this.tasks.taskForThread(threadId);
    if (!task) return undefined;
    return {
      agentId:   task.agentId || task.label || PublishApprovalRouter.UNNAMED_AGENT,
      ...(task.label ? { label: task.label } : {}),
      jobId:     task.jobId,
      taskIndex: task.taskIndex,
    };
  }

  /** A hidden child thread has no tab, so its card climbs job ancestry to the top visible chat. */
  async cardTarget(record: RoutedDecision): Promise<PublishApprovalCardTarget> {
    const chain = await this.routes.resolve(record.conversationId, record.channel);
    const human = chain[chain.length - 1];
    return human?.threadId === record.conversationId
      ? { kind: 'requester_chat' }
      : { kind: 'ancestor_chat', channel: human.channel, threadId: human.threadId };
  }

  /** A delegated asker is only ever reached through its job mailbox: a finished job has nobody left to tell. */
  async outcomeTarget(record: RoutedDecision): Promise<PublishApprovalOutcomeTarget> {
    const requester = record.requestedBy;
    if (requester?.jobId && Number.isInteger(requester.taskIndex)) {
      return { kind: 'job_task', jobId: requester.jobId, taskIndex: requester.taskIndex! };
    }
    return { kind: 'chat', channel: record.channel, threadId: record.conversationId };
  }
}
