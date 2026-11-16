// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { RequestWithIdentity } from '../Http/FilesAccessGate.js';
import type { SearchScopeRepository } from '../Repositories/SearchScopeRepository.js';
import type { FileSearch } from '../search.js';

/** POST /v1/search over every published collection; a client disconnect aborts the search. */
export class SearchRoutes {
  constructor(private readonly scopes:SearchScopeRepository, private readonly search?:FileSearch) {}

  register(app:express.Express):void {
    app.post('/v1/search', async(request:RequestWithIdentity, response, next) => {
      const abort = new AbortController();
      const disconnected = () => { if (!response.writableEnded) abort.abort() };
      request.once('aborted', disconnected); response.once('close', disconnected);
      try {
        if (!this.search) return response.status(503).json({ error: 'search unavailable' });
        const scopes = await this.scopes.publishedCollectionScopes();
        const result = await this.search.search(request.body, scopes, abort.signal);
        if (!abort.signal.aborted) response.json(result);
      } catch (error) { if (!abort.signal.aborted) next(error) }
      finally { request.off('aborted', disconnected); response.off('close', disconnected) }
    });
  }
}
