// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import pg from 'pg';

import { resolveCollectionAccess } from './acl.js';
import type { FilesIdentity } from './auth.js';

const databaseUrl = process.env.SULLA_FILES_ORG_TEST_DATABASE_URL;

test('organization files are isolated from other organizations and personal collections', {
  skip: databaseUrl ? false : 'SULLA_FILES_ORG_TEST_DATABASE_URL is required',
}, async() => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const schema = `files_org_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const client = await pool.connect();
  const query = (sql:string, params?:unknown[]) => client.query(sql, params);
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await query(`CREATE TABLE collections (
      id UUID PRIMARY KEY,
      org_id TEXT,
      owner_user_id TEXT NOT NULL,
      published BOOLEAN NOT NULL DEFAULT TRUE,
      legacy_source BOOLEAN NOT NULL DEFAULT FALSE,
      is_default BOOLEAN NOT NULL DEFAULT FALSE
    )`);
    const personalId = '00000000-0000-4000-8000-000000000001';
    const orgAId = '00000000-0000-4000-8000-000000000002';
    const orgBId = '00000000-0000-4000-8000-000000000003';
    await query(`INSERT INTO collections(id,org_id,owner_user_id,is_default) VALUES
      ($1,'org-a','desktop-owner',TRUE),
      ($2,'org-a','org:org-a',FALSE),
      ($3,'org-b','org:org-b',FALSE)`, [personalId, orgAId, orgBId]);
    const migration = await readFile(new URL('../migrations/050_organization_workspace.sql', import.meta.url), 'utf8');
    await query(migration);
    await query("UPDATE collections SET workspace_scope='organization',is_default=TRUE WHERE id=ANY($1::uuid[])", [[orgAId, orgBId]]);
    await query('CREATE TABLE files(id UUID PRIMARY KEY,collection_id UUID NOT NULL REFERENCES collections(id),path TEXT NOT NULL)');
    await query("INSERT INTO files VALUES('10000000-0000-4000-8000-000000000001',$1,'shared.md')", [orgAId]);

    const member = (userId:string, orgId:string):FilesIdentity => ({
      userId,
      deviceId: '',
      kind: 'server-session',
      orgId,
      orgRoles: ['member'],
    });
    for (const userId of ['member-one', 'member-two']) {
      const access = await resolveCollectionAccess(client, member(userId, 'org-a'), orgAId);
      assert.equal(access.role, 'view');
      const rows = await query('SELECT path FROM files WHERE collection_id=$1', [access.collection.id]);
      assert.deepEqual(rows.rows.map(row => row.path), ['shared.md']);
    }
    await assert.rejects(resolveCollectionAccess(client, member('other-member', 'org-b'), orgAId), /organization access denied/);
    await assert.rejects(resolveCollectionAccess(client, member('member-one', 'org-a'), personalId), /personal collections/);
    const personal = await query('SELECT is_default,workspace_scope FROM collections WHERE id=$1', [personalId]);
    assert.deepEqual(personal.rows[0], { is_default: true, workspace_scope: 'principal' });
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
});
