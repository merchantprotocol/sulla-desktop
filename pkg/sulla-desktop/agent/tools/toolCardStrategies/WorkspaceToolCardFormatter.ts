// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MappedToolCardFormatter } from './MappedToolCardFormatter';
import { ToolCardText } from './ToolCardText';
export class WorkspaceToolCardFormatter extends MappedToolCardFormatter {
  constructor(text: ToolCardText) {
    super({
  create_workspace(args) {
    return { label: 'Workspace', summary: `Creating workspace ${ text.string(args.name) }` };
  },
  delete_workspace(args) {
    return { label: 'Workspace', summary: `Deleting workspace ${ text.string(args.name) }` };
  },
  get_workspace_path(args) {
    return { label: 'Workspace', summary: `Getting path for ${ text.string(args.name) }` };
  },
  view_workspace_files(args) {
    return { label: 'Workspace', summary: `Listing files in ${ text.string(args.name) }` };
  },
    });
  }
}
