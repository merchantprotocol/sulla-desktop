// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// E9 characterization (pre-refactor): the one-shot legacy credential migration
// (LocalVaultAuthority.migrateLegacy) on the frozen legacy copy and on the current class.
// The legacy source database is a pg.Pool double selected by its connection string; the
// vault database is the real migrated one. Transcripts must be identical.

import { createCipheriv } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async importOriginal => (await import('../../Support/E9Legacy/E9TestDoubles')).E9NodeDeterminism.cryptoModule(await importOriginal<Record<string, unknown>>()));
vi.mock('node:dns', async importOriginal => (await import('../../Support/E9Legacy/E9TestDoubles')).E9FakeUpstream.dnsModule(await importOriginal<Record<string, unknown>>()));
vi.mock('node:https', async importOriginal => (await import('../../Support/E9Legacy/E9TestDoubles')).E9FakeUpstream.httpsModule(await importOriginal<Record<string, unknown>>()));
vi.mock('pg', async importOriginal => {
  const actual = await importOriginal<{ default: { Pool: new (options?: unknown) => unknown } & Record<string, unknown> }>();
  const RealPool = actual.default.Pool;
  const Pool = function E9Pool(options?: { connectionString?: string }) {
    const holder = globalThis as { __e9LegacySource?: { matches(url?: string): boolean; pool(): unknown } };
    if (holder.__e9LegacySource?.matches(options?.connectionString)) return holder.__e9LegacySource.pool();
    return new RealPool(options);
  } as unknown as typeof RealPool;
  return { ...actual, Pool, default: { ...actual.default, Pool } };
});

import { LocalVaultAuthority } from '../../../../../../services/sulla-vault/src/localAuthority';
import { LocalVaultAuthority as LegacyLocalVaultAuthority } from '../../Support/E9Legacy/localAuthority.legacy';
import { E9_TOKENS, E9ScenarioRunner, type E9AuthorityConstructor, type E9Step } from '../../Support/E9Legacy/E9LocalAuthorityEquivalence';

/** Stands in for the legacy Desktop database: canned integration_values/oauth_tokens rows, recorded statements. */
class E9LegacySource {
  static readonly URL = 'postgresql://e9-legacy-source/sulla';
  static readonly VMK = Buffer.alloc(32, 0x44);
  readonly statements: string[] = [];
  failConnect = false;

  constructor(private readonly rows: Array<Record<string, unknown>>) {}

  static sealed(clear: string): string {
    const nonce = Buffer.alloc(12, 9);
    const cipher = createCipheriv('aes-256-gcm', E9LegacySource.VMK, nonce);
    const ciphertext = Buffer.concat([cipher.update(clear, 'utf8'), cipher.final()]);
    return `$VAULT$${ Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64') }`;
  }

  install(): void { (globalThis as { __e9LegacySource?: E9LegacySource }).__e9LegacySource = this }

  matches(url?: string): boolean { return url === E9LegacySource.URL }

  pool(): unknown {
    const source = this;
    return {
      on() { return this },
      async end() { source.statements.push('<end>') },
      async connect() {
        if (source.failConnect) throw new Error('connect ECONNREFUSED');
        return {
          async query(sql: string) {
            source.statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
            return /^\s*SELECT/i.test(sql) ? { rows: source.rows.map(row => ({ ...row })), rowCount: source.rows.length } : { rows: [], rowCount: 0 };
          },
          release() { source.statements.push('<release>') },
        };
      },
    };
  }
}

class E9MigrationScripts {
  static rows(): Array<Record<string, unknown>> {
    const row = (source_kind: string, value_id: number, integration_id: string, account_id: string, property: string, value: string) => ({
      source_kind, value_id, integration_id, account_id, property, value, is_default: account_id === 'default',
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
    });
    return [
      row('integration_value', 1, 'github', 'main', 'token', 'ghp_legacy_plain'),
      row('integration_value', 2, 'openai', 'default', 'api_key', E9LegacySource.sealed('sk-legacy-sealed')),
      row('integration_value', 3, 'openai', 'default', 'base_url', 'https://api.openai.com/v1'),
      row('integration_value', 4, 'openai', 'default', 'llm_access', 'all'),
      row('integration_value', 5, 'custom', 'lab', 'server_url', 'https://lab.example.test/v1?x=1'),
      row('oauth_token', 11, 'grok', 'main', 'access_token', E9LegacySource.sealed('grok-legacy-access')),
    ];
  }

