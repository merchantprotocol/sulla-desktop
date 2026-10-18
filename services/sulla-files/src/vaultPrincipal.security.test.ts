import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptVaultPrincipal } from './vaultPrincipal.js';

test('Vault principal adoption survives restart and rejects foreign or explicitly configured identities', async() => {
  let owner = 'desktop-user';
  let pendingOwner = owner;
  let mutations = 0;
  const db:any = { connect: async() => ({
    release() {},
    async query(sql:string, args:unknown[] = []) {
      if (sql === 'BEGIN') pendingOwner = owner;
      else if (sql === 'COMMIT') owner = pendingOwner;
      else if (sql === 'ROLLBACK') pendingOwner = owner;
      else if (sql.startsWith('SELECT owner_user_id')) return { rows: [{ owner_user_id: owner }] };
      else if (sql.startsWith('SELECT 1 FROM files_collection_key_bundles')) return { rowCount: 0 };
      else {
        mutations++;
        if (sql.startsWith('UPDATE collections SET')) pendingOwner = String(args[1]);
      }
      return { rows: [], rowCount: 0 };
    },
  }) };
  const first = { userId: 'desktop-user' };
  await adoptVaultPrincipal(db, first, 'synthetic-vault-owner');
  assert.equal(first.userId, 'synthetic-vault-owner');
  assert.equal(owner, 'synthetic-vault-owner');
  const firstMutations = mutations;
  const restarted = { userId: 'desktop-user' };
  await adoptVaultPrincipal(db, restarted, 'synthetic-vault-owner');
  assert.equal(restarted.userId, 'synthetic-vault-owner');
  assert.equal(mutations, firstMutations, 'restart must not reassign ACLs or ownership');
  await assert.rejects(adoptVaultPrincipal(db, { userId: 'desktop-user' }, 'different-vault-owner'), /another principal/);
  await assert.rejects(adoptVaultPrincipal(db, { userId: 'explicit-other-owner' }, 'synthetic-vault-owner'), /another principal/);
  assert.equal(owner, 'synthetic-vault-owner');
  assert.equal(mutations, firstMutations);
});
