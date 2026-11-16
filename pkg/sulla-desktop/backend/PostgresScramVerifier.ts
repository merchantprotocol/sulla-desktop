// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto';

/** Thrown when a password cannot be turned into a verifier PostgreSQL would agree with. Never carries the value. */
export class ScramVerifierUnsupportedPasswordError extends Error {
  constructor() {
    super('the service secret is not printable ASCII, so its SCRAM verifier cannot be computed safely');
    this.name = 'ScramVerifierUnsupportedPasswordError';
  }
}

/**
 * A PostgreSQL SCRAM-SHA-256 password verifier (RFC 5802 / RFC 7677), in the
 * exact text form PostgreSQL stores in pg_authid.rolpassword:
 *
 *   SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>
 *
 * Built in Node so `ALTER ROLE … PASSWORD '<verifier>'` never sends the
 * plaintext to the server (PostgreSQL stores a well-formed verifier as is).
 *
 * PostgreSQL applies SASLprep to the password first. For printable ASCII that
 * is the identity, so only printable ASCII is accepted; anything else throws
 * rather than produce a verifier the server might not agree with.
 */
export class PostgresScramVerifier {
  static readonly PREFIX = 'SCRAM-SHA-256';
  /** PostgreSQL's default scram_iterations. */
  static readonly ITERATIONS = 4096;
  static readonly SALT_BYTES = 16;
  private static readonly KEY_BYTES = 32;
  private static readonly FORMAT = /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;
  private static readonly PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

  private constructor(
    readonly iterations: number,
    private readonly salt: Buffer,
    private readonly storedKey: Buffer,
    private readonly serverKey: Buffer,
  ) {}

  /** A new verifier for the password with a random salt. */
  static create(password: string, salt: Buffer = randomBytes(PostgresScramVerifier.SALT_BYTES),
    iterations = PostgresScramVerifier.ITERATIONS): PostgresScramVerifier {
    const keys = PostgresScramVerifier.keys(password, salt, iterations);

    return new PostgresScramVerifier(iterations, Buffer.from(salt), keys.storedKey, keys.serverKey);
  }

  /** Parses a stored verifier; null for anything else (md5, plaintext, empty). */
  static parse(text: string | null | undefined): PostgresScramVerifier | null {
    const match = PostgresScramVerifier.FORMAT.exec((text ?? '').trim());

    if (!match) {
      return null;
    }
    const iterations = Number(match[1]);
    const salt = Buffer.from(match[2], 'base64');
    const storedKey = Buffer.from(match[3], 'base64');
    const serverKey = Buffer.from(match[4], 'base64');

    if (!Number.isSafeInteger(iterations) || iterations < 1 || salt.length === 0
      || storedKey.length !== PostgresScramVerifier.KEY_BYTES || serverKey.length !== PostgresScramVerifier.KEY_BYTES) {
      return null;
    }

    return new PostgresScramVerifier(iterations, salt, storedKey, serverKey);
  }

  /** True when this verifier was made from the password (constant-time compare). */
  matches(password: string): boolean {
    let keys: { storedKey: Buffer, serverKey: Buffer };

    try {
      keys = PostgresScramVerifier.keys(password, this.salt, this.iterations);
    } catch {
      return false;
    }

    return timingSafeEqual(keys.storedKey, this.storedKey) && timingSafeEqual(keys.serverKey, this.serverKey);
  }

  toString(): string {
    return `${ PostgresScramVerifier.PREFIX }$${ this.iterations }:${ this.salt.toString('base64') }`
      + `$${ this.storedKey.toString('base64') }:${ this.serverKey.toString('base64') }`;
  }

  private static keys(password: string, salt: Buffer, iterations: number): { storedKey: Buffer, serverKey: Buffer } {
    if (!PostgresScramVerifier.PRINTABLE_ASCII.test(password)) {
      throw new ScramVerifierUnsupportedPasswordError();
    }
    const salted = pbkdf2Sync(Buffer.from(password, 'utf-8'), salt, iterations, PostgresScramVerifier.KEY_BYTES, 'sha256');
    const clientKey = createHmac('sha256', salted).update('Client Key').digest();

    return {
      storedKey: createHash('sha256').update(clientKey).digest(),
      serverKey: createHmac('sha256', salted).update('Server Key').digest(),
    };
  }
}
