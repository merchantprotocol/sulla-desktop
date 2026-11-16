// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import { validateAuditEvent } from '../fileAudit.js';
import type { AuditSpoolRepository } from '../Repositories/AuditSpoolRepository.js';

/** What the route needs from FileAuditWriter (any staged-content type): background delivery of the spool. */
export interface AuditSpoolDelivery { drain():Promise<void> }

/** POST /v1/system/audit-events: spool a service audit event, answer 202, then deliver in the background (moved from app.ts). */
export class AuditEventRoutes {
  constructor(private readonly spool:AuditSpoolRepository, private readonly writer:AuditSpoolDelivery) {}

  register(app:express.Express):void {
    app.post('/v1/system/audit-events',async(request,response,next)=>{try {
      const event=validateAuditEvent(request.body);
      await this.spool.enqueue(event);
      response.status(202).json({ok:true});
      void this.writer.drain().catch(error=>console.error('[SullaFiles] audit delivery failed; retry pending',error));
    } catch(error) {next(error)} });
  }
}
