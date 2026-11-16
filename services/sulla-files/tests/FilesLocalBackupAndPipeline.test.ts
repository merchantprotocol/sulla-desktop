// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the last groups moved out of app.ts: LocalBackupRoutes (with
// LocalBackupDestinationRepository), the request pipeline (auth, X-Sulla-Actor, ready gate,
// bootstrap, JSON gate, /healthz) and the error handlers, on the real app and a real Postgres.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { databaseUrl, FilesRoutesFixture } from './FilesAppFixture.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

describe.skipIf(!databaseUrl)('Files local backups, request pipeline and error handlers (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  const vaultId = randomUUID();

  beforeAll(() => fixture.start(), 30_000);
  afterAll(() => fixture.stop());

  const insertDestination = async(enabled = true, kind = 'local'):Promise<string> => {
    const id = randomUUID();
    await fixture.pool.query('INSERT INTO files_backup_destinations(id,kind,label,config,enabled) VALUES($1,$2,$3,$4,$5)', [id, kind, `Disk ${ id }`, { kind, root: '/var/lib/sulla-files-backups/spec' }, enabled]);
    return id;
  };
  /** Holds the per-destination backup lock the scheduler takes for a running backup. */
  const holdBackupLock = async(id:string) => {
    const client = await fixture.pool.connect();
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`files-backup:${ id }`]);
    return async() => { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`files-backup:${ id }`]); client.release() };
  };

  it('lists destinations with only their latest run and the fixed retention', async() => {
    // risk: data accuracy — the status shown per destination must be its newest run, never another destination's.
    const first = await insertDestination(); const second = await insertDestination(false);
    await fixture.pool.query(`INSERT INTO files_backup_runs(id,destination_id,started_at,state,error_message) VALUES
      ($1,$3,NOW()-INTERVAL '2 hours','failed','old'),($2,$3,NOW()-INTERVAL '1 hour','running',NULL)`, [randomUUID(), randomUUID(), first]);
    const listed = await fixture.request('/v1/local/backups');
    expect(listed.status).toBe(200);
    expect(listed.body.retention).toEqual({ hourly: 24, daily: 30, weekly: 12 });
    expect(listed.body.runtimeRequests).toEqual([]);
    const byId = Object.fromEntries(listed.body.destinations.map((item:any) => [item.id, item]));
    expect(byId[first]).toMatchObject({ kind: 'local', enabled: true, status: { destination_id: first, state: 'running', error_message: null } });
    expect(byId[second]).toMatchObject({ enabled: false }); expect(byId[second].status).toBeUndefined();
  });

  it('creates a valid local destination and refuses invalid ones without saving them', async() => {
    // risk: data accuracy — only validated destination configs may be stored; credentials never live in the URL.
    const created = await fixture.request('/v1/local/backups/destinations', 'POST', { body: { kind: 'local', label: '  Nightly  ', config: { kind: 'local', root: '/var/lib/sulla-files-backups/nightly' } } });
    expect(created).toMatchObject({ status: 201, body: { kind: 'local', label: 'Nightly', enabled: true, config: { kind: 'local', root: '/var/lib/sulla-files-backups/nightly' } } });
    const s3 = await fixture.request('/v1/local/backups/destinations', 'POST', { body: { kind: 's3', label: 'Cloud', config: { kind: 's3', endpoint: 'https://s3.example.com', bucket: 'b', vaultCredentialId: vaultId, region: 'us-east-1', prefix: 'p' } } });
    expect(s3).toMatchObject({ status: 201, body: { config: { kind: 's3', endpoint: 'https://s3.example.com', bucket: 'b', vaultCredentialId: vaultId, region: 'us-east-1', prefix: 'p' } } });
    const before = (await fixture.pool.query('SELECT count(*)::int AS n FROM files_backup_destinations')).rows[0].n;
    const refuse = async(body:object, error:string) => expect(await fixture.request('/v1/local/backups/destinations', 'POST', { body })).toMatchObject({ status: 400, body: { error } });
    await refuse({ kind: 'ftp', label: 'x', config: { kind: 'ftp' } }, 'Invalid backup destination');
    await refuse({ kind: 'local', label: '', config: { kind: 'local', root: '/var/lib/sulla-files-backups/a' } }, 'Invalid backup destination');
    await refuse({ kind: 'local', label: 'x', config: { kind: 'local', root: '/etc' } }, 'Local backups require a valid subfolder on the Sulla VM backup disk');
    await refuse({ kind: 'nas', label: 'x', config: { kind: 'nas', protocol: 'smb', share: 'smb://user:pw@nas/share', vaultCredentialId: vaultId } }, 'Enter an smb://server/share or nfs://server/export URL without credentials');
    await refuse({ kind: 'nas', label: 'x', config: { kind: 'nas', protocol: 'smb', share: 'smb://nas/share' } }, 'SMB backups require Vault credentials');
    await refuse({ kind: 's3', label: 'x', config: { kind: 's3', endpoint: 'http://s3.example.com', bucket: 'b', vaultCredentialId: vaultId } }, 'S3 backups require HTTPS, a bucket, and Vault credentials');
    await refuse({ kind: 's3', label: 'x', config: { kind: 's3', endpoint: 'https://s3.example.com', bucket: 'b', vaultCredentialId: 'not-a-uuid' } }, 'Enter a valid Vault item UUID');
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM files_backup_destinations')).rows[0].n).toBe(before);
  });

  it('removes a destination only when no backup holds its lock', async() => {
    // risk: irreversible side effect — removing a destination mid-backup would orphan the running snapshot.
    const id = await insertDestination();
    const release = await holdBackupLock(id);
    try {
      expect(await fixture.request(`/v1/local/backups/destinations/${ id }`, 'DELETE')).toMatchObject({ status: 409, body: { error: 'Wait for the running backup before removing this destination' } });
      expect((await fixture.pool.query('SELECT count(*)::int AS n FROM files_backup_destinations WHERE id=$1', [id])).rows[0].n).toBe(1);
    } finally { await release() }
    expect((await fixture.request(`/v1/local/backups/destinations/${ id }`, 'DELETE')).status).toBe(204);
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM files_backup_destinations WHERE id=$1', [id])).rows[0].n).toBe(0);
    expect(await fixture.request(`/v1/local/backups/destinations/${ id }`, 'DELETE')).toMatchObject({ status: 404, body: { error: 'Backup destination not found' } });
  });

  it('runs only enabled destinations and refuses a second concurrent run', async() => {
    // risk: duplicate backups — one run per destination; disabled destinations never run on demand.
    const disabled = await insertDestination(false);
    expect(await fixture.request(`/v1/local/backups/${ disabled }/run`, 'POST', { body: {} })).toMatchObject({ status: 404, body: { error: 'Backup destination not found' } });
    const busy = await insertDestination();
    const release = await holdBackupLock(busy);
    try {
      expect(await fixture.request(`/v1/local/backups/${ busy }/run`, 'POST', { body: {} })).toMatchObject({ status: 409, body: { error: 'Backup is already running or the service is unavailable' } });
    } finally { await release() }
    expect((await fixture.request(`/v1/local/backups/runtime/${ randomUUID() }`, 'POST', { body: { ok: true } })).status).toBe(404);
  });

  it('keeps every local backup route behind the local service token', async() => {
    // risk: permissions — backup destinations and runs are local-only administration.
    expect((await fixture.request('/v1/local/backups', 'GET', { headers: { 'x-sulla-files-token': 'wrong' } })).status).toBe(401);
    expect((await fixture.request('/v1/local/backups/destinations', 'POST', { body: { kind: 'local' }, headers: { 'x-sulla-files-token': 'wrong' } })).body).toEqual({ error: 'unauthorized local request' });
  });

  it('authenticates every non-health route and labels the failure by route family', async() => {
    // risk: permissions — the auth middleware must run before every handler.
    expect(await fixture.request(`/v1/files?collectionId=${ fixture.collectionId }`, 'GET', { token: null })).toMatchObject({ status: 401, body: { error: 'unauthorized' } });
    expect(await fixture.request(`/v1/files?collectionId=${ fixture.collectionId }`, 'GET', { token: 'forged' })).toMatchObject({ status: 401, body: { error: 'unauthorized' } });
    expect(await fixture.request('/v1/system/audit-events', 'POST', { body: {}, headers: { 'x-sulla-files-token': 'wrong' } })).toMatchObject({ status: 401, body: { error: 'unauthorized service request' } });
    const health = await fixture.request('/healthz', 'GET', { token: null, headers: { 'x-sulla-files-token': 'wrong' } });
    expect(health.status).toBe(200); expect(health.headers['x-powered-by']).toBeUndefined();
  });

  it('accepts X-Sulla-Actor only in the agentId:jobId form on FUSE routes', async() => {
    // risk: permissions — a malformed or non-capability actor header must never attribute writes.
    const path = `/v1/fuse/tree?collectionId=${ fixture.collectionId }`;
    expect(await fixture.request(path, 'GET', { headers: { 'x-sulla-actor': 'no-colon' } })).toMatchObject({ status: 400, body: { error: 'X-Sulla-Actor must be <agentId>:<jobId>' } });
    expect((await fixture.request(path, 'GET', { headers: { 'x-sulla-actor': 'agent-1:job-1' } })).status).not.toBe(400);
  });

  it('answers 503 FILES_LOCKED while locked, except for health', async() => {
    // risk: data exposure — no file route may answer before secure bootstrap unlocks the keyring.
    fixture.config.keyring.unlocked = false;
    try {
      expect(await fixture.request(`/v1/files?collectionId=${ fixture.collectionId }`)).toMatchObject({ status: 503, body: { code: 'FILES_LOCKED' } });
      expect(await fixture.request('/healthz', 'GET', { token: null })).toMatchObject({ status: 200, body: { ok: true, locked: true } });
    } finally { fixture.config.keyring.unlocked = true }
    expect((await fixture.request(`/v1/files?collectionId=${ fixture.collectionId }`)).status).toBe(200);
  });

  it('hides bootstrap when no authority is configured and maps malformed JSON to 400 Invalid request', async() => {
    // risk: availability — bad input must be a clear 400, never a 500 or a leaked parser message.
    expect((await fixture.request('/v1/bootstrap/challenge', 'POST', { token: null, body: {} })).status).toBe(404);
    expect(await fixture.request('/v1/stars', 'PUT', { body: Buffer.from('{bad'), headers: { 'content-type': 'application/json' } })).toMatchObject({ status: 400, body: { error: 'Invalid request' } });
  });
});
