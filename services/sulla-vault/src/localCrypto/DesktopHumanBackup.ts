// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { BackupEnvelopeCodec, HumanBackupEnvelope } from '@sulla/domain';

/** A `bytea` column: a Buffer as node-postgres returns it, or its `Buffer#toJSON` shape once a backup is opened. */
export type BackupBytea = Buffer | { type: 'Buffer'; data: number[] };

/**
 * The `users` row a backup carries: exactly the columns `PostgresVaultUserRepository.findById` selects.
 * A type alias (not an interface) so it satisfies node-postgres' `QueryResultRow` constraint.
 */
export type VaultUserBackupRow = {
  id:                    string;
  email:                 string;
  login_hash_salt:       BackupBytea;
  login_hash_verifier:   BackupBytea;
  public_key:            string;
  encrypted_private_key: unknown;
  encrypted_user_key:    unknown;
  kdf:                   unknown;
};

/**
 * The clear payload inside a Desktop backup file: the `users` row, the owned `items` rows and the
 * `local_vault_recovery` row exactly as node-postgres returned them. `bytea` columns are serialized by
 * `Buffer#toJSON` (`{"type":"Buffer","data":[...]}`); the domain codec doesn't model that shape, so this
 * adapter owns it. The JSON text is byte-for-byte what `exportHumanBackup` has always encrypted.
 */
export interface DesktopBackupPayload {
  version:  1;
  user:     VaultUserBackupRow;
  items:    Array<Record<string, any>>;
  recovery: Record<string, any> | null;
}

/** Desktop's `HumanBackupEnvelope` v1 files, sealed and opened through the domain `BackupEnvelopeCodec`. */
export class DesktopHumanBackup {
  constructor(private readonly codec: BackupEnvelopeCodec) {}

  /** Seals one backup. A fresh Argon2 salt and nonce are drawn per call; parameters are Desktop's (64 MiB, 3 ops). */
  seal(contents: Omit<DesktopBackupPayload, 'version'>, backupPassword: string): HumanBackupEnvelope {
    const clear = Buffer.from(JSON.stringify({ version: 1, user: contents.user, items: contents.items, recovery: contents.recovery }));
    try {
      return this.codec.encode(clear, backupPassword);
    } finally {
      clear.fill(0);
    }
  }

  /** Opens a backup file. Throws for a wrong password, a malformed envelope or a payload that isn't a Desktop backup. */
  open(envelope: unknown, backupPassword: string): DesktopBackupPayload {
    const clear = this.codec.decode(envelope, backupPassword);
    try {
      const payload = JSON.parse(Buffer.from(clear).toString('utf8')) as DesktopBackupPayload;
      if (payload?.version !== 1 || !payload.user?.id || !Array.isArray(payload.items)) throw new Error('invalid backup payload');
      return payload;
    } finally {
      clear.fill(0);
    }
  }

  /** A `bytea` column from the payload (`Buffer#toJSON` shape) back as the Buffer Postgres expects. */
  static bytea(value: unknown): Buffer {
    if (!value || typeof value !== 'object' || !Array.isArray((value as { data?: unknown }).data)) throw new Error('invalid backup byte field');
    return Buffer.from((value as { data: number[] }).data);
  }
}
