// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailTool } from './AgentMailTool';

import type { AgentMailService } from './AgentMailRouter';

/** mail/wait_for_code — block until a one-time code reaches the mailbox (default 120 s, max 300 s). */
export class MailWaitForCodeWorker extends AgentMailTool {
  protected run(mail: AgentMailService, input: Record<string, unknown>) {
    return mail.waitForCode(input, this.executionContext);
  }
}
