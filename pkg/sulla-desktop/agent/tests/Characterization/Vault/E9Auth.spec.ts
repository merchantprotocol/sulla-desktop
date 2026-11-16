// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 db/auth characterization: login verifiers and the desktop account bootstrap must produce byte-identical
// results to the frozen pre-refactor copy (Support/E9Legacy/auth.legacy.ts), including errors and SQL effects.

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as current from '../../../../../../services/sulla-vault/src/auth';
import type { VaultConfig } from '../../../../../../services/sulla-vault/src/config';
import type { Queryable } from '../../../../../../services/sulla-vault/src/db';
import * as legacy from '../../Support/E9Legacy/auth.legacy';

class Hex {
  static bytes(hex: string): Buffer { return Buffer.from(hex, 'hex') }
  static of(bytes: Uint8Array): string { return Buffer.from(bytes).toString('hex') }
}

class ErrorShape {
  static of(run: () => unknown): unknown {
    try {
      return { value: run() };
    } catch (error) {
      const e = error as { constructor?: { name?: string }; code?: unknown; message?: unknown };
      return { error: e?.constructor?.name, code: e?.code, message: e?.message };
    }
  }
}

describe('E9 auth.ts login verifiers match the pre-refactor implementation', () => {
  const vectors: Array<[string, string, string]> = [
    // [loginHash, salt hex, scrypt(loginHash, salt, 32) hex] — Node scryptSync defaults N=16384 r=8 p=1.
    ['login-hash-text', '000102030405060708090a0b0c0d0e0f', '19c66fff65f6e2972fec2b6e5bf20a06d766726fa4188633974a35f3441ecd9b'],
    ['', 'ffffffffffffffffffffffffffffffff', '595a96f2a75d1ccde5cb7a271991c260673c95e00a7708e22a606f8ae34905b7'],
    ['dGVzdC1sb2dpbi1oYXNo', 'a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5', '9d8edc9fd0c9cc4c31fd493e02f4fd9867573b6fdfe372f3d634dbbf89d534c2'],
  ];

  it('makeLoginVerifier produces the known-answer verifier and returns the given salt', () => { // risk: sign-in (every stored verifier)
    for (const [loginHash, saltHex, verifierHex] of vectors) {
      const salt = Hex.bytes(saltHex);
      const made = current.makeLoginVerifier(loginHash, salt);
      const old = legacy.makeLoginVerifier(loginHash, salt);
      expect(made.salt).toBe(salt);
      expect(Hex.of(made.verifier)).toBe(verifierHex);
      expect(Hex.of(made.verifier)).toBe(Hex.of(old.verifier));
      expect(made.verifier.byteLength).toBe(32);
    }
  });

  it('makeLoginVerifier matches legacy across salts and inputs', () => { // risk: sign-in
    for (let i = 0; i < 12; i++) {
      const salt = Buffer.alloc(8 + i * 3, i * 17);
      const hash = `hash-${ i }-${ 'x'.repeat(i * 9) }`;
      expect(Hex.of(current.makeLoginVerifier(hash, salt).verifier)).toBe(Hex.of(legacy.makeLoginVerifier(hash, salt).verifier));
    }
  });

  it('makeLoginVerifier without a salt draws a fresh 16-byte salt that legacy can verify', () => { // risk: salt reuse
    const first = current.makeLoginVerifier('fresh-salt');
    const second = current.makeLoginVerifier('fresh-salt');
    expect(first.salt.byteLength).toBe(16);
    expect(Hex.of(first.salt)).not.toBe(Hex.of(second.salt));
    expect(legacy.verifyLoginHash('fresh-salt', first.salt, first.verifier)).toBe(true);
    expect(Hex.of(legacy.makeLoginVerifier('fresh-salt', first.salt).verifier)).toBe(Hex.of(first.verifier));
  });

  it('verifyLoginHash gives the same decision (or the same error) as legacy for every case', () => { // risk: authentication bypass
    const [loginHash, saltHex, verifierHex] = vectors[0];
    const salt = Hex.bytes(saltHex);
    const verifier = Hex.bytes(verifierHex);
    const flipped = Buffer.from(verifier);
    flipped[31] ^= 1;
    const cases: Array<[string, string, Uint8Array, Uint8Array]> = [
      ['correct', loginHash, salt, verifier],
      ['correct as Uint8Array', loginHash, new Uint8Array(salt), new Uint8Array(verifier)],
      ['wrong hash', 'login-hash-texT', salt, verifier],
      ['empty hash', '', salt, verifier],
      ['wrong salt', loginHash, Hex.bytes('000102030405060708090a0b0c0d0e0e'), verifier],
      ['tampered verifier', loginHash, salt, flipped],
      ['short verifier prefix', loginHash, salt, verifier.subarray(0, 16)],
      ['long verifier', loginHash, salt, Buffer.concat([verifier, verifier])],
      ['empty verifier', loginHash, salt, new Uint8Array(0)],
      ['empty salt', loginHash, new Uint8Array(0), verifier],
    ];
    for (const [name, hash, s, expected] of cases) {
      expect([name, ErrorShape.of(() => current.verifyLoginHash(hash, s, expected))]).toEqual([name, ErrorShape.of(() => legacy.verifyLoginHash(hash, s, expected))]);
    }
    expect(current.verifyLoginHash(loginHash, salt, verifier)).toBe(true);
    expect(current.verifyLoginHash('login-hash-texT', salt, verifier)).toBe(false);
    expect(current.verifyLoginHash(loginHash, salt, flipped)).toBe(false);
    // Pinned current behaviour (latent weakness, not fixed in E9): scrypt output is prefix-consistent
    // (scrypt(x, s, 16) equals the first 16 bytes of scrypt(x, s, 32)) and the verifier length comes from the
    // stored verifier, so a truncated verifier is accepted. verifyLoginHash is not used in production.
    expect(current.verifyLoginHash(loginHash, salt, verifier.subarray(0, 16))).toBe(true);
    expect(legacy.verifyLoginHash(loginHash, salt, verifier.subarray(0, 16))).toBe(true);
    // Pinned current behaviour (reported as a latent bug, not fixed in E9): an empty stored verifier verifies any hash.
    expect(current.verifyLoginHash('anything', salt, new Uint8Array(0))).toBe(true);
  });
});

