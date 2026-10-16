import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createApp } from './app.js';
import { issueToken } from './auth.js';
import { connectDatabase, migrate } from './db.js';

import type { VaultConfig } from './config.js';
import type { AddressInfo } from 'node:net';

const databaseUrl = process.env.SULLA_VAULT_TEST_DATABASE_URL;

test('a cursor taken before collection grants receives existing items', { skip: !databaseUrl }, async() => {
  const config: VaultConfig = {
    mode:             'server',
    port:             0,
    databaseUrl:      databaseUrl!,
    jwtSecret:        'sync-test-secret-that-is-at-least-thirty-two-characters',
    extensionOrigins: [],
  };
  const db = await connectDatabase(config);

  await migrate(db);
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const collectionItemId = randomUUID();
  const personalItemId = randomUUID();
  const json = JSON.stringify({ test: true });

  await db.query(
    `INSERT INTO users(id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf)
     VALUES ($1,$2,'x','x','owner-key',$3,$3,$3),($4,$5,'x','x','member-key',$3,$3,$3)`,
    [ownerId, `${ ownerId }@test.invalid`, json, memberId, `${ memberId }@test.invalid`],
  );
  const org = await db.query<{ id: string }>(
    `INSERT INTO orgs(encrypted_name,created_by) VALUES ($1,$2) RETURNING id`, [json, ownerId],
  );
  await db.query(
    `INSERT INTO org_members(org_id,user_id,role,wrapped_org_key,status)
     VALUES ($1,$2,'owner',$4,'confirmed'),($1,$3,'member',$4,'confirmed')`,
    [org.rows[0].id, ownerId, memberId, json],
  );
  const collection = await db.query<{ id: string }>(
    `INSERT INTO collections(org_id,encrypted_name,wrapped_collection_key) VALUES ($1,$2,$2) RETURNING id`,
    [org.rows[0].id, json],
  );
  await db.query(
    `INSERT INTO items(id,collection_id,item_type,ciphertext,encrypted_item_key)
     VALUES ($1,$2,'login',$3,$3)`, [collectionItemId, collection.rows[0].id, json],
  );
  await db.query(
    `INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key)
     VALUES ($1,$2,'login',$3,$3)`, [personalItemId, memberId, json],
  );

  const server = createApp(db, config).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  const request = async<T = undefined>(user: string, path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${ port }${ path }`, {
      ...init,
      headers: { authorization: `Bearer ${ issueToken(config, user) }`, 'content-type': 'application/json' },
    });
    const body = await response.text();

    assert.equal(response.ok, true, `${ response.status } ${ body }`);
    return (response.status === 204 ? undefined : JSON.parse(body)) as T;
  };

  try {
    interface SyncPayload { cursor: number; items: { id: string }[] }
    const before = await request<SyncPayload>(memberId, '/v1/sync?cursor=0');

    assert.deepEqual(before.items.map((item) => item.id), [personalItemId]);
    const cursor = before.cursor;

    await request(ownerId, `/v1/collections/${ collection.rows[0].id }/members/${ memberId }`, {
      method: 'PUT', body: JSON.stringify({ view: true }),
    });
    const after = await request<SyncPayload>(memberId, `/v1/sync?cursor=${ cursor }`);

    assert.deepEqual(after.items.map((item) => item.id), [collectionItemId]);
    assert.ok(after.cursor > cursor);

    const groupCollectionItemId = randomUUID();
    const groupCollection = await db.query<{ id: string }>(
      `INSERT INTO collections(org_id,encrypted_name,wrapped_collection_key) VALUES ($1,$2,$2) RETURNING id`,
      [org.rows[0].id, json],
    );
    await db.query(
      `INSERT INTO items(id,collection_id,item_type,ciphertext,encrypted_item_key)
       VALUES ($1,$2,'login',$3,$3)`, [groupCollectionItemId, groupCollection.rows[0].id, json],
    );
    const group = await db.query<{ id: string }>(
      'INSERT INTO org_groups(org_id,encrypted_name) VALUES ($1,$2) RETURNING id', [org.rows[0].id, json],
    );
    await db.query(
      'INSERT INTO collection_group_members(collection_id,group_id,can_view) VALUES ($1,$2,true)',
      [groupCollection.rows[0].id, group.rows[0].id],
    );
    await request(ownerId, `/v1/groups/${ group.rows[0].id }/members/${ memberId }`, { method: 'PUT' });
    const afterGroup = await request<SyncPayload>(memberId, `/v1/sync?cursor=${ after.cursor }`);

    assert.deepEqual(afterGroup.items.map((item) => item.id), [groupCollectionItemId]);

    await db.query('DELETE FROM org_members WHERE org_id=$1 AND user_id=$2', [org.rows[0].id, memberId]);
    await db.query(
      `INSERT INTO org_members(org_id,user_id,role,wrapped_org_key,status)
       VALUES ($1,$2,'admin',NULL,'pending')`, [org.rows[0].id, memberId],
    );
    await db.query(
      `UPDATE org_members SET status='confirmed',wrapped_org_key=$3
        WHERE org_id=$1 AND user_id=$2`, [org.rows[0].id, memberId, json],
    );
    const afterConfirmation = await request<SyncPayload>(memberId, `/v1/sync?cursor=${ afterGroup.cursor }`);

    assert.deepEqual(new Set(afterConfirmation.items.map((item) => item.id)), new Set([collectionItemId, groupCollectionItemId]));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.query('DELETE FROM orgs WHERE id = $1', [org.rows[0].id]);
    await db.query('DELETE FROM users WHERE id IN ($1,$2)', [ownerId, memberId]);
    await db.end();
  }
});
