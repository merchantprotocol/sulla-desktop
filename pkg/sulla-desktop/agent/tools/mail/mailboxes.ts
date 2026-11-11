// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailTool } from './AgentMailTool';

import type { AgentMailService } from './AgentMailRouter';

/** mail/mailboxes — the signed-in user's agent mailboxes and which one is the default. */
export class MailMailboxesWorker extends AgentMailTool {
  protected run(mail: AgentMailService, _input: Record<string, unknown>) {
    return mail.mailboxes(this.executionContext);
  }
}
