// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { DecisionRecord } from '@pkg/shared/decisions';

export interface PublishApprovalOutcomeSender {
  deliver(record: DecisionRecord, message: string): Promise<boolean>;
}

interface JobMessageSender {
  send(jobId: string, taskIndex: number, message: string): Promise<boolean>;
}

interface ChatFollowUpSender {
  send(channel: string, threadId: string, message: string): Promise<boolean>;
}

/** Uses the durable delegated-job mailbox or the chat's normal inject-message follow-up path. */
export class PublishApprovalOutcomeDelivery implements PublishApprovalOutcomeSender {
  constructor(
    private readonly jobs: JobMessageSender = new SullaJobMessageSender(),
    private readonly chats: ChatFollowUpSender = new SullaChatFollowUpSender(),
  ) {}

  async deliver(record: DecisionRecord, message: string): Promise<boolean> {
    const requester = record.requestedBy;
    if (requester?.jobId && Number.isInteger(requester.taskIndex)) {
      // A delegated requester is only ever reached through its job mailbox: a finished job has nobody left to tell.
      return this.jobs.send(requester.jobId, requester.taskIndex!, message);
    }
    return this.chats.send(record.channel, record.conversationId, message);
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
        content: `[Decision follow-up]\n${ message }`,
        metadata: { source: 'decision_follow_up', inputSource: 'system' },
      },
    });
  }
}
