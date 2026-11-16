// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface AuditSessionIdentity { actor:string; requestId:string; action:string }

/** Writes the audit identity onto one checked-out connection (read by the audit triggers). */
export class AuditSessionRepository {
  async tag(client:pg.PoolClient, identity:AuditSessionIdentity):Promise<void> {
    await client.query("SELECT set_config('sulla.audit_actor',$1,false),set_config('sulla.audit_request_id',$2,false),set_config('sulla.audit_action',$3,false)",
      [identity.actor, identity.requestId, identity.action]);
  }
}
