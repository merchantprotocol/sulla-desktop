// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import {
  BackupEnvelopeCodec,
  DesktopLocalCredential,
  DesktopLocalKdfRecord,
  DesktopLocalRecovery,
  KeyWrap,
  LocalItemCipher,
  type AccountKdf,
  type CryptoPrimitives,
  type DesktopLocalKdfJson,
  type LocalEncryptedItem,
  type LocalItemContext,
  type RandomSource,
  type ScryptFunction,
  type XChaChaEnvelope,
} from '@sulla/domain';

import { DesktopHumanBackup } from './DesktopHumanBackup.js';
import { NodeScryptFunction } from './NodeScryptFunction.js';

/** `users.login_hash_salt` / `login_hash_verifier` as node-postgres writes `bytea`. */
export interface LocalLoginVerifier {
  salt:     Buffer;
  verifier: Buffer;
}

/** Key material for a brand-new local vault (first unlock). */
export interface NewLocalAccount {
  userKey:             Uint8Array;
  privateKey:          Uint8Array;
  publicKey:           string;
  encryptedUserKey:    XChaChaEnvelope;
  encryptedPrivateKey: XChaChaEnvelope;
  verifier:            LocalLoginVerifier;
}

/**
 * The Desktop vault's local crypto, composed from the `@sulla/domain` local-vault classes: password KDF and
 * login verifier (`DesktopLocalCredential`), the `users.kdf` record (`DesktopLocalKdfRecord`), recovery
 * (`DesktopLocalRecovery`), items at rest (`LocalItemCipher`) and backup files (`DesktopHumanBackup` over
 * `BackupEnvelopeCodec`). Every format is byte-for-byte what `@sulla/vault-crypto` wrote, so existing rows,
 * recovery codes and backups open unchanged. Nothing here writes to the database or rewraps on its own.
 */
export class LocalVaultCrypto {
  constructor(
    readonly credential: DesktopLocalCredential,
    readonly recovery: DesktopLocalRecovery,
    readonly items: LocalItemCipher,
    readonly backups: DesktopHumanBackup,
    private readonly primitives: CryptoPrimitives,
    private readonly random: RandomSource,
  ) {}

  /** Wires the domain classes over one set of primitives and one CSPRNG. */
  static compose(primitives: CryptoPrimitives, random: RandomSource, scrypt: ScryptFunction = new NodeScryptFunction()): LocalVaultCrypto {
    const wraps = new KeyWrap(primitives, random);
    const credential = new DesktopLocalCredential(primitives, wraps, scrypt, random);
    return new LocalVaultCrypto(
      credential,
      new DesktopLocalRecovery(credential, wraps, random),
      new LocalItemCipher(wraps, random),
      new DesktopHumanBackup(new BackupEnvelopeCodec(primitives, wraps, random)),
      primitives,
      random,
    );
  }

  /** The stored `users.kdf`, or `undefined` when it can't be read as any shape Desktop has written. */
  readKdf(stored: unknown): DesktopLocalKdfRecord | undefined {
    try {
      return DesktopLocalKdfRecord.parse(stored);
    } catch {
      return undefined;
    }
  }

  /** The `users.kdf` value Desktop writes for a password (no Cloud owner binding, as every local writer did). */
  kdfColumn(kdf: AccountKdf): DesktopLocalKdfJson {
    return DesktopLocalKdfRecord.forPassword(kdf).toJSON();
  }

  newVerifier(masterKey: Uint8Array): LocalLoginVerifier {
    const created = this.credential.createVerifier(masterKey);
    return { salt: Buffer.from(created.salt), verifier: Buffer.from(created.verifier) };
  }

  verifyPassword(masterKey: Uint8Array, salt: Uint8Array, verifier: Uint8Array): boolean {
    return this.credential.verify(masterKey, salt, verifier);
  }

  /** A fresh user key and X25519 identity, both sealed, plus the login verifier for this master key. */
  createAccount(masterKey: Uint8Array): NewLocalAccount {
    const userKey = this.random.bytes(32);
    const privateKey = this.random.bytes(32);
    try {
      const encryptedUserKey = this.credential.sealUserKey(masterKey, userKey);
      const encryptedPrivateKey = this.credential.sealPrivateKey(userKey, privateKey);
      const publicKey = Buffer.from(this.primitives.x25519PublicKey(privateKey)).toString('base64url');
      return { userKey, privateKey, publicKey, encryptedUserKey, encryptedPrivateKey, verifier: this.newVerifier(masterKey) };
    } catch (error) {
      userKey.fill(0);
      privateKey.fill(0);
      throw error;
    }
  }

  sealItem(plaintext: string, userKey: Uint8Array, context: LocalItemContext): LocalEncryptedItem {
    return this.items.seal(plaintext, userKey, context);
  }

  openItemText(item: LocalEncryptedItem, userKey: Uint8Array, context: LocalItemContext): string {
    return this.items.openText(item, userKey, context);
  }
}
