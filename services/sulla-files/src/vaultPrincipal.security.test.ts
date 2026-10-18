import assert from 'node:assert/strict';
import test from 'node:test';

import { adoptVaultPrincipal } from './vaultPrincipal.js';

function database(initial:{ id:string; owner_user_id:string }[], foreignBundle = false) {
  let rows = structuredClone(initial); let pending = structuredClone(rows); let mutations = 0;
  const db:any = { connect: () => Promise.resolve({
    release() {},
    query(sql:string, args:any[] = []) {
      if (sql === 'BEGIN') pending = structuredClone(rows);
      else if (sql === 'COMMIT') rows = structuredClone(pending);
      else if (sql === 'ROLLBACK') pending = structuredClone(rows);
      else if (sql.startsWith('SELECT id::text')) return Promise.resolve({ rows: structuredClone(pending) });
      else if (sql.startsWith('SELECT 1 FROM files_collection_key_bundles')) return Promise.resolve({ rowCount: foreignBundle ? 1 : 0, rows: [] });
      else if (sql.startsWith('UPDATE collections SET')) {
        mutations++;
        const ids = args[0] as string[];
        pending = pending.map(row => ids.includes(row.id) ? { ...row, owner_user_id: String(args[1]) } : row);
      } else if (!sql.startsWith('UPDATE file_share_links')) mutations++;
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  }) };
  return { db, rows: () => rows, mutations: () => mutations };
}

test('adopts only sentinel collections and leaves unrelated owners and ACL scope untouched', async() => {
  const state = database([
    { id: 'sentinel', owner_user_id: 'desktop-user' },
    { id: 'historical-scratch', owner_user_id: 'agent-channel' },
  ]);
  const config = { userId: 'desktop-user' };
  await adoptVaultPrincipal(state.db, config, 'synthetic-vault-owner');
  assert.equal(config.userId, 'synthetic-vault-owner');
  assert.deepEqual(state.rows(), [
    { id: 'sentinel', owner_user_id: 'synthetic-vault-owner' },
    { id: 'historical-scratch', owner_user_id: 'agent-channel' },
  ]);

  const mutations = state.mutations();
  await adoptVaultPrincipal(state.db, { userId: 'desktop-user' }, 'synthetic-vault-owner');
  assert.equal(state.mutations(), mutations, 'restart must not rewrite already adopted ownership or ACLs');
});

test('allows an empty database but rejects account switches and foreign sentinel bundles', async() => {
  const empty = database([]); const emptyConfig = { userId: 'desktop-user' };
  await adoptVaultPrincipal(empty.db, emptyConfig, 'synthetic-vault-owner');
  assert.equal(emptyConfig.userId, 'synthetic-vault-owner');

  const foreign = database([{ id: 'foreign', owner_user_id: 'another-user' }]);
  await assert.rejects(adoptVaultPrincipal(foreign.db, { userId: 'desktop-user' }, 'synthetic-vault-owner'), /another principal/);
  assert.equal(foreign.mutations(), 0);

  const bundled = database([{ id: 'sentinel', owner_user_id: 'desktop-user' }], true);
  await assert.rejects(adoptVaultPrincipal(bundled.db, { userId: 'desktop-user' }, 'synthetic-vault-owner'), /another principal/);
  assert.equal(bundled.mutations(), 0);
});
