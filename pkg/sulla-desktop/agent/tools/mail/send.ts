// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailTool } from './AgentMailTool';

import type { AgentMailClient } from './AgentMailClient';

/** mail/send — send from <from_local>@agents.sulladesktop.com. Needs the server send endpoint. */
export class MailSendWorker extends AgentMailTool {
  protected run(client: AgentMailClient, input: Record<string, unknown>) {
    return client.send({
      from_local: String(input.from_local ?? ''),
      to:         String(input.to ?? ''),
      subject:    String(input.subject ?? ''),
      text:       typeof input.text === 'string' ? input.text : undefined,
      html:       typeof input.html === 'string' ? input.html : undefined,
    }, this.executionContext);
  }
}
