// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// E10 S2c: the vault service's login/recovery verifier check must accept only the full 32-byte verifier.
// @sulla/domain 0.3.3 and 0.4.1 checked a stored verifier at its own length (16-64 bytes); scrypt output is
// prefix-stable, so a 16-byte prefix of the real verifier still "matched" and halved the work to forge one.
// 0.4.2 (sulla-core PR #63) refuses any length other than 32. These specs go through the service's own
// LocalVaultCrypto, so they fail on any domain build that still has the bug.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import type { LocalVaultCrypto } from '../../../../../../services/sulla-vault/src/localCrypto/LocalVaultCrypto';
import { LocalVaultCryptoProvider } from '../../../../../../services/sulla-vault/src/localCrypto/LocalVaultCryptoProvider';

/** A synthetic master key and the verifier the service stores for it. */
class VerifierScenario {
  readonly masterKey = crypto.getRandomValues(new Uint8Array(32));
  readonly stored: { salt: Uint8Array; verifier: Uint8Array };

  constructor(private readonly vault: LocalVaultCrypto) {
    this.stored = vault.newVerifier(this.masterKey);
  }

  verifies(verifier: Uint8Array, masterKey: Uint8Array = this.masterKey): boolean {
    return this.vault.verifyPassword(masterKey, this.stored.salt, verifier);
  }
}

/** Which vendored @sulla/domain tarball a package.json (relative to the repo root) pins. */
class DomainPin {
  private static readonly ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

  static of(packageJson: string): string {
    const parsed = JSON.parse(readFileSync(path.join(DomainPin.ROOT, packageJson), 'utf8')) as { dependencies: Record<string, string> };
    return path.basename(parsed.dependencies['@sulla/domain'] ?? '');
  }
}

let scenario: VerifierScenario;

describe('sulla-vault local verifier length (E10 S2c, @sulla/domain 0.4.2)', () => {
  beforeAll(async() => { scenario = new VerifierScenario(await new LocalVaultCryptoProvider().get()) });

  it('accepts the full 32-byte verifier for the right master key and refuses another key', () => {
    // risk: authentication — the fix must not lock out existing users, whose verifiers are always 32 bytes.
    expect(scenario.stored.verifier.byteLength).toBe(32);
    expect(scenario.verifies(scenario.stored.verifier)).toBe(true);
    expect(scenario.verifies(scenario.stored.verifier, crypto.getRandomValues(new Uint8Array(32)))).toBe(false);
  });

  it('refuses a genuine 16-byte prefix of the real verifier, even with the right master key', () => {
    // risk: authentication bypass — a truncated stored verifier must never unlock the vault.
    expect(scenario.verifies(scenario.stored.verifier.slice(0, 16))).toBe(false);
  });

  it('refuses every other truncated or padded length of the real verifier', () => {
    // risk: authentication bypass — only exactly 32 bytes is a valid verifier.
    const padded = new Uint8Array(64);
    padded.set(scenario.stored.verifier);
    for (const candidate of [scenario.stored.verifier.slice(0, 24), scenario.stored.verifier.slice(0, 31), padded, new Uint8Array(0)]) {
      expect(scenario.verifies(candidate)).toBe(false);
    }
  });

  it('the vault service image pins the same @sulla/domain build these specs run against', () => {
    // risk: authentication bypass — specs resolve the root package; a stale service pin would ship the old verify.
    expect(DomainPin.of('services/sulla-vault/package.json')).toBe(DomainPin.of('package.json'));
  });
});
