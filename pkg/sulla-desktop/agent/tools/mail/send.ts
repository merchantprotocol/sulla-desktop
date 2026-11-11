// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailTool } from './AgentMailTool';

import type { AgentMailService } from './AgentMailRouter';

/** mail/send — send from one of your mailboxes (default: your only active one). */
export class MailSendWorker extends AgentMailTool {
  protected run(mail: AgentMailService, input: Record<string, unknown>) {
    return mail.send(input, this.executionContext);
  }
}
