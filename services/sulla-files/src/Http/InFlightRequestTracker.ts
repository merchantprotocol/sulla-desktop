// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

/** Counts requests still in flight per path (first 200 chars); the process reports it in memory telemetry. */
export class InFlightRequestTracker {
  readonly counts = new Map<string, number>();

  readonly middleware:express.RequestHandler = (request, response, next) => {
    const path = request.path.slice(0, 200);
    this.counts.set(path, (this.counts.get(path) ?? 0) + 1);
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      const remaining = (this.counts.get(path) ?? 1) - 1;
      if (remaining) this.counts.set(path, remaining);
      else this.counts.delete(path);
    };
    response.once('finish', release);
    response.once('close', release);
    next();
  };
}
