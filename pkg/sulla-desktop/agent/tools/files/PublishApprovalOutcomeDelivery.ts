// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord } from '@pkg/shared/decisions';
import type { PublishApprovalRouter } from './PublishApprovalRouter';

export interface PublishApprovalOutcomeSender {
  deliver(record: DecisionRecord, message: string): Promise<boolean>;
}

interface JobMessageSender {
  send(jobId: string, taskIndex: number, message: string): Promise<boolean>;
}

interface ChatFollowUpSender {
  send(channel: string, threadId: string, message: string): Promise<boolean>;
}

/** Carries an outcome to the target the router names: the durable job mailbox or the chat's follow-up path. */
export class PublishApprovalOutcomeDelivery implements PublishApprovalOutcomeSender {
  constructor(
    private readonly router: Pick<PublishApprovalRouter, 'outcomeTarget'>,
    private readonly jobs: JobMessageSender = new SullaJobMessageSender(),
    private readonly chats: ChatFollowUpSender = new SullaChatFollowUpSender(),
  ) {}

  async deliver(record: DecisionRecord, message: string): Promise<boolean> {
    const target = await this.router.outcomeTarget(record);
    if (target.kind === 'job_task') return this.jobs.send(target.jobId, target.taskIndex, message);
    return this.chats.send(target.channel, target.threadId, message);
  }
}

class SullaJobMessageSender implements JobMessageSender {
  async send(jobId: string, taskIndex: number, message: string): Promise<boolean> {
    const { sendJobMessage } = await import('../agents/send_job_message');
    return (await sendJobMessage({ jobId, taskIndex, message })).successBoolean;
  }
}

class SullaChatFollowUpSender implements ChatFollowUpSender {
  async send(channel: string, threadId: string, message: string): Promise<boolean> {
    const { getWebSocketClientService } = await import('../../services/WebSocketClientService');
    return getWebSocketClientService().send(channel, {
      type: 'inject_message',
      data: {
        threadId,
        content: message,
        metadata: { source: 'decision_follow_up', inputSource: 'system' },
      },
    });
  }
}
