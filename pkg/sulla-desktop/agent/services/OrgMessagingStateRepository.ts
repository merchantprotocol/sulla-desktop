// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { InboxCursor } from '@sulla/domain';

export interface PendingOrgMessage { messageId: string; envelope: string }

export interface OrgMessagingStateRepository {
  enqueue(message: PendingOrgMessage): Promise<void>;
  pending(): Promise<PendingOrgMessage[]>;
  markSent(messageId: string): Promise<void>;
  cursor(orgId: string, userId: string): Promise<InboxCursor>;
  advanceCursor(cursor: InboxCursor): Promise<void>;
}
