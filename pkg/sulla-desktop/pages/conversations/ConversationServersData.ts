// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type NotificationLevel = 'all' | 'mentions' | 'nothing';
export type ConversationServer = { id: string; name: string; visibility: 'public' | 'organization'; orgId?: string; ownerUserId: string; notificationDefault: NotificationLevel };
export type ConversationChannel = { id: string; serverId: string; name: string; kind: 'text' | 'a2a' | 'announcement'; private: boolean; memberUserIds?: string[]; notificationOverride?: NotificationLevel; notificationPreference?: NotificationLevel; notificationLevel: NotificationLevel; notificationAvailable?: boolean };
export type ConversationServerMember = { userId: string; role: string };

/** Applies the shared per-member → channel override → server default notification policy. */
export class ConversationServersData {
  mentionToken(userId: string): string { return `<@${userId}>`; }

  badge(level: NotificationLevel, unread: number, mentions: number): string {
    if (level === 'nothing') return '';
    const count = level === 'mentions' ? mentions : unread;
    return count > 0 ? (level === 'mentions' ? `${count} mentions` : String(count)) : '';
  }

  effectiveLevel(server: ConversationServer, channel: ConversationChannel, preference?: NotificationLevel): NotificationLevel {
    return preference ?? channel.notificationOverride ?? server.notificationDefault;
  }
}
