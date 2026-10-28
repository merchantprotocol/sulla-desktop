// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Express, RequestHandler } from 'express';
import type { AccountsContext } from './accountsIdentity.js';
import type { VaultConfig } from './config.js';
import type { Database } from './db.js';

export const VAULT_ADAPTER_API_VERSION = 1 as const;

export interface VaultAdapter {
  readonly apiVersion: typeof VAULT_ADAPTER_API_VERSION;
  resolveIdentity(config: VaultConfig, input: { bearerToken: string }): Promise<AccountsContext>;
  authenticate(config: VaultConfig, db: Database): RequestHandler;
  register(app: Express, context: { db: Database; config: VaultConfig }): void;
}

export function assertVaultAdapter(adapter: VaultAdapter): VaultAdapter {
  if (adapter?.apiVersion !== VAULT_ADAPTER_API_VERSION || typeof adapter.resolveIdentity !== 'function' ||
      typeof adapter.authenticate !== 'function' || typeof adapter.register !== 'function') {
    throw new Error(`Vault adapter API ${VAULT_ADAPTER_API_VERSION} is required`);
  }
  return adapter;
}
