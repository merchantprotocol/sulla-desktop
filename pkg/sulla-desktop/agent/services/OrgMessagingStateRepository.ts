// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { InboxCursor } from '@sulla/domain';

export type PendingOrgMessage = { messageId: string; envelope: string };

export interface OrgMessagingStateRepository {
  enqueue(message: PendingOrgMessage): Promise<void>;
  /** Messages that are neither sent nor permanently failed. */
  pending(): Promise<PendingOrgMessage[]>;
  markSent(messageId: string): Promise<void>;
  /** Permanently stops retrying a message the host refused, keeping the reason. */
  markFailed(messageId: string, reason: string): Promise<void>;
  cursor(orgId: string, userId: string): Promise<InboxCursor>;
  advanceCursor(cursor: InboxCursor): Promise<void>;
  /** Epoch ms when the human was last shown a contact prompt for this sender, if ever. */
  lastContactPrompt(orgId: string, userId: string, senderUserId: string): Promise<number | undefined>;
  recordContactPrompt(orgId: string, userId: string, senderUserId: string, askedAt: number): Promise<void>;
}
