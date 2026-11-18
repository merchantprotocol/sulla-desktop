// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentInbox } from './AgentInbox';
import { SullaCloudHttpClient } from '@pkg/main/cloud/account/SullaCloudHttpClient';
import { CloudOrgMessagingTransport, PinnedOrgCloudSession, type OrgCloudRequester } from './CloudOrgMessagingTransport';
import type { OrgHosting } from './OrgHostingResolver';
import type { OrgMembership } from './OrgMembershipDirectory';
import { OrgMessenger, type OrgContactRequestPrompter, type OrgConversationHaltHandler, type OrgInboxTargetResolver, type OrgMessagingSession } from './OrgMessenger';
import type { OrgMessengerFactory } from './OrgMessengerFleet';
import type { OrgMessagingStateRepository } from './OrgMessagingStateRepository';

/**
 * Production factory: one org messaging transport pinned to each member org, sharing the org-keyed state store and
 * local inbox. Cloud and Server orgs use the same transport class; only the base URL and credentials differ.
 */
export class DesktopOrgMessengerFactory implements OrgMessengerFactory {
  constructor(
    private readonly state: OrgMessagingStateRepository,
    private readonly inbox: AgentInbox,
    private readonly targetResolver: OrgInboxTargetResolver,
    private readonly contactPrompter: OrgContactRequestPrompter,
    private readonly haltHandler?: OrgConversationHaltHandler,
    private readonly cloudRequester: OrgCloudRequester = (method, path, options) => import('@pkg/main/cloud/cloudFetch').then(({ cloudRequest }) => cloudRequest(method, path, options)),
  ) {}

  create(membership: OrgMembership, session: OrgMessagingSession, hosting: OrgHosting): OrgMessenger {
    const http = new SullaCloudHttpClient(undefined, hosting.baseUrl);
    const transport = new CloudOrgMessagingTransport(http, new PinnedOrgCloudSession(membership.orgId, hosting.credentials), undefined, hosting.kind, this.cloudRequester);
    return new OrgMessenger(transport, session, this.state, this.inbox, this.targetResolver, this.contactPrompter, this.haltHandler);
  }
}
