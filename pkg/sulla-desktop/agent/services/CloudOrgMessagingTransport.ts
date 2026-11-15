// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EnvelopeCodec, type AgentHostLease, type ContactRequestChoice, type InboxCursor, type InboxPage, type MessageEnvelope, type OrgDirectory, type OrgMessagingTransport, type SubmitReceipt, type WakeHint } from '@sulla/domain';
import { getActiveContractorId, getCurrentAccessToken, getCurrentUserId } from '@pkg/main/sullaCloudAuth';
import { SullaCloudHttpClient } from '@pkg/main/cloud/account/SullaCloudHttpClient';

export interface OrgCloudSession {
  accessToken(): Promise<string>;
  orgId(): Promise<string>;
  userId(): Promise<string>;
}

export class DesktopOrgCloudSession implements OrgCloudSession {
  accessToken(): Promise<string> { return getCurrentAccessToken(); }
  orgId(): Promise<string> { return getActiveContractorId(); }
  userId(): Promise<string> { return getCurrentUserId(); }
}

/** Cloud adapter. The team id is resolved from the active authenticated session for every request. */
export class CloudOrgMessagingTransport implements OrgMessagingTransport {
  readonly hosting = 'cloud' as const;
  private readonly codec = new EnvelopeCodec();
  private cachedDirectory: OrgDirectory = { people: [] };

  constructor(
    private readonly http = new SullaCloudHttpClient(),
    private readonly session: OrgCloudSession = new DesktopOrgCloudSession(),
    private readonly pollIntervalMs = 15_000,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const [orgId, token] = await Promise.all([this.session.orgId(), this.session.accessToken()]);
    if (!orgId || !token) throw new Error('An active Sulla Cloud organization session is required');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await this.http.send(`/orgs/${encodeURIComponent(orgId)}${path}`, {
      ...init,
      headers,
    }, true);
    if (!response.ok) throw new Error(`Cloud org messaging request failed (${response.status})`);
    return await response.json() as T;
  }

  async submit(envelope: MessageEnvelope): Promise<SubmitReceipt> {
    const [orgId, userId] = await Promise.all([this.session.orgId(), this.session.userId()]);
    if (envelope.data.orgId !== orgId || envelope.data.from.userId !== userId) throw new Error('Message must be authored in the active session');
    const route = envelope.data.kind === 'control' ? 'control' : envelope.data.kind === 'agent' ? 'agent-messages' : 'messages';
    return this.request(`/conversations/${encodeURIComponent(envelope.data.conversationId)}/${route}`, {
      method: 'POST', body: JSON.stringify({ envelope: this.codec.encode(envelope) }),
    });
  }

  async contactRequests(orgId: string, recipientUserId: string): Promise<readonly MessageEnvelope[]> {
    const activeOrg = await this.session.orgId();
    if (orgId !== activeOrg || recipientUserId !== await this.session.userId()) throw new Error('Contact requests must match the active session');
    const result = await this.request<{ requests: string[] }>('/contact-requests');
    return result.requests.map(request => this.codec.decode(request));
  }

  async resolveContactRequest(orgId: string, recipientUserId: string, senderUserId: string, choice: ContactRequestChoice): Promise<readonly number[]> {
    const activeOrg = await this.session.orgId();
    if (orgId !== activeOrg || recipientUserId !== await this.session.userId()) throw new Error('Contact request must match the active session');
    const result = await this.request<{ hostSeqs: number[] }>(`/contact-requests/${encodeURIComponent(senderUserId)}/resolve`, {
      method: 'POST', body: JSON.stringify({ choice }),
    });
    return result.hostSeqs;
  }

  async pull(cursor: InboxCursor, limit: number): Promise<InboxPage> {
    const [orgId, userId] = await Promise.all([this.session.orgId(), this.session.userId()]);
    if (cursor.orgId !== orgId || cursor.userId !== userId) throw new Error('Inbox cursor must match the active session');
    const result = await this.request<{ messages: string[]; next: number }>(`/inbox?since=${cursor.since}&limit=${limit}`);
    return { messages: result.messages.map(message => this.codec.decode(message)), next: result.next };
  }

  async ack(_cursor: InboxCursor, _stage: 'stored' | 'consumed'): Promise<void> {
    // Cloud inbox cursors are pull-based and durable; there is no separate ack route.
  }

  async *wakeups(): AsyncIterable<WakeHint> {
    let since = 0;
    let identity = '';
    while (true) {
      const [orgId, userId] = await Promise.all([this.session.orgId(), this.session.userId()]);
      if (!orgId || !userId) return;
      const nextIdentity = `${orgId}:${userId}`;
      if (identity !== nextIdentity) { identity = nextIdentity; since = 0; }
      const page = await this.pull({ orgId, userId, since }, 50);
      if (page.next > since) {
        since = page.next;
        yield { orgId, userId, inboxSeq: since };
      }
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  async loadDirectory(): Promise<OrgDirectory> {
    this.cachedDirectory = await this.request<OrgDirectory>('/directory');
    return this.cachedDirectory;
  }

  directory(): OrgDirectory { return this.cachedDirectory; }

  claimAgentHost(deviceId: string): Promise<AgentHostLease> {
    return this.request<AgentHostLease>('/agent-host-lease', { method: 'POST', body: JSON.stringify({ deviceId }) });
  }
}
