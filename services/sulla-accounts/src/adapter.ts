// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Express } from 'express';
import type { AccountsConfig } from './config.js';
import type { Database } from './db.js';

export const ACCOUNTS_ADAPTER_API_VERSION = 1 as const;

export interface AccountsAdapter {
  readonly apiVersion: typeof ACCOUNTS_ADAPTER_API_VERSION;
  register(app: Express, context: { db: Database; config: AccountsConfig }): void | Promise<void>;
}

export function assertAccountsAdapter(adapter: AccountsAdapter): AccountsAdapter {
  if (adapter?.apiVersion !== ACCOUNTS_ADAPTER_API_VERSION || typeof adapter.register !== 'function') {
    throw new Error(`Accounts adapter API ${ACCOUNTS_ADAPTER_API_VERSION} is required`);
  }
  return adapter;
}
