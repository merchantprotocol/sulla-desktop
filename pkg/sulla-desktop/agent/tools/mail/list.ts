// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailTool } from './AgentMailTool';

import type { AgentMailClient } from './AgentMailClient';

/** mail/list — message summaries (no bodies) for an agent mailbox. */
export class MailListWorker extends AgentMailTool {
  protected run(client: AgentMailClient, input: Record<string, unknown>) {
    return client.list({ to: input.to, since: input.since, limit: input.limit }, this.executionContext);
  }
}
