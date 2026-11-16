// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import pg from 'pg';

/** Backup and restore use short-lived pools of their own so they never share the service pool's sessions. */
export class BackupPoolFactory {
  open(connectionString:string, max:number):pg.Pool { return new pg.Pool({ connectionString, max }) }

  /** The same server URL pointed at another database. */
  static databaseUrlFor(source:string, database:string):string { const url = new URL(source); url.pathname = `/${ encodeURIComponent(database) }`; return url.toString() }
}
