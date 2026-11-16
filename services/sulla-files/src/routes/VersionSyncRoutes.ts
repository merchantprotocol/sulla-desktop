// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { RequestWithIdentity } from '../Http/FilesAccessGate.js';
import type { RemoteVersionSync } from '../Services/RemoteVersionSync.js';

/** POST /v1/versions/prepare and /commit: remote devices pushing versions they already chunked and encrypted. */
export class VersionSyncRoutes {
  constructor(private readonly sync:RemoteVersionSync) {}

  register(app:express.Express):void {
    app.post('/v1/versions/prepare', async(request:RequestWithIdentity, response, next) => { try { const result = await this.sync.prepare(request, request.body, undefined, false, true); response.json({ missing: result.missing, currentVersionId: result.currentVersionId, canonicalFileId: result.canonicalFileId, conflict: result.conflict }) } catch (error) { next(error) } });
    app.post('/v1/versions/commit', async(request:RequestWithIdentity, response, next) => { try {
      const outcome = await this.sync.commit(request, request.body);
      response.status(outcome.status).json(outcome.body);
    } catch (error) { next(error) } });
  }
}
