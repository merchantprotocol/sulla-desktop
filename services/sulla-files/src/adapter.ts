// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Express, RequestHandler } from 'express';
import type { Config } from './config.js';
import type pg from 'pg';

export const FILES_ADAPTER_API_VERSION = 1 as const;

export interface FilesAdapter {
  readonly apiVersion: typeof FILES_ADAPTER_API_VERSION;
  authenticate(context: { config: Config; db: pg.Pool; identityDb?: pg.Pool }): RequestHandler;
  authorizeProvisioning(context: { userId: string; organizationId: string; identityDb: pg.Pool }): Promise<void>;
  register(app: Express, context: { db: pg.Pool; config: Config; identityDb?: pg.Pool }): void | Promise<void>;
}

export function assertFilesAdapter(adapter: FilesAdapter): FilesAdapter {
  if (adapter?.apiVersion !== FILES_ADAPTER_API_VERSION || typeof adapter.authenticate !== 'function' ||
      typeof adapter.authorizeProvisioning !== 'function' || typeof adapter.register !== 'function') {
    throw new Error(`Files adapter API ${FILES_ADAPTER_API_VERSION} is required`);
  }
  return adapter;
}
