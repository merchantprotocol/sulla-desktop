// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Lookups behind the protected-file policy. Works on the pool or an open transaction's client. */
export class ProtectedFileRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** True when the file lives in the internal Logs system collection. */
  async isInLogsArea(fileId:string):Promise<boolean> {
    return Boolean((await this.db.query("SELECT 1 FROM files f JOIN collections c ON c.id=f.collection_id WHERE f.id=$1 AND c.system_area='logs'", [fileId])).rowCount);
  }

  /** True when the file was explicitly marked protected. */
  async isMarkedProtected(fileId:string):Promise<boolean> {
    return Boolean((await this.db.query('SELECT 1 FROM files_protected_files WHERE file_id=$1', [fileId])).rowCount);
  }
}