  static steps(source: E9LegacySource): E9Step[] {
    const step = (name: string, run: E9Step['run']): E9Step => ({ name, run });
    return [
      step('unlock with legacy material', c => c.bootstrap.unlock(c.authority, Buffer.alloc(32, 0x11), 'n'.repeat(43), E9LegacySource.VMK)),
      step('status migration required', c => c.authority.status()),
      step('migrate wrong identity', c => c.authority.migrateLegacy('broker', E9_TOKENS.broker)),
      step('migrate', c => c.authority.migrateLegacy('control', E9_TOKENS.control)),
      step('legacy statements', () => [...source.statements]),
      step('migrate again (same source)', c => c.authority.migrateLegacy('control', E9_TOKENS.control)),
      step('status unlocked', c => c.authority.status()),
      step('github metadata', c => c.authority.integrationMetadata('broker', E9_TOKENS.broker, 'github')),
      step('openai metadata', c => c.authority.integrationMetadata('broker', E9_TOKENS.broker, 'openai')),
      step('grok metadata', c => c.authority.integrationMetadata('broker', E9_TOKENS.broker, 'grok')),
      step('custom metadata', c => c.authority.integrationMetadata('broker', E9_TOKENS.broker, 'custom')),
    ];
  }

  static failing(source: E9LegacySource): E9Step[] {
    const step = (name: string, run: E9Step['run']): E9Step => ({ name, run });
    return [
      step('unlock without legacy material', c => c.bootstrap.unlock(c.authority, Buffer.alloc(32, 0x11), 'n'.repeat(43))),
      step('migrate sealed rows without the key', c => c.authority.migrateLegacy('control', E9_TOKENS.control)),
      step('status after failed migration', c => c.authority.status()),
      step('source unreachable', c => { source.failConnect = true; return c.authority.migrateLegacy('control', E9_TOKENS.control) }),
      step('status after unreachable source', c => c.authority.status()),
      step('legacy statements', () => [...source.statements]),
    ];
  }
}

class E9MigrationEquivalence {
  static async assertSame(build: (source: E9LegacySource) => E9Step[]): Promise<void> {
    const runner = new E9ScenarioRunner({ legacyDatabaseUrl: E9LegacySource.URL });
    const legacySource = new E9LegacySource(E9MigrationScripts.rows());
    legacySource.install();
    const before = await runner.run(LegacyLocalVaultAuthority as unknown as E9AuthorityConstructor, build(legacySource));
    const currentSource = new E9LegacySource(E9MigrationScripts.rows());
    currentSource.install();
    const after = await runner.run(LocalVaultAuthority as unknown as E9AuthorityConstructor, build(currentSource));
    expect(after.steps).toEqual(before.steps);
    expect(after.tables).toEqual(before.tables);
    expect(currentSource.statements).toEqual(legacySource.statements);
  }
}

afterEach(() => { vi.restoreAllMocks() });

describe.sequential('E9 legacy credential migration (legacy == current)', () => {
  it('imports legacy integration values and OAuth tokens identically, once', async() => {
    // risk: data accuracy / secret handling — every legacy credential must land in exactly one sealed item, once.
    await E9MigrationEquivalence.assertSame(source => E9MigrationScripts.steps(source));
  }, 120_000);

  it('rolls back and reports failures identically', async() => {
    // risk: data loss — a failed migration must roll back and leave the same state and errors.
    await E9MigrationEquivalence.assertSame(source => E9MigrationScripts.failing(source));
  }, 120_000);
});
