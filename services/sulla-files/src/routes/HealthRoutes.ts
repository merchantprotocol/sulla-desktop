// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { Config } from '../config.js';
import { healthPayload } from '../health.js';
import type { FilesLifecycle } from '../lifecycle.js';
import type { DatabaseHealthRepository } from '../Repositories/DatabaseHealthRepository.js';
import type { FilesMetrics } from '../FilesMetrics.js';

/**
 * /healthz: 503 while Postgres is unreachable (Desktop treats that as temporarily unavailable and
 * retries); the body keeps the unlock-handshake fields either way.
 */
export class HealthRoutes {
  constructor(
    private readonly config:Config,
    private readonly ready:() => boolean,
    private readonly databaseHealth:DatabaseHealthRepository,
    private readonly filesLifecycle?:FilesLifecycle,
    private readonly metrics?:FilesMetrics,
  ) {}

  register(app:express.Express):void {
    app.get('/healthz', async(_request, response) => {
      const payload = healthPayload(this.config, this.ready(), this.filesLifecycle?.status());
      if (await this.databaseHealth.reachable()) response.json(payload);
      else response.status(503).json({ ...payload, ok: false, error: 'database_unavailable' });
    });
    // Under /v1/local/*, so the local service token guard in FilesRequestPipeline.authenticate applies.
    // Numbers only: counts, sums, maxima and percentiles. No file names, paths or user data.
    const metrics = this.metrics;
    if (metrics) app.get('/v1/local/files-metrics', (_request, response) => response.json(metrics.snapshot()));
  }
}
