// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Per-collection settings a manager can change: guidance, cloud catalog sync, keep on computer. */
export class CollectionSettingsRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  async describe(collectionId:string, description:string | null, namingHint:string | null):Promise<any> {
    return (await this.db.query('UPDATE collections SET description=$2,naming_hint=$3,updated_at=NOW() WHERE id=$1 RETURNING id,name,description,naming_hint AS "namingHint"', [collectionId, description, namingHint])).rows[0];
  }

  async setCloudCatalogSync(collectionId:string, enabled:boolean):Promise<any> {
    return (await this.db.query('UPDATE collections SET cloud_catalog_sync=$2,updated_at=NOW() WHERE id=$1 RETURNING id,name,cloud_catalog_sync AS "cloudCatalogSync"', [collectionId, enabled])).rows[0];
  }

  async setKeepOnComputer(collectionId:string, enabled:boolean):Promise<any> {
    return (await this.db.query('UPDATE collections SET keep_on_computer=$2,updated_at=NOW() WHERE id=$1 RETURNING id,keep_on_computer AS "keepOnComputer"', [collectionId, enabled])).rows[0];
  }
}
