// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

class UseCasePublicationFixture {
  private readonly schema = `use_case_gate_${ randomUUID().replaceAll('-', '') }`;
  private readonly admin: Pool;
  private pool?: Pool;

  constructor(private readonly url: string) { this.admin = new Pool({ connectionString: url }) }

  async initialize(): Promise<void> {
    await this.admin.query(`CREATE SCHEMA "${ this.schema }"`);
    this.pool = new Pool({ connectionString: this.url, options: `-csearch_path=${ this.schema },public` });
    await this.pool.query(`
      CREATE TABLE collections(id UUID PRIMARY KEY,system_area TEXT);
      CREATE TABLE files(id UUID PRIMARY KEY,collection_id UUID NOT NULL REFERENCES collections(id),path TEXT NOT NULL,
        require_approval BOOLEAN NOT NULL DEFAULT FALSE,require_checkout BOOLEAN NOT NULL DEFAULT FALSE,
        checked_out_by_user_id TEXT,checked_out_by_device_id TEXT,record_lock_type TEXT NOT NULL DEFAULT 'none',
        retention_mode TEXT NOT NULL DEFAULT 'none',retain_until TIMESTAMPTZ,retention_event_at TIMESTAMPTZ,
        retention_duration_days INTEGER,disposal_extended_until TIMESTAMPTZ,major_minor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        current_version_id UUID,draft_version_id UUID,published_version_id UUID,lifecycle_generation BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE file_versions(id UUID PRIMARY KEY,file_id UUID NOT NULL REFERENCES files(id),deleted BOOLEAN NOT NULL DEFAULT FALSE,
        created_by_type TEXT NOT NULL,created_by_id TEXT NOT NULL,device_id TEXT,major_version INTEGER,minor_version INTEGER,
        version_kind TEXT,publication_status TEXT,published_at TIMESTAMPTZ,published_by TEXT,version_comment TEXT);
      CREATE TABLE files_publish_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),file_id UUID NOT NULL REFERENCES files(id),
        version_id UUID NOT NULL REFERENCES file_versions(id),requested_by TEXT NOT NULL,reason TEXT,status TEXT NOT NULL DEFAULT 'pending',
        decided_by TEXT,decided_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE UNIQUE INDEX files_publish_requests_pending ON files_publish_requests(file_id,version_id) WHERE status='pending';
      CREATE FUNCTION files_retention_active(files) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS 'SELECT FALSE';
      CREATE FUNCTION files_advance_version_lifecycle() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.publication_status='published' THEN UPDATE files SET published_version_id=NEW.id,draft_version_id=NULL WHERE id=NEW.file_id;
        ELSE UPDATE files SET draft_version_id=NEW.id WHERE id=NEW.file_id; END IF; RETURN NEW; END $$;
      CREATE TRIGGER file_versions_advance_lifecycle AFTER INSERT ON file_versions FOR EACH ROW EXECUTE FUNCTION files_advance_version_lifecycle();
    `);
    const migration = await readFile(resolve(process.cwd(), 'services/sulla-files/migrations/059_agent_identity_versions_are_drafts.sql'), 'utf8');
    await this.pool.query(migration);
    await this.pool.query('CREATE TRIGGER file_versions_prepare_lifecycle BEFORE INSERT ON file_versions FOR EACH ROW EXECUTE FUNCTION files_prepare_version_lifecycle()');
  }

  async createVersion(path: string, creatorType = 'agent'): Promise<{ versionStatus:string; draftVersionId:string|null; publishedVersionId:string|null }> {
    if (!this.pool) throw new Error('fixture not initialized');
    const collectionId = randomUUID(), fileId = randomUUID(), versionId = randomUUID();
    await this.pool.query('INSERT INTO collections(id,system_area) VALUES($1,NULL)', [collectionId]);
    await this.pool.query('INSERT INTO files(id,collection_id,path) VALUES($1,$2,$3)', [fileId, collectionId, path]);
    await this.pool.query('INSERT INTO file_versions(id,file_id,created_by_type,created_by_id,device_id) VALUES($1,$2,$3,$4,$5)',
      [versionId, fileId, creatorType, creatorType === 'agent' ? 'chat-agent' : 'background-agent', 'job-1']);
    const file = (await this.pool.query('SELECT draft_version_id,published_version_id FROM files WHERE id=$1', [fileId])).rows[0];
    const versionStatus = (await this.pool.query('SELECT publication_status FROM file_versions WHERE id=$1', [versionId])).rows[0].publication_status;
    return { versionStatus, draftVersionId:file.draft_version_id, publishedVersionId:file.published_version_id };
  }

