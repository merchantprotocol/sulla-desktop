// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E10 (S4a follow-up): every vault transaction helper (Files key bundles, the browser-envelope sync
// runner and the local authority store) runs through one PgTransactionRunner. When ROLLBACK itself
// fails, the operation's real error still surfaces and the client is released WITH the rollback
// error, so pg destroys a connection that may still hold the open transaction and advisory lock.
// Real helper classes; the pool client is a recording double.
//
// Fail on main (before this change): the three "ROLLBACK fails" cases (the key-bundle helper threw
// the rollback error; the other two released the broken client back to the pool). Guards that pass
// on main: clean rollback returns the client healthy, and a successful unit commits and releases.

import { describe, expect, it } from 'vitest';

import { PostgresSyncTransaction } from '../../../../../../services/sulla-vault/src/browserEnvelope/sync/repositories/PostgresSyncTransaction';
import type { Database } from '../../../../../../services/sulla-vault/src/db';
import { PostgresFilesKeyBundleRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresFilesKeyBundleRepository';
import { PostgresLocalAuthorityRepository } from '../../../../../../services/sulla-vault/src/repositories/PostgresLocalAuthorityRepository';

/** Pool client double: records statements and how it was released; can fail chosen statements. */
class FlakyClient {
  readonly log: string[] = [];
  readonly releasedWith: unknown[][] = [];
  constructor(private readonly failing: Record<string, Error> = {}) {}
  readonly begins: string[] = [];
  async query(sql: string) {
    this.log.push(sql.split(' ')[0]);
    if (sql.startsWith('BEGIN')) this.begins.push(sql);
    const failure = Object.entries(this.failing).find(([statement]) => sql.startsWith(statement));
    if (failure) throw failure[1];
    return { rows: [], rowCount: 0 };
  }
  release(...args: unknown[]): void { this.releasedWith.push(args) }
  asDatabase(): Database { return { connect: async() => this } as unknown as Database }
}

type Work = (client: { query(sql: string): Promise<unknown> }) => Promise<unknown>;

/** Each helper, driven the way its callers drive it, plus the statements it issues around `work`. */
const helpers: { name: string; statements: string[]; run(client: FlakyClient, work: Work): Promise<unknown> }[] = [
  {
    name: 'Files key-bundle collection lock',
    statements: ['BEGIN', 'SELECT'],
    run: (client, work) => new PostgresFilesKeyBundleRepository(client.asDatabase()).withCollectionLock('p', 'c', work),
  },
  {
    name: 'browser-envelope sync transaction',
    statements: ['BEGIN'],
    run: (client, work) => new PostgresSyncTransaction().run(client.asDatabase(), work as never),
  },
  {
    name: 'local authority store transaction',
    statements: ['BEGIN'],
    run: (client, work) => new PostgresLocalAuthorityRepository(client.asDatabase()).transaction(work as never),
  },
  {
    name: 'legacy-source read-only transaction',
    statements: ['BEGIN'],
    run: (client, work) => new PostgresLocalAuthorityRepository({} as Database).readOnlyTransaction(client.asDatabase(), work as never),
  },
];

describe.each(helpers)('$name', ({ statements, run }) => {
  it('when ROLLBACK fails, rethrows the original error and releases the client with the rollback error', async() => { // risk: real error masked; poisoned connection (open txn + advisory lock) handed to the next caller
    const rollbackError = new Error('connection terminated');
    const client = new FlakyClient({ ROLLBACK: rollbackError });

    await expect(run(client, async() => { throw new Error('custody conflict') })).rejects.toThrow('custody conflict');

    expect(client.log).toEqual([...statements, 'ROLLBACK']);
    expect(client.releasedWith).toEqual([[rollbackError]]);
  });

  it('returns a healthy client to the pool after a clean rollback', async() => { // risk: every failed write destroys a pool connection
    const client = new FlakyClient();

    await expect(run(client, async() => { throw new Error('custody conflict') })).rejects.toThrow('custody conflict');

    expect(client.log).toEqual([...statements, 'ROLLBACK']);
    expect(client.releasedWith).toHaveLength(1);
    expect(client.releasedWith[0][0]).toBeUndefined();
  });

  it('commits a successful unit, returns its result and releases the client healthy', async() => { // risk: committed write reported as failed, or connection leaked
    const client = new FlakyClient();

    await expect(run(client, async connection => { await connection.query('UPDATE t'); return 'done' })).resolves.toBe('done');

    expect(client.log).toEqual([...statements, 'UPDATE', 'COMMIT']);
    expect(client.releasedWith).toHaveLength(1);
    expect(client.releasedWith[0][0]).toBeUndefined();
  });
});

describe('legacy-source read-only transaction', () => {
  it('opens with BEGIN READ ONLY so the legacy source can never be written', async() => { // risk: migration writes into the legacy credential database
    const client = new FlakyClient();
    await new PostgresLocalAuthorityRepository({} as Database).readOnlyTransaction(client.asDatabase(), async() => 'rows');
    expect(client.begins).toEqual(['BEGIN READ ONLY']);
  });
});
