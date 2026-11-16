// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AuditLogRepository } from '../Repositories/AuditLogRepository.js';
import type { FilesAccessGate, RequestWithIdentity } from './FilesAccessGate.js';

/**
 * Records who did what to which file for a request. A failed write is logged, never thrown:
 * the file-change event is already in the durable audit spool.
 */
export class RequestAuditLog {
  constructor(private readonly access:FilesAccessGate, private readonly rows:AuditLogRepository) {}

  readonly record = async(request:RequestWithIdentity, action:string, file?:any, details:Record<string, unknown> = {}):Promise<void> => {
    const actor = this.access.identity(request);
    await this.rows.insert({
      whoType: actor.agentId ? 'agent' : actor.kind === 'capability' ? 'agent-or-device' : 'user',
      whoId: actor.agentId ?? actor.userId,
      deviceOrRunId: actor.jobId ?? actor.deviceId ?? null,
      fileId: file?.id ?? null,
      versionId: file?.current_version_id ?? null,
      action,
      orgId: details.orgId ?? null,
      details,
    }).catch(error => console.error('[SullaFiles] PostgreSQL audit dual-write failed; file-change event remains in durable spool', error));
  };
}
