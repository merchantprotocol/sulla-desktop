// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';
import { MessageEnvelope, ParticipantAddress } from '@sulla/domain';
import { BaseTool, type ToolResponse } from '../base';
import { CloudOrgMessagingTransport, DesktopOrgCloudSession } from '../../services/CloudOrgMessagingTransport';

abstract class OrgMessagingTool extends BaseTool {
  protected readonly session = new DesktopOrgCloudSession();
  protected readonly transport = new CloudOrgMessagingTransport();
  protected async activeIdentity(): Promise<{ orgId: string; userId: string; agentId: string }> {
    const [orgId, userId] = await Promise.all([this.session.orgId(), this.session.userId()]);
    const state = this.state as any;
    const agentId = String(state?.metadata?.agentId ?? '').trim();
    if (!orgId || !userId || !agentId) throw new Error('Organization messaging requires an active organization session and agent identity');
    return { orgId, userId, agentId };
  }
  protected result(value: unknown): ToolResponse { return { successBoolean: true, responseString: JSON.stringify(value), result: value }; }
}

export class OrgSendMessageTool extends OrgMessagingTool {
  name = 'send_message'; description = 'Send an agent message to a teammate’s agent inside the active organization. The message enters the durable outbox and is retried safely.';
  schemaDef = {
    conversationId: { type: 'string' as const, description: 'Stable organization conversation id.' },
    recipientUserId: { type: 'string' as const, description: 'Recipient human id in the active organization.' },
    recipientAgentId: { type: 'string' as const, description: 'Recipient agent id.' },
    message: { type: 'string' as const, description: 'Plain text request or reply.' },
  };
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const { orgId, userId, agentId } = await this.activeIdentity();
      const text = String(input.message ?? '').trim();
      if (!text) throw new Error('Message cannot be empty');
      const messageId = randomUUID();
      const envelope = MessageEnvelope.create({
        messageId, conversationId: String(input.conversationId), orgId,
        from: ParticipantAddress.agent(orgId, userId, agentId),
        to: [ParticipantAddress.agent(orgId, String(input.recipientUserId), String(input.recipientAgentId))],
        kind: 'agent', intent: 'request', body: { text, format: 'plain', refs: [] },
        causality: { rootId: messageId, hop: 0, clientSeq: Date.now() },
        provenance: { actingForUserId: userId, deviceId: await (await import('@pkg/main/deviceIdentity')).getDesktopDeviceId(), placement: 'desktop' },
        createdAt: new Date().toISOString(),
      });
      const { getBackendGraphWebSocketService } = await import('../../services/BackendGraphWebSocketService');
      await getBackendGraphWebSocketService().sendOrgMessage(envelope);
      return this.result({ messageId, status: 'queued' });
    } catch (error) { return { successBoolean: false, responseString: error instanceof Error ? error.message : String(error) }; }
  }
}

export class OrgDirectoryTool extends OrgMessagingTool {
  name = 'directory'; description = 'List people and agent addresses in the active organization.';
  protected async _validatedCall(): Promise<ToolResponse> {
    try { await this.activeIdentity(); return this.result(await this.transport.loadDirectory()); }
    catch (error) { return { successBoolean: false, responseString: error instanceof Error ? error.message : String(error) }; }
  }
}

export class OrgHaltConversationTool extends OrgMessagingTool {
  name = 'halt_conversation'; description = 'Halt the active organization conversation and stop the local agent turn.';
  schemaDef = { conversationId: { type: 'string' as const, description: 'Conversation to halt.' }, recipientUserId: { type: 'string' as const, description: 'Owner of the agent whose thread is being halted.' }, recipientAgentId: { type: 'string' as const, description: 'Agent id to halt.' } };
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const { orgId, userId } = await this.activeIdentity();
      const messageId = randomUUID();
      const envelope = MessageEnvelope.create({
        messageId, conversationId: String(input.conversationId), orgId,
        from: ParticipantAddress.human(orgId, userId),
        to: [ParticipantAddress.agent(orgId, String(input.recipientUserId), String(input.recipientAgentId))],
        kind: 'control', intent: 'note', control: { action: 'halt' }, body: { text: 'halt', format: 'plain', refs: [] },
        causality: { rootId: messageId, hop: 0, clientSeq: Date.now() },
        provenance: { actingForUserId: userId, deviceId: await (await import('@pkg/main/deviceIdentity')).getDesktopDeviceId(), placement: 'desktop' },
        createdAt: new Date().toISOString(),
      });
      const { getBackendGraphWebSocketService } = await import('../../services/BackendGraphWebSocketService');
      await getBackendGraphWebSocketService().sendOrgMessage(envelope);
      return this.result({ messageId, status: 'queued' });
    } catch (error) { return { successBoolean: false, responseString: error instanceof Error ? error.message : String(error) }; }
  }
}
