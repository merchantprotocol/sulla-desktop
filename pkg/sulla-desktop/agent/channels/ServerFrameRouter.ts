// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { ChannelEventHandler } from './types';
export class ServerFrameRouter {
  constructor(private readonly slack: ChannelEventHandler, private readonly fallback: (frame: Record<string, unknown>) => Promise<void>) {}
  async dispatch(frame: Record<string, unknown>): Promise<void> {
    if (frame.type === 'slack_inbound') return this.slack.handle(frame);
    await this.fallback(frame);
  }
}
