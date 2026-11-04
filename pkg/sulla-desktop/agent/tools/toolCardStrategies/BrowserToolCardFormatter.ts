// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class BrowserToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  browser_tab(args) {
    const action = text.string(args.action);
    const url = text.string(args.url);
    const title = text.string(args.title);
    const label = title || url || text.string(args.assetId);
    switch (action) {
    case 'open': return { label: 'Browser', summary: `Opening ${ text.truncate(url || title, 60) }`, input: url || undefined };
    case 'navigate': return { label: 'Browser', summary: `Navigating to ${ text.truncate(url, 60) }`, input: url || undefined };
    case 'close': return { label: 'Browser', summary: `Closing tab${ label ? `: ${ text.truncate(label, 50) }` : '' }` };
    default: return { label: 'Browser', summary: `${ action || 'Managing' } tab${ label ? `: ${ text.truncate(label, 50) }` : '' }` };
    }
  },

  click_element(args) {
    return { label: 'Browser', summary: `Clicking ${ text.truncate(text.string(args.handle || args.selector), 40) }` };
  },
  set_field(args) {
    const handle = text.truncate(text.string(args.handle || args.selector), 30);
    const value = text.truncate(text.string(args.value), 30);
    return { label: 'Browser', summary: `Filling '${ handle }' → '${ value }'` };
  },
  get_page_snapshot() {
    return { label: 'Browser', summary: 'Capturing page snapshot' };
  },
  get_page_text() {
    return { label: 'Browser', summary: 'Reading page text' };
  },
  get_form_values() {
    return { label: 'Browser', summary: 'Reading form values' };
  },
  scroll_to_element(args) {
    return { label: 'Browser', summary: `Scrolling to ${ text.truncate(text.string(args.selector), 40) }` };
  },
  wait_for_element(args) {
    return { label: 'Browser', summary: `Waiting for ${ text.truncate(text.string(args.selector), 40) }` };
  },
    });
  }
}
