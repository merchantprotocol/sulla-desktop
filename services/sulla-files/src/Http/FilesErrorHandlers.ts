// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import { RetryableDatabaseError, type DatabaseFailureClassifier } from '../FilesTransaction.js';

/** The Files API's last error handlers, mounted after every route in this order. */
export class FilesErrorHandlers {
  constructor(private readonly databaseFailures:DatabaseFailureClassifier) {}

  register(app:express.Express):void {
    app.use('/v1/database-file-operations', this.databaseOperations);
    app.use(this.retryableDatabase);
    app.use(this.final);
  }

  private readonly databaseOperations = (error:any, _request:any, response:any, _next:any) => {
    const status = error.status ?? (error.code === '23505' ? 409 : 500);
    response.status(status).json({ error: status < 500 ? error.message : 'Database operation failed', code: error.code ?? 'operation-failed' });
  };

  /**
   * A lost database connection is transient: answer 503 + Retry-After with a stable code so the
   * mount and other clients retry, instead of an opaque 500 that surfaces to agents as EIO.
   */
  private readonly retryableDatabase = (error:any, _request:any, response:any, next:any) => {
    if (!(error instanceof RetryableDatabaseError) && error?.code !== 'FILES_DB_RETRYABLE' && !this.databaseFailures.isConnectionLoss(error)) return next(error);
    console.warn('[SullaFiles] request failed on a lost database connection; client may retry', { path: _request.path, error: String(error?.cause?.message ?? error?.message ?? error) });
    response.setHeader('Retry-After', '1');
    return response.status(503).json({ error: error instanceof RetryableDatabaseError || error?.code === 'FILES_DB_RETRYABLE' ? error.message : 'Files lost its database connection; retry the request', code: 'FILES_DB_RETRYABLE', retryable: true });
  };

  private readonly final = (error:any, _request:any, response:any, _next:any) => response.status(error.status ?? (error.code === '23505' ? 409 : error.code === '55000' ? 423 : 500)).json({ error: _request.path.startsWith('/v1/bootstrap/') || error.type === 'entity.parse.failed' ? 'Invalid request' : error.message ?? 'server error', ...((error.status === 423 || error.code === '55000') ? {code:'FILE_LOCKED'} : error.code === 'EROFS' ? {code:'EROFS'} : error.code === 'FILE_OFFLINE' ? {code:'FILE_OFFLINE'} : {}), ...(error.conflictPath ? { conflictPath: error.conflictPath } : {}) });
}
