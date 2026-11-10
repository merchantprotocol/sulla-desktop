// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { ChannelInboundDelivery } from '@pkg/agent/channels/ChannelInboundDelivery';
import { SlackThreadContextSource } from '@pkg/agent/channels/SlackThreadContextSource';
import { SlackWorkspaceAccountRegistry } from '@pkg/agent/channels/SlackWorkspaceAccountRegistry';
import { SlackSystemContextIssuer } from '@pkg/agent/integrations/slack/SlackSystemContextIssuer';
import { SlackAccountResolver } from '@pkg/agent/integrations/slack/SlackAccountResolver';
import { BrokerSlackApiTransport } from '@pkg/agent/integrations/slack/BrokerSlackApiTransport';
import { SlackWebApiClient } from '@pkg/agent/integrations/slack/SlackWebApiClient';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { SlackWorkspaceRegistrar } from './SlackWorkspaceRegistrar';
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
  private readonly accountsByTeam = new SlackWorkspaceAccountRegistry();
  private readonly workspaceRegistrar: SlackWorkspaceRegistrar;
  private draining: Promise<void> | null = null;

  constructor(private readonly cloud: SlackCloudClient, processor?: InboundEventProcessor) {
    const bindings = new PostgresConversationBindingRepository();
    const api = new SlackWebApiClient(new BrokerSlackApiTransport(), new SlackAccountResolver(getIntegrationService()));
    const context = new SlackThreadContextSource(api, this.accountsByTeam, new SlackSystemContextIssuer());
    const router = new InboundRouterService(bindings, new SlackSenderAllowlist(), new ConversationHistorySlackThreadFactory(), context, this.accountsByTeam);
    this.workspaceRegistrar = new SlackWorkspaceRegistrar(cloud, this.accountsByTeam, getIntegrationService(), new SlackSystemContextIssuer(), api);
    void this.workspaceRegistrar.registerConnectedWorkspaces();
    const delivery = new ChannelInboundDelivery(new LocalSlackChatSender(), new ExistingSlackJobSender());
    this.processor = processor ?? new InboundEventProcessor(new SlackChannelAdapter(), bindings, router, delivery, ids => cloud.ack(ids));
  }

  async handle(frame: Record<string, unknown>): Promise<void> {
    await this.workspaceRegistrar.registerConnectedWorkspaces();
    await this.processor.handle(frame);
  }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.workspaceRegistrar.registerConnectedWorkspaces().then(() => this.processPending()).finally(() => { this.draining = null; });
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