  async exercise(): Promise<{ versionStatus:string; draftVersionId:string|null; publishedVersionId:string|null; requests:number; publishedCount:number }> {
    if (!this.pool) throw new Error('fixture not initialized');
    const collectionId = randomUUID(), fileId = randomUUID(), versionId = randomUUID();
    await this.pool.query('INSERT INTO collections(id,system_area) VALUES($1,NULL)', [collectionId]);
    await this.pool.query("INSERT INTO files(id,collection_id,path) VALUES($1,$2,'Use Cases/skills/gate-test-skill/SKILL.md')", [fileId, collectionId]);
    await this.pool.query("INSERT INTO file_versions(id,file_id,created_by_type,created_by_id,device_id) VALUES($1,$2,'agent','chat-agent','job-1')", [versionId, fileId]);
    const before = (await this.pool.query('SELECT draft_version_id,published_version_id FROM files WHERE id=$1', [fileId])).rows[0];
    const versionStatus = (await this.pool.query('SELECT publication_status FROM file_versions WHERE id=$1', [versionId])).rows[0].publication_status;
    const requestSql = `INSERT INTO files_publish_requests(file_id,version_id,requested_by) VALUES($1,$2,'job-1')
      ON CONFLICT(file_id,version_id) WHERE status='pending' DO UPDATE SET reason=files_publish_requests.reason RETURNING id`;
    const requestId = (await this.pool.query(requestSql, [fileId, versionId])).rows[0].id;
    await this.pool.query(requestSql, [fileId, versionId]);
    const requests = Number((await this.pool.query("SELECT COUNT(*)::int count FROM files_publish_requests WHERE file_id=$1 AND version_id=$2 AND status='pending'", [fileId, versionId])).rows[0].count);
    await this.pool.query("UPDATE file_versions SET publication_status='published',published_at=NOW(),published_by='human' WHERE id=$1", [versionId]);
    await this.pool.query('UPDATE files SET published_version_id=$2,draft_version_id=NULL WHERE id=$1', [fileId, versionId]);
    await this.pool.query("UPDATE files_publish_requests SET status='approved',decided_by='human',decided_at=NOW() WHERE id=$1", [requestId]);
    const publishedCount = Number((await this.pool.query("SELECT COUNT(*)::int count FROM file_versions WHERE file_id=$1 AND publication_status='published'", [fileId])).rows[0].count);
    return { versionStatus, draftVersionId: before.draft_version_id, publishedVersionId: before.published_version_id, requests, publishedCount };
  }

  async dispose(): Promise<void> { await this.pool?.end(); await this.admin.query(`DROP SCHEMA IF EXISTS "${ this.schema }" CASCADE`); await this.admin.end() }
}

const databaseUrl = process.env.SULLA_TEST_DATABASE_URL ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('Use Case publication gate', () => {
  const fixture = new UseCasePublicationFixture(databaseUrl);
  beforeAll(() => fixture.initialize());
  afterAll(() => fixture.dispose());

  it('keeps an agent-created home-collection Use Case draft through one approval', async() => {
    // risk: permissions — agent-created Use Cases must never become runtime-visible without human approval.
    const result = await fixture.exercise();
    expect(result).toMatchObject({ versionStatus:'draft', publishedVersionId:null, requests:1, publishedCount:1 });
    expect(result.draftVersionId).toBeTruthy();
  });

  it.each(['Projects/p/TASKS.md', 'Documents/x.md'])('publishes an agent-created home-collection file at %s', async(path) => {
    // risk: data availability — ordinary chat-agent writes must remain immediately visible to the human.
    const result = await fixture.createVersion(path);
    expect(result).toMatchObject({ versionStatus:'published', draftVersionId:null });
    expect(result.publishedVersionId).toBeTruthy();
  });

  it('keeps agent-run writes outside Use Cases draft', async() => {
    // risk: permissions — background-agent publication behavior from migration 041 must not regress.
    const result = await fixture.createVersion('Documents/background-report.md', 'agent-run');
    expect(result).toMatchObject({ versionStatus:'draft', publishedVersionId:null });
    expect(result.draftVersionId).toBeTruthy();
  });
});
