// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class BridgeToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  send_notification_to_human(args) {
    return { label: 'Bridge', summary: `Notifying human` };
  },
  emit_html_message(args) {
    return { label: 'Bridge', summary: `Sending rich message${ args.title ? `: ${ text.truncate(text.string(args.title), 40) }` : '' }` };
  },
  update_human_presence() {
    return { label: 'Bridge', summary: 'Updating presence' };
  },
  get_human_presence() {
    return { label: 'Bridge', summary: 'Checking presence' };
  },
    });
  }
}
