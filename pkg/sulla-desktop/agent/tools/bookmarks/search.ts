// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BookmarkTool } from './common';

export class BookmarksSearchWorker extends BookmarkTool {
  protected async _validatedCall(input: any) {
    const query = String(input.query ?? '').trim().toLocaleLowerCase();
    if (!query) throw new Error('Search query cannot be empty.');
    const matches = (await this.service().list()).filter(record =>
      record.title.toLocaleLowerCase().includes(query) ||
      (record.url?.toLocaleLowerCase().includes(query) ?? false),
    );

    return this.response(matches.map(record => this.output(record)));
  }
}
