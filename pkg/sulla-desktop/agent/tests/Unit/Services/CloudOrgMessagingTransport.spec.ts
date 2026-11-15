// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EnvelopeCodec, MessageEnvelope, ParticipantAddress } from '@sulla/domain';
import { describe, expect, it, vi } from 'vitest';
import { CloudOrgMessagingTransport, type OrgCloudSession } from '../../../services/CloudOrgMessagingTransport';
import { SullaCloudHttpClient } from '@pkg/main/cloud/account/SullaCloudHttpClient';

class TestSession implements OrgCloudSession {
  async accessToken() { return 'test-token'; }
  async orgId() { return 'active-org'; }
  async userId() { return 'local-user'; }
}

describe('CloudOrgMessagingTransport', () => {
  it('starts a conversation through the active organization and returns its canonical pair id', async () => {
    // risk: cross-tenant or orphaned first-contact conversation
    const fetch = vi.fn(async () => new Response(JSON.stringify({ conversationId: 'canonical-pair-id' }), { status: 200 }));
    const transport = new CloudOrgMessagingTransport(new SullaCloudHttpClient(fetch, 'https://cloud.test', 1000, 0), new TestSession());
    await expect(transport.startConversation({
      conversationId: 'client-generated-id', kind: 'agent_thread', participantUserIds: ['local-user', 'recipient'],
    })).resolves.toEqual({ conversationId: 'canonical-pair-id' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://cloud.test/orgs/active-org/conversations');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      conversationId: 'client-generated-id', kind: 'agent_thread', participantUserIds: ['local-user', 'recipient'],
    });
  });

  it('refuses to start a conversation without the active user as a participant', async () => {
    // risk: conversation created outside the signed-in user's identity
    const fetch = vi.fn();
    const transport = new CloudOrgMessagingTransport(new SullaCloudHttpClient(fetch), new TestSession());
    await expect(transport.startConversation({
      conversationId: 'client-generated-id', kind: 'direct', participantUserIds: ['someone-else', 'recipient'],
    })).rejects.toThrow('active user');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retries a network-failed post with the same message id and active org', async () => {
    // risk: duplicate side effect
    const hostMessageIds = new Set<string>();
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const encoded = (JSON.parse(String(init.body)) as { envelope: string }).envelope;
      const messageId = new EnvelopeCodec().decode(encoded).data.messageId;
      const duplicate = hostMessageIds.has(messageId);
      hostMessageIds.add(messageId);
      if (fetch.mock.calls.length === 1) throw new Error('response lost after host commit');
      return new Response(JSON.stringify({ hostSeq: 8, status: duplicate ? 'duplicate' : 'accepted' }), { status: 200 });
    });
    const http = new SullaCloudHttpClient(fetch, 'https://cloud.test', 1000, 0);
    const transport = new CloudOrgMessagingTransport(http, new TestSession());
    const envelope = MessageEnvelope.create({
      messageId: 'stable-message-id', conversationId: 'conversation-1', orgId: 'active-org',
      from: ParticipantAddress.human('active-org', 'local-user'),
      to: [ParticipantAddress.human('active-org', 'recipient')], kind: 'human', intent: 'note',
      body: { text: 'hello', format: 'plain', refs: [] },
      causality: { rootId: 'stable-message-id', hop: 0, clientSeq: 1 },
      provenance: { actingForUserId: 'local-user', deviceId: 'device-1', placement: 'desktop' },
      createdAt: new Date(0).toISOString(),
    });

    await expect(transport.submit(envelope)).resolves.toEqual({ hostSeq: 8, status: 'duplicate' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(hostMessageIds.size).toBe(1);
    expect(fetch.mock.calls[0][0]).toBe('https://cloud.test/orgs/active-org/conversations/conversation-1/messages');
    expect(fetch.mock.calls.map(([url, init]) => [url, (init as RequestInit).body])).toEqual([
      ['https://cloud.test/orgs/active-org/conversations/conversation-1/messages', JSON.stringify({ envelope: new EnvelopeCodec().encode(envelope) })],
      ['https://cloud.test/orgs/active-org/conversations/conversation-1/messages', JSON.stringify({ envelope: new EnvelopeCodec().encode(envelope) })],
    ]);
  });

  it('rejects a cursor from another org before issuing a request', async () => {
    // risk: cross-tenant data access
    const fetch = vi.fn();
    const transport = new CloudOrgMessagingTransport(new SullaCloudHttpClient(fetch), new TestSession());
    await expect(transport.pull({ orgId: 'other-org', userId: 'local-user', since: 0 }, 25)).rejects.toThrow('active session');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses to post an envelope attributed to another org or user', async () => {
    // risk: cross-tenant data access
    const fetch = vi.fn();
    const transport = new CloudOrgMessagingTransport(new SullaCloudHttpClient(fetch), new TestSession());
    const envelope = MessageEnvelope.create({
      messageId: 'wrong-session-message', conversationId: 'conversation-1', orgId: 'other-org',
      from: ParticipantAddress.human('other-org', 'other-user'),
      to: [ParticipantAddress.human('other-org', 'recipient')], kind: 'human', intent: 'note',
      body: { text: 'hello', format: 'plain', refs: [] },
      causality: { rootId: 'wrong-session-message', hop: 0, clientSeq: 1 },
      provenance: { actingForUserId: 'other-user', deviceId: 'device-1', placement: 'desktop' },
      createdAt: new Date(0).toISOString(),
    });
    await expect(transport.submit(envelope)).rejects.toThrow('active session');
    expect(fetch).not.toHaveBeenCalled();
  });
});
