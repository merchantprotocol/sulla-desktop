// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { NextFunction, Request, Response } from 'express';
import type express from 'express';

import { isTransientDbError, warnDatabaseUnavailable } from '../db.js';
import { LocalVaultError } from '../localAuthority.js';
import { UPSTREAM_RETRY_AFTER_SECONDS, describeUpstreamError, isUpstreamNetworkError, upstreamFailurePhase, upstreamFailureReason } from '../upstreamEgress.js';
import { VaultHttpError } from './VaultRequestInput.js';

/**
 * The vault's last middleware: maps vault, request, unique-violation, database and upstream
 * errors to their HTTP status and JSON body; anything else is a logged 500.
 */
export class VaultErrorHandler {
  register(app: express.Express): void {
    app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
      if (error instanceof LocalVaultError) {
        // Egress failures are transient path problems (network change, DNS, VPN), not policy decisions.
        const retryable = error.code === 'upstream_failed' || error.code === 'upstream_timeout';
        if (request.path.startsWith('/v1/broker/')) {
          response.setHeader('X-Sulla-Vault-Error', error.code);
          if (error.reason) response.setHeader('X-Sulla-Vault-Error-Reason', error.reason);
          if (retryable && error.status !== 499) response.setHeader('Retry-After', String(UPSTREAM_RETRY_AFTER_SECONDS));
        }
        response.status(error.status).json({
          error: error.code,
          message: error.code === 'approval_required' ? 'Owner approval is required' : error.message,
          ...(error.code === 'approval_required' ? { operationId: error.message } : {}),
          ...(error.reason ? { reason: error.reason } : {}),
          ...(retryable && error.status !== 499 ? { retryable: true } : {}),
        });
        return;
      }
      if (error instanceof VaultHttpError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
        response.status(409).json({ error: 'already_exists' });
        return;
      }
      if (isTransientDbError(error)) {
        warnDatabaseUnavailable(error);
        response.setHeader('Retry-After', '5');
        response.status(503).json({ error: 'database_unavailable' });
        return;
      }
      if (isUpstreamNetworkError(error)) {
        // An outbound fetch (provider, Sulla Cloud) failed; Postgres is fine. Report it as the egress failure it is.
        const detail = describeUpstreamError(error);
        const reason = upstreamFailureReason(upstreamFailurePhase(detail.code, false), detail.code);
        console.warn(`sulla-vault: upstream request failed (${ reason })`);
        response.setHeader('Retry-After', String(UPSTREAM_RETRY_AFTER_SECONDS));
        response.status(502).json({ error: 'upstream_failed', message: 'Upstream request failed', reason, retryable: true });
        return;
      }
      console.error(error);
      response.status(500).json({ error: 'internal_error' });
    });
  }
}
