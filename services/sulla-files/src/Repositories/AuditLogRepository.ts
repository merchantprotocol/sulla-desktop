// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface AuditLogRow {
  whoType:string; whoId:string; deviceOrRunId:string | null; fileId:string | null; versionId:string | null;
  action:string; orgId:unknown; details:Record<string, unknown>;
}

/** The PostgreSQL audit_log table (the durable copy is the audit spool; this is the dual-write). */
export class AuditLogRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  async insert(row:AuditLogRow):Promise<void> {
    await this.db.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,org_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.whoType, row.whoId, row.deviceOrRunId, row.fileId, row.versionId, row.action, row.orgId, row.details]);
  }
}
