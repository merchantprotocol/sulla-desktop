import assert from 'node:assert/strict';
import test from 'node:test';

import { bootstrapFirstOwner, type ServerBootstrapMaterial } from './serverBootstrap.js';

const material: ServerBootstrapMaterial = {
  email:               'owner@example.test',
  displayName:         'Owner',
  loginHash:           'derived-not-plaintext',
  publicKey:           'public',
  encryptedPrivateKey: {},
  encryptedUserKey:    {},
  kdf:                 {},
  encryptedOrgName:    {},
  wrappedOrgKey:       {},
};

test('first-owner bootstrap is atomic and never overwrites an existing account', async() => {
  const queries: string[] = [];
  let hasUser = false;
  const client = {
    query(sql: string) {
      queries.push(sql);
      if (sql.includes('SELECT 1 FROM users')) return Promise.resolve({ rowCount: hasUser ? 1 : 0, rows: hasUser ? [{}] : [] });
      if (sql.includes('INSERT INTO users')) {
        hasUser = true;
        return Promise.resolve({ rowCount: 1, rows: [{ id: 'user-1' }] });
      }
      if (sql.includes('INSERT INTO orgs')) return Promise.resolve({ rowCount: 1, rows: [{ id: 'org-1' }] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    },
    release() {},
  };
  const db = { connect: () => Promise.resolve(client) };
  assert.equal(await bootstrapFirstOwner(db as never, material), 'created');
  const firstWriteCount = queries.filter(query => query.includes('INSERT INTO')).length;
  assert.equal(await bootstrapFirstOwner(db as never, material), 'already_bootstrapped');
  assert.equal(queries.filter(query => query.includes('INSERT INTO')).length, firstWriteCount);
  assert.equal(queries.at(-1), 'COMMIT');
});
