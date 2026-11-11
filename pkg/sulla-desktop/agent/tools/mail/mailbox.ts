// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailTool } from './AgentMailTool';

import type { AgentMailService } from './AgentMailRouter';

/** mail/mailbox — the signed-in user's one agent email, or how to register / re-enable it. */
export class MailMailboxWorker extends AgentMailTool {
  protected run(mail: AgentMailService, _input: Record<string, unknown>) {
    return mail.mailbox(this.executionContext);
  }
}
