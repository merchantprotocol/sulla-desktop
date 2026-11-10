// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { ChannelInboundDelivery } from '@pkg/agent/channels/ChannelInboundDelivery';
import { EmptyThreadContextSource } from '@pkg/agent/channels/EmptyThreadContextSource';
import { InboundEventProcessor } from '@pkg/agent/channels/InboundEventProcessor';
import { InboundRouterService } from '@pkg/agent/channels/InboundRouterService';
import { PostgresConversationBindingRepository } from '@pkg/agent/app/Repositories/PostgresConversationBindingRepository';
import { SlackChannelAdapter } from '@pkg/agent/channels/SlackChannelAdapter';
import { SlackSenderAllowlist } from '@pkg/agent/channels/SlackSenderAllowlist';
import { ExistingSlackJobSender, LocalSlackChatSender, ConversationHistorySlackThreadFactory } from './SlackInboundServices';
import { SlackCloudClient, type SlackInboundFrame } from './SlackCloudClient';

/** Wires Cloud push and offline-drain events into the durable local channel pipeline. */
export class SlackInboundRuntime {
  private readonly processor: InboundEventProcessor;
  private draining: Promise<void> | null = null;

  constructor(private readonly cloud: SlackCloudClient, processor?: InboundEventProcessor) {
    const bindings = new PostgresConversationBindingRepository();
    const router = new InboundRouterService(bindings, new SlackSenderAllowlist(), new ConversationHistorySlackThreadFactory(), new EmptyThreadContextSource());
    const delivery = new ChannelInboundDelivery(new LocalSlackChatSender(), new ExistingSlackJobSender());
    this.processor = processor ?? new InboundEventProcessor(new SlackChannelAdapter(), bindings, router, delivery, ids => cloud.ack(ids));
  }

  handle(frame: Record<string, unknown>): Promise<void> { return this.processor.handle(frame); }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.processPending().finally(() => { this.draining = null; });
    return this.draining;
  }

  private async processPending(): Promise<void> {
    const frames = await this.cloud.pending();
    const failures: unknown[] = [];
    for (const frame of frames) {
      try { await this.processor.handle(frame as unknown as Record<string, unknown>); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'One or more Slack inbound events failed');
  }
}
