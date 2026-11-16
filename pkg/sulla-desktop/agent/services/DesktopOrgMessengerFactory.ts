// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentInbox } from './AgentInbox';
import { CloudOrgMessagingTransport, PinnedOrgCloudSession } from './CloudOrgMessagingTransport';
import type { OrgMembership } from './OrgMembershipDirectory';
import { OrgMessenger, type OrgContactRequestPrompter, type OrgConversationHaltHandler, type OrgInboxTargetResolver, type OrgMessagingSession } from './OrgMessenger';
import type { OrgMessengerFactory } from './OrgMessengerFleet';
import type { OrgMessagingStateRepository } from './OrgMessagingStateRepository';

/** Production factory: one Cloud transport pinned to each member org, sharing the org-keyed state store and local inbox. */
export class DesktopOrgMessengerFactory implements OrgMessengerFactory {
  constructor(
    private readonly state: OrgMessagingStateRepository,
    private readonly inbox: AgentInbox,
    private readonly targetResolver: OrgInboxTargetResolver,
    private readonly contactPrompter: OrgContactRequestPrompter,
    private readonly haltHandler?: OrgConversationHaltHandler,
  ) {}

  create(membership: OrgMembership, session: OrgMessagingSession): OrgMessenger {
    const transport = new CloudOrgMessagingTransport(undefined, new PinnedOrgCloudSession(membership.orgId));
    return new OrgMessenger(transport, session, this.state, this.inbox, this.targetResolver, this.contactPrompter, this.haltHandler);
  }
}
