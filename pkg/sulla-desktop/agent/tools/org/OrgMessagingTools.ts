// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';
import { MessageEnvelope, ParticipantAddress } from '@sulla/domain';
import { BaseTool, type ToolResponse } from '../base';

const orgParam = { type: 'string' as const, optional: true, description: 'Organization id, slug or name. Defaults to the active organization; must be one you belong to.' };

abstract class OrgMessagingTool extends BaseTool {
  /**
   * Resolves the target org (default: active) and refuses orgs the human does not belong to. `userId` is the
   * human's id on that org's host (Cloud user id, or the Sulla Server subject).
   */
  protected async identity(requestedOrg?: unknown): Promise<{ orgId: string; orgName: string; userId: string; agentId: string }> {
    const requested = typeof requestedOrg === 'string' ? requestedOrg.trim() : '';
    const { getBackendGraphWebSocketService } = await import('../../services/BackendGraphWebSocketService');
    const { membership: org, userId } = await getBackendGraphWebSocketService().orgMessagingParticipant(requested || undefined);
    const state = this.state as any;
    const agentId = String(state?.metadata?.agentId ?? '').trim();
    if (!org.orgId || !userId || !agentId) throw new Error('Organization messaging requires an active organization session and agent identity');
    return { orgId: org.orgId, orgName: org.name, userId, agentId };
  }

  protected async send(envelope: MessageEnvelope, orgId: string): Promise<void> {
    const { getBackendGraphWebSocketService } = await import('../../services/BackendGraphWebSocketService');
    await getBackendGraphWebSocketService().sendOrgMessage(envelope, orgId);
  }

  protected result(value: unknown): ToolResponse { return { successBoolean: true, responseString: JSON.stringify(value), result: value }; }
}

export class OrgSendMessageTool extends OrgMessagingTool {
  name = 'send_message'; description = 'Send an agent message to a teammate’s agent in one of your organizations (default: the active one). The message enters that organization’s durable outbox and is retried safely.';
  schemaDef = {
    conversationId: { type: 'string' as const, description: 'Stable organization conversation id.' },
    recipientUserId: { type: 'string' as const, description: 'Recipient human id in the target organization.' },
    recipientAgentId: { type: 'string' as const, description: 'Recipient agent id.' },
    message: { type: 'string' as const, description: 'Plain text request or reply.' },
    org: orgParam,
  };
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const { orgId, orgName, userId, agentId } = await this.identity(input.org);
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
      await this.send(envelope, orgId);
      return this.result({ messageId, orgId, orgName, status: 'queued' });
    } catch (error) { return { successBoolean: false, responseString: error instanceof Error ? error.message : String(error) }; }
  }
}

export class OrgDirectoryTool extends OrgMessagingTool {
  name = 'directory'; description = 'List people and agent addresses in one of your organizations (default: the active one).';
  schemaDef = { org: orgParam };
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const requested = typeof input?.org === 'string' ? input.org.trim() : '';
      const { getBackendGraphWebSocketService } = await import('../../services/BackendGraphWebSocketService');
      const { membership, directory } = await getBackendGraphWebSocketService().loadOrgDirectory(requested || undefined);
      return this.result({ orgId: membership.orgId, orgName: membership.name, ...directory });
    }
    catch (error) { return { successBoolean: false, responseString: error instanceof Error ? error.message : String(error) }; }
  }
}

export class OrgHaltConversationTool extends OrgMessagingTool {
  name = 'halt_conversation'; description = 'Halt an organization conversation (default: in the active organization) and stop the local agent turn.';
  schemaDef = { conversationId: { type: 'string' as const, description: 'Conversation to halt.' }, recipientUserId: { type: 'string' as const, description: 'Owner of the agent whose thread is being halted.' }, recipientAgentId: { type: 'string' as const, description: 'Agent id to halt.' }, org: orgParam };
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const { orgId, orgName, userId } = await this.identity(input.org);
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
      await this.send(envelope, orgId);
      return this.result({ messageId, orgId, orgName, status: 'queued' });
    } catch (error) { return { successBoolean: false, responseString: error instanceof Error ? error.message : String(error) }; }
  }
}
