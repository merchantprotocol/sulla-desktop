// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { LiveEvent } from './liveEventsClient';

/** Converts body-free Cloud channel invalidations into a renderer refetch signal. */
export class ConversationServersLiveEventBridge {
  constructor(private readonly publish: (channelId: string) => void) {}

  dispatch(event: LiveEvent): void {
    if (event.topic !== 'conversations' || event.type !== 'changed' || !event.id) return;
    this.publish(event.id);
  }
}
