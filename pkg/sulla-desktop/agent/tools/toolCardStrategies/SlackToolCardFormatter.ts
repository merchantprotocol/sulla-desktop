// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class SlackToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  slack_send_message(args) {
    return { label: 'Slack', summary: `Messaging ${ text.string(args.channel) }`, input: text.truncate(text.string(args.text), 80) };
  },
  slack_search_users(args) {
    return { label: 'Slack', summary: `Searching users: ${ text.truncate(text.string(args.query), 40) }` };
  },
  slack_update(args) {
    return { label: 'Slack', summary: `Updating message in ${ text.string(args.channel) }` };
  },
  slack_thread(args) {
    return { label: 'Slack', summary: `Reading thread in ${ text.string(args.channel) }` };
  },
  slack_user() {
    return { label: 'Slack', summary: 'Looking up user' };
  },
  slack_unreact(args) {
    return { label: 'Slack', summary: `Removing :${ text.string(args.reaction) }: from message` };
  },
  slack_connection_health() {
    return { label: 'Slack', summary: 'Checking Slack connection' };
  },
    });
  }
}
