// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class CalendarToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  calendar_create(args) {
    return { label: 'Calendar', summary: `Creating event: ${ text.truncate(text.string(args.title), 50) }` };
  },
  calendar_list() {
    return { label: 'Calendar', summary: 'Listing events' };
  },
  calendar_list_upcoming(args) {
    return { label: 'Calendar', summary: `Checking next ${ args.days ?? 7 } days` };
  },
  calendar_get() {
    return { label: 'Calendar', summary: 'Getting event details' };
  },
  calendar_update(args) {
    return { label: 'Calendar', summary: `Updating event${ args.title ? `: ${ text.truncate(text.string(args.title), 45) }` : '' }` };
  },
  calendar_cancel() {
    return { label: 'Calendar', summary: 'Cancelling event' };
  },
  calendar_delete() {
    return { label: 'Calendar', summary: 'Deleting event' };
  },
    });
  }
}
