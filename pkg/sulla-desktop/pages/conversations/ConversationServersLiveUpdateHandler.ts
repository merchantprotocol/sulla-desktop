// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Routes channel invalidations to the selected history and active-server unread summary. */
export class ConversationServersLiveUpdateHandler {
  constructor(private readonly deps: {
    selectedChannelId: () => string;
    hasChannel: (channelId: string) => boolean;
    refreshMessages: () => Promise<void>;
    refreshUnread: () => Promise<void>;
  }) {}

  async refresh(channelId: string | undefined): Promise<void> {
    if (!channelId || !this.deps.hasChannel(channelId)) return;
    if (channelId === this.deps.selectedChannelId()) await this.deps.refreshMessages();
    else await this.deps.refreshUnread();
  }
}
