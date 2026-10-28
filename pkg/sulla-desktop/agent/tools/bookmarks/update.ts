// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BookmarkTool } from './common';

export class BookmarksUpdateWorker extends BookmarkTool {
  protected async _validatedCall(input: any) {
    if (input.title === undefined && input.url === undefined) throw new Error('Provide title, url, or both.');
    const updated = await this.service().update(input.id, { title: input.title, url: input.url });
    if (!updated) throw new Error(`Bookmark "${ input.id }" was not found.`);

    return this.response(this.output(updated));
  }
}
