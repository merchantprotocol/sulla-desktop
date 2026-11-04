// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class ExtensionToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  install_extension(args) {
    return { label: 'Extensions', summary: `Installing ${ text.truncate(text.string(args.id), 40) }` };
  },
  uninstall_extension(args) {
    return { label: 'Extensions', summary: `Uninstalling ${ text.truncate(text.string(args.id), 40) }` };
  },
  list_installed_extensions() {
    return { label: 'Extensions', summary: 'Listing installed extensions' };
  },
  list_extension_catalog(args) {
    const q = text.string(args.query);
    return { label: 'Extensions', summary: q ? `Searching extensions: ${ text.truncate(q, 40) }` : 'Browsing extension catalog' };
  },

    });
  }
}
