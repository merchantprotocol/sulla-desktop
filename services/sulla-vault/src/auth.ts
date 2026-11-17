// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DesktopAccountBootstrapper } from './auth/DesktopAccountBootstrapper.js';
import { VaultLoginVerifier } from './auth/VaultLoginVerifier.js';
import type { VaultConfig } from './config.js';
import type { Database } from './db.js';
import { VaultRepositories } from './repositories/VaultRepositories.js';
import { VaultProfileSessionFactory } from './profiles/VaultProfileSessionFactory.js';

/** @deprecated use VaultLoginVerifier#make — E9 alias, removed in final cleanup */
export function makeLoginVerifier(loginHash: string, salt?: Buffer): { salt: Buffer; verifier: Buffer } {
  return new VaultLoginVerifier().make(loginHash, salt);
}

/** @deprecated use DesktopAccountBootstrapper#ensure with a PostgresDesktopAccountRepository — E9 alias, removed in final cleanup */
export function ensureDesktopAccount(db: Database, config: VaultConfig, repositories: VaultRepositories = new VaultRepositories(
  new VaultProfileSessionFactory(db, config.profileProvisioningEnabled ?? false).legacy(),
)): Promise<void> {
  return new DesktopAccountBootstrapper(repositories.desktopAccount, new VaultLoginVerifier()).ensure(config);
}
