// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VaultConfig } from '../config.js';
import type { PostgresDesktopAccountRepository } from '../repositories/PostgresDesktopAccountRepository.js';
import type { VaultLoginVerifier } from './VaultLoginVerifier.js';

/** Creates the single desktop account from the bootstrap configuration when the vault has no users yet. */
export class DesktopAccountBootstrapper {
  constructor(
    private readonly accounts: PostgresDesktopAccountRepository,
    private readonly verifiers: VaultLoginVerifier,
  ) {}

  async ensure(config: VaultConfig): Promise<void> {
    if (!config.desktopLoginHash) {
      return;
    }
    if (!config.desktopPublicKey || !config.desktopEncryptedPrivateKey || !config.desktopEncryptedUserKey || !config.desktopKdf) {
      throw new Error('Desktop bootstrap requires public key, wrapped private key, wrapped user key, and KDF settings');
    }
    if (await this.accounts.anyUserExists()) {
      return;
    }
    const { salt, verifier } = this.verifiers.make(config.desktopLoginHash);
    await this.accounts.insert({
      email:               'desktop@local.sulla',
      loginHashSalt:       salt,
      loginHashVerifier:   verifier,
      publicKey:           config.desktopPublicKey,
      encryptedPrivateKey: config.desktopEncryptedPrivateKey,
      encryptedUserKey:    config.desktopEncryptedUserKey,
      kdf:                 config.desktopKdf,
    });
  }
}