class EmbeddedQueryable {
  readonly statements: string[] = [];

  constructor(private readonly pglite: PGlite) {}

  async query(sql: string, values?: unknown[]) {
    this.statements.push(sql);
    const result = await this.pglite.query(sql, values) as { rows: unknown[]; affectedRows?: number };
    return { rows: result.rows, rowCount: result.rows.length > 0 ? result.rows.length : result.affectedRows ?? 0 };
  }
}

/** One migrated PGlite per file: created once, emptied between runs, always closed. */
class VaultSchema {
  private instance: PGlite | undefined;

  get pglite(): PGlite {
    if (!this.instance) throw new Error('VaultSchema.open() was not awaited');
    return this.instance;
  }

  async open(): Promise<this> {
    this.instance = new PGlite();
    const dir = resolve(process.cwd(), 'services/sulla-vault/migrations');
    for (const file of (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()) {
      await this.instance.exec((await readFile(resolve(dir, file), 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
    }
    return this;
  }

  /** Back to the freshly-migrated state for users (and every row that hangs off a user). */
  async reset(): Promise<void> {
    await this.pglite.exec('TRUNCATE users CASCADE');
    const remaining = await this.pglite.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
    if (remaining.rows[0].n !== 0) throw new Error('VaultSchema.reset left users behind');
  }

  async close(): Promise<void> {
    const instance = this.instance;
    this.instance = undefined;
    await instance?.close();
  }

  async users() {
    const result = await this.pglite.query<{ email: string; login_hash_salt: Uint8Array; login_hash_verifier: Uint8Array; public_key: string; encrypted_private_key: unknown; encrypted_user_key: unknown; kdf: unknown }>(
      'SELECT email, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf FROM users ORDER BY email',
    );
    return result.rows.map((row) => ({ ...row, login_hash_salt: Hex.of(row.login_hash_salt), login_hash_verifier: Hex.of(row.login_hash_verifier) }));
  }
}

type Ensure = (db: Queryable, config: VaultConfig) => Promise<void>;

class BootstrapScenario {
  static readonly complete: Partial<VaultConfig> = {
    desktopLoginHash:           'bG9naW4taGFzaA',
    desktopPublicKey:           'public-key-b64',
    desktopEncryptedPrivateKey: { v: 1, ciphertext: 'private' },
    desktopEncryptedUserKey:    { v: 1, ciphertext: 'user-key' },
    desktopKdf:                 { alg: 'argon2id', iterations: 3, memory: 65536, parallelism: 4 },
  };

  constructor(private readonly schema: VaultSchema, private readonly config: Partial<VaultConfig>, private readonly seedExisting = false) {}

  async run(ensure: Ensure) {
    const schema = this.schema;
    await schema.reset();
    if (this.seedExisting) {
      await schema.pglite.query(
        "INSERT INTO users(email, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf) VALUES ('existing@example.test', '\\x00'::bytea, '\\x00'::bytea, 'pk', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)",
      );
    }
    const client = new EmbeddedQueryable(schema.pglite);
    const config = { databaseUrl: 'postgres://unused', ...this.config } as VaultConfig;
    const first = await ensure(client, config).then(() => null, (error: unknown) => ({ error: (error as Error).constructor.name, message: (error as Error).message }));
    const second = await ensure(client, config).then(() => null, (error: unknown) => ({ error: (error as Error).constructor.name, message: (error as Error).message }));
    const users = await schema.users();
    return { first, second, statements: client.statements, users };
  }

  async compare() {
    const expected = await this.run(legacy.ensureDesktopAccount);
    const actual = await this.run(current.ensureDesktopAccount);
    // The salt is random per run; compare everything else exactly and the verifier by recomputation.
    const strip = (result: typeof actual) => ({ ...result, users: result.users.map(({ login_hash_salt: _s, login_hash_verifier: _v, ...rest }) => rest) });
    expect(strip(actual)).toEqual(strip(expected));
    return actual;
  }
}

describe('E9 auth.ts ensureDesktopAccount matches the pre-refactor implementation', () => {
  const schema = new VaultSchema();
  beforeAll(async() => { await schema.open(); });
  afterAll(async() => { await schema.close(); });

  it('does nothing without a desktop login hash', async() => { // risk: unintended account creation
    const result = await new BootstrapScenario(schema, { ...BootstrapScenario.complete, desktopLoginHash: undefined }).compare();
    expect(result).toEqual({ first: null, second: null, statements: [], users: [] });
  });

  for (const missing of ['desktopPublicKey', 'desktopEncryptedPrivateKey', 'desktopEncryptedUserKey', 'desktopKdf'] as const) {
    it(`throws the same error when ${ missing } is missing, before touching the database`, async() => { // risk: half-bootstrapped account
      const result = await new BootstrapScenario(schema, { ...BootstrapScenario.complete, [missing]: undefined }).compare();
      expect(result.first).toEqual({ error: 'Error', message: 'Desktop bootstrap requires public key, wrapped private key, wrapped user key, and KDF settings' });
      expect(result.statements).toEqual([]);
      expect(result.users).toEqual([]);
    });
  }

  it('treats an empty public key as missing, like legacy', async() => { // risk: half-bootstrapped account
    const result = await new BootstrapScenario(schema, { ...BootstrapScenario.complete, desktopPublicKey: '' }).compare();
    expect(result.first).not.toBeNull();
  });

  it('creates exactly one desktop account with a verifier for the login hash, then is idempotent', async() => { // risk: sign-in
    const result = await new BootstrapScenario(schema, BootstrapScenario.complete).compare();
    expect(result.first).toBeNull();
    expect(result.second).toBeNull();
    expect(result.statements).toEqual([
      'SELECT id FROM users LIMIT 1',
      `INSERT INTO users(email, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      'SELECT id FROM users LIMIT 1',
    ]);
    expect(result.users).toHaveLength(1);
    const [user] = result.users;
    expect(user).toMatchObject({
      email:                 'desktop@local.sulla',
      public_key:            'public-key-b64',
      encrypted_private_key: { v: 1, ciphertext: 'private' },
      encrypted_user_key:    { v: 1, ciphertext: 'user-key' },
      kdf:                   { alg: 'argon2id', iterations: 3, memory: 65536, parallelism: 4 },
    });
    expect(user.login_hash_salt).toHaveLength(32);
    const salt = Hex.bytes(user.login_hash_salt);
    expect(user.login_hash_verifier).toBe(Hex.of(legacy.makeLoginVerifier('bG9naW4taGFzaA', salt).verifier));
    expect(legacy.verifyLoginHash('bG9naW4taGFzaA', salt, Hex.bytes(user.login_hash_verifier))).toBe(true);
  });

  it('never adds a desktop account when any user already exists', async() => { // risk: second owner on the vault
    const result = await new BootstrapScenario(schema, BootstrapScenario.complete, true).compare();
    expect(result.statements).toEqual(['SELECT id FROM users LIMIT 1', 'SELECT id FROM users LIMIT 1']);
    expect(result.users.map((user) => user.email)).toEqual(['existing@example.test']);
  });
});
