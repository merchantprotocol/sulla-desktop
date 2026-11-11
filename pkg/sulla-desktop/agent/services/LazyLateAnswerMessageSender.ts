// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { LateAnswerMessageSender } from './LateDecisionAnswerHandler';

/** Resolves the renderer/main message bus only when a late answer is actually delivered.
 * Constructing DecisionService must never touch the WebSocket client (renderer-only module). */
export class LazyLateAnswerMessageSender implements LateAnswerMessageSender {
  constructor(private readonly resolveBus: () => LateAnswerMessageSender) {}

  send(channel: string, message: { type: string; data: Record<string, unknown> }): Promise<boolean> {
    return this.resolveBus().send(channel, message);
  }
}
