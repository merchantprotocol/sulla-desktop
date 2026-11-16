// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DesktopAccountBootstrapper } from './auth/DesktopAccountBootstrapper.js';
import { VaultLoginVerifier } from './auth/VaultLoginVerifier.js';
import type { VaultConfig } from './config.js';
import type { Queryable } from './db.js';
import { PostgresDesktopAccountRepository } from './repositories/PostgresDesktopAccountRepository.js';

/** @deprecated use VaultLoginVerifier#make — E9 alias, removed in final cleanup */
export function makeLoginVerifier(loginHash: string, salt?: Buffer): { salt: Buffer; verifier: Buffer } {
  return new VaultLoginVerifier().make(loginHash, salt);
}

/** @deprecated use VaultLoginVerifier#verify — E9 alias, removed in final cleanup */
export function verifyLoginHash(loginHash: string, salt: Uint8Array, expected: Uint8Array): boolean {
  return new VaultLoginVerifier().verify(loginHash, salt, expected);
}

/** @deprecated use DesktopAccountBootstrapper#ensure with a PostgresDesktopAccountRepository — E9 alias, removed in final cleanup */
export function ensureDesktopAccount(db: Queryable, config: VaultConfig): Promise<void> {
  return new DesktopAccountBootstrapper(new PostgresDesktopAccountRepository(db), new VaultLoginVerifier()).ensure(config);
}
