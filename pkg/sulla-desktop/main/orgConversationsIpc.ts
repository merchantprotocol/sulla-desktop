// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { MessageEnvelope, ParticipantAddress } from '@sulla/domain';
import { ConversationServersCloudClient, type CreateConversationServerInput } from './ConversationServersCloudClient';
import { OrgMembershipsCloudClient } from './OrgMembershipsCloudClient';
import type { IpcController, IpcRegistrar } from './ipc/IpcController';
import { TeamInvitationsCloudClient } from './TeamInvitationsCloudClient';

export interface OrgConversationsBackend {
  memberOrganizations(): Promise<readonly { orgId: string; name: string; slug?: string; memberCount: number }[]>;
  loadOrgDirectory(org?: string): Promise<{ membership: { orgId: string; name: string }; directory: { people: readonly unknown[] } }>;
  loadOrgInboxMessages(org?: string): Promise<{ membership: { orgId: string; name: string }; messages: readonly MessageEnvelope[] }>;
  orgMessagingParticipant(org?: string): Promise<{ membership: { orgId: string; name: string }; userId: string }>;
  startOrgConversation(request: { conversationId: string; kind: 'direct' | 'group' | 'agent_thread'; participantUserIds: readonly string[] }, org?: string): Promise<{ membership: { orgId: string; name: string }; conversationId: string }>;
  contactRequests(org?: string): Promise<readonly MessageEnvelope['data'][]>;
  sendOrgMessage(envelope: MessageEnvelope, org?: string): Promise<void>;
}

/** Renderer bridge to the authenticated, org-pinned messaging fleet. */
export class OrgConversationsIpcController implements IpcController {
  constructor(
    private readonly ipc: IpcRegistrar,
    private readonly backend: () => OrgConversationsBackend,
    private readonly memberships: Pick<OrgMembershipsCloudClient, 'list'> = new OrgMembershipsCloudClient(),
    private readonly invitations: Pick<TeamInvitationsCloudClient, 'listPending'> = new TeamInvitationsCloudClient(),
    private readonly servers: Pick<ConversationServersCloudClient, 'list' | 'create' | 'channels' | 'members' | 'channelPreference' | 'setServerDefault' | 'setChannelPreference' | 'setChannelOverride' | 'messages' | 'sendMessage' | 'markRead' | 'unread'> = new ConversationServersCloudClient(),
  ) {}

  /** Org roles and invitations are keyed by the org id, which the backend resolves for the requested org. */
  private async orgIdOf(org?: string): Promise<string> {
    const { membership } = await this.backend().orgMessagingParticipant(org);
    return membership.orgId;
  }

  register(): void {
    this.ipc.handle('conversation-servers:list', (_event, orgId?: string) => this.servers.list(orgId));
    this.ipc.handle('conversation-servers:create', (_event, input: CreateConversationServerInput) => this.servers.create(input));
    this.ipc.handle('conversation-servers:channels', (_event, serverId: string) => this.servers.channels(serverId));
    this.ipc.handle('conversation-servers:members', (_event, serverId: string) => this.servers.members(serverId));
    this.ipc.handle('conversation-servers:channel-preference', (_event, input: { serverId: string; channelId: string }) => this.servers.channelPreference(input.serverId, input.channelId));
    this.ipc.handle('conversation-servers:set-default', (_event, input: { serverId: string; level: 'all' | 'mentions' | 'nothing' }) => this.servers.setServerDefault(input.serverId, input.level));
    this.ipc.handle('conversation-servers:set-channel-notification', (_event, input: { serverId: string; channelId: string; level: 'all' | 'mentions' | 'nothing' | null }) => this.servers.setChannelPreference(input.serverId, input.channelId, input.level));
    this.ipc.handle('conversation-servers:set-channel-override', (_event, input: { serverId: string; channelId: string; level: 'all' | 'mentions' | 'nothing' | null }) => this.servers.setChannelOverride(input.serverId, input.channelId, input.level));
    this.ipc.handle('conversation-servers:messages', (_event, input: { serverId: string; channelId: string; before?: number }) => this.servers.messages(input.serverId, input.channelId, input.before));
    this.ipc.handle('conversation-servers:send-message', (_event, input: { serverId: string; channelId: string; body: string }) => this.servers.sendMessage(input.serverId, input.channelId, input.body));
    this.ipc.handle('conversation-servers:read', (_event, input: { serverId: string; channelId: string; seq: number }) => this.servers.markRead(input.serverId, input.channelId, input.seq));
    this.ipc.handle('conversation-servers:unread', (_event, serverId: string) => this.servers.unread(serverId));
    this.ipc.handle('org-conversations:organizations', () => this.backend().memberOrganizations());
    this.ipc.handle('org-conversations:directory', (_event, org?: string) => this.backend().loadOrgDirectory(org));
    this.ipc.handle('org-conversations:inbox', async(_event, org?: string) => {
      const result = await this.backend().loadOrgInboxMessages(org);
      return { membership: result.membership, messages: result.messages.map(message => message.data) };
    });
    this.ipc.handle('org-conversations:memberships', async (_event, org?: string) => ({ memberships: await this.memberships.list(await this.orgIdOf(org)) }));
    this.ipc.handle('org-conversations:invitations', async (_event, org?: string) => ({ invitations: await this.invitations.listPending(await this.orgIdOf(org)) }));
    this.ipc.handle('org-conversations:participant', (_event, org?: string) => this.backend().orgMessagingParticipant(org));
    this.ipc.handle('org-conversations:contact-requests', async (_event, org?: string) => ({ requests: await this.backend().contactRequests(org) }));
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
