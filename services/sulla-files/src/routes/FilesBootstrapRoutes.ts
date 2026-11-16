// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import express from 'express';

import { FilesBootstrapError, type FilesBootstrapAuthority } from '../bootstrapAuthority.js';
import type { Config } from '../config.js';
import type { FilesLifecycle } from '../lifecycle.js';

/** Desktop secure bootstrap (challenge/unlock, mounted before auth) and the local lock route (mounted after it). */
export class FilesBootstrapRoutes {
  private readonly bootstrapJsonParser = express.json({ limit: '32kb' });

  constructor(
    private readonly config:Config,
    private readonly bootstrapAuthority?:FilesBootstrapAuthority,
    private readonly filesLifecycle?:FilesLifecycle,
    private readonly onLock?:() => Promise<void>,
  ) {}

  registerBootstrap(app:express.Express):void {
    for (const step of ['challenge', 'unlock'] as const) {
      app.post(`/v1/bootstrap/${ step }`, this.bootstrapJsonParser, async(request, response) => {
        const authority = this.bootstrapAuthority;
        if (this.config.mode !== 'desktop' || !authority) return response.sendStatus(404);
        try { return response.json(step === 'challenge' ? await authority.challenge(request.body) : await authority.unlock(request.body)) } catch (error) {
          const failure = error instanceof FilesBootstrapError ? error : new FilesBootstrapError('FILES_BOOTSTRAP_FAILED', 503, 'Files bootstrap failed');
          return response.status(failure.status).json({ code: failure.code, error: failure.message });
        }
      });
    }
  }

  registerLock(app:express.Express):void {
    app.post('/v1/local/lock', async(_request, response) => {
      if (this.config.mode !== 'desktop') return response.sendStatus(404);
      if (this.filesLifecycle) await this.filesLifecycle.lock();
      else { await this.onLock?.(); this.config.keyring?.close() }
      this.bootstrapAuthority?.invalidate();
      response.json({ ok: true });
    });
  }
}
