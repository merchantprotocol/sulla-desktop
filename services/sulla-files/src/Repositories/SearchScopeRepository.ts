// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** The collections a search may cover. */
export class SearchScopeRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  async publishedCollectionScopes():Promise<Array<{ collectionId:string }>> {
    return (await this.db.query("SELECT id FROM collections WHERE published=TRUE AND legacy_source=FALSE")).rows.map(row => ({ collectionId: row.id }));
  }
}
