// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BookmarkTool } from './common';

export class BookmarksCreateFolderWorker extends BookmarkTool {
  protected async _validatedCall(input: any) {
    const parentId = typeof input.parentId === 'string' && input.parentId.trim() ? input.parentId.trim() : null;
    if (parentId) this.findFolder(await this.service().list(), parentId);
    const folder = await this.service().create({ kind: 'folder', title: input.title, parentId });

    return this.response(this.output(folder));
  }
}
