// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { MessageEnvelope, ParticipantAddress } from '@sulla/domain';
import type { IpcController, IpcRegistrar } from './ipc/IpcController';

export interface OrgConversationsBackend {
  memberOrganizations(): Promise<readonly { orgId: string; name: string; slug?: string; memberCount: number }[]>;
  loadOrgDirectory(org?: string): Promise<{ membership: { orgId: string; name: string }; directory: { people: readonly unknown[] } }>;
  loadOrgInboxMessages(org?: string): Promise<{ membership: { orgId: string; name: string }; messages: readonly MessageEnvelope[] }>;
  orgMessagingParticipant(org?: string): Promise<{ membership: { orgId: string; name: string }; userId: string }>;
  startOrgConversation(request: { conversationId: string; kind: 'direct' | 'group' | 'agent_thread'; participantUserIds: readonly string[] }, org?: string): Promise<{ membership: { orgId: string; name: string }; conversationId: string }>;
  sendOrgMessage(envelope: MessageEnvelope, org?: string): Promise<void>;
}

/** Renderer bridge to the authenticated, org-pinned messaging fleet. */
export class OrgConversationsIpcController implements IpcController {
  constructor(private readonly ipc: IpcRegistrar, private readonly backend: () => OrgConversationsBackend) {}

  register(): void {
    this.ipc.handle('org-conversations:organizations', () => this.backend().memberOrganizations());
    this.ipc.handle('org-conversations:directory', (_event, org?: string) => this.backend().loadOrgDirectory(org));
    this.ipc.handle('org-conversations:inbox', async(_event, org?: string) => {
      const result = await this.backend().loadOrgInboxMessages(org);
      return { membership: result.membership, messages: result.messages.map(message => message.data) };
    });
    this.ipc.handle('org-conversations:participant', (_event, org?: string) => this.backend().orgMessagingParticipant(org));
    this.ipc.handle('org-conversations:start', (_event, request: { orgId: string; participantUserIds: string[]; kind?: 'direct' | 'group' | 'agent_thread' }) => {
      const participantUserIds = [...new Set((request.participantUserIds ?? []).filter(id => typeof id === 'string' && id.trim()))];
      return this.backend().startOrgConversation({
        conversationId: `cv_${crypto.randomUUID()}`,
        kind: request.kind ?? (participantUserIds.length > 2 ? 'group' : 'direct'),
        participantUserIds,
      }, request.orgId);
    });
    this.ipc.handle('org-conversations:send', async (_event, input: { orgId: string; conversationId: string; toUserIds: string[]; text: string }) => {
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text) throw new Error('Message text is required');
      if (text.length > 32_000) throw new Error('Message exceeds the 32 KB limit');
      const current = this.backend();
      const { membership, userId } = await current.orgMessagingParticipant(input.orgId);
      const recipientIds = [...new Set((input.toUserIds ?? []).filter(id => typeof id === 'string' && id.trim() && id !== userId))];
      if (!recipientIds.length) throw new Error('Choose at least one organization member');
      const messageId = crypto.randomUUID();
      const envelope = MessageEnvelope.create({
        messageId,
        conversationId: input.conversationId,
        orgId: membership.orgId,
        from: ParticipantAddress.human(membership.orgId, userId),
        to: recipientIds.map(id => ParticipantAddress.human(membership.orgId, id)),
        kind: 'human', intent: 'note',
        body: { text, format: 'plain', refs: [] },
        causality: { rootId: messageId, hop: 0, clientSeq: Date.now() },
        provenance: { actingForUserId: userId, placement: 'desktop' },
        createdAt: new Date().toISOString(),
      });
      await current.sendOrgMessage(envelope, membership.orgId);
      return { messageId, message: envelope.data };
    });
  }
}
