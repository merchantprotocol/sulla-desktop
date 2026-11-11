// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailTool } from './AgentMailTool';

import type { AgentMailClient } from './AgentMailClient';

/** mail/mark_read — mark one message read. */
export class MailMarkReadWorker extends AgentMailTool {
  protected run(client: AgentMailClient, input: Record<string, unknown>) {
    return client.markRead(input.id, this.executionContext);
  }
}
