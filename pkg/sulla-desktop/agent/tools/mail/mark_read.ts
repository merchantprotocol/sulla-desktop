// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailTool } from './AgentMailTool';

import type { AgentMailService } from './AgentMailRouter';

/** mail/mark_read — mark one message read. */
export class MailMarkReadWorker extends AgentMailTool {
  protected run(mail: AgentMailService, input: Record<string, unknown>) {
    return mail.markRead(input, this.executionContext);
  }
}
