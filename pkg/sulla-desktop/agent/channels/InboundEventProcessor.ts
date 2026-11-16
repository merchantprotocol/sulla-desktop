// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { ChannelAdapter, ChannelEventHandler, ConversationBindingRepository, InboundMessageDelivery, InboundRouter } from './types';
export class InboundEventProcessor implements ChannelEventHandler {
  constructor(private readonly adapter: ChannelAdapter<Record<string, unknown>>, private readonly receipts: ConversationBindingRepository,
    private readonly router: InboundRouter, private readonly delivery: InboundMessageDelivery,
    private readonly acknowledge?: (ids: string[]) => Promise<void>) {}
  async handle(frame: Record<string, unknown>): Promise<void> {
    const event = frame.event as Record<string, unknown>;
    if (!event) { await this.ackFrame(frame); return; }
    const message = this.adapter.normalize(event, frame);
    if (!message) { await this.ackFrame(frame); return; }
    if (!(await this.receipts.claimReceipt(message.channel, message.eventId))) {
      if (await this.receipts.isReceiptComplete(message.channel, message.eventId)) await this.ackFrame(frame);
      return;
    }
    try {
      const route = await this.router.route(message);
      if (route) await this.delivery.deliver(route.binding, message, route.content, route.trustLevel);
      await this.receipts.completeReceipt(message.channel, message.eventId);
      await this.ackFrame(frame);
    } catch (error) {
      await this.receipts.releaseReceipt(message.channel, message.eventId);
      throw error;
    }
  }
  private async ackFrame(frame: Record<string, unknown>): Promise<void> { if (typeof frame.id === 'string' && this.acknowledge) await this.acknowledge([frame.id]); }
}
