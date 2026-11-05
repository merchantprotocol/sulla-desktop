// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Pool } from 'pg';

import { issueCapabilityToken } from '../../../../../services/sulla-files/src/auth.js';
import { migrate } from '../../../../../services/sulla-files/src/db.js';
import { LocalFilesManager } from '../../../../../services/sulla-files/src/localManager.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));
vi.mock('@sulla/vault-crypto', () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
        current_version_id UUID,draft_version_id UUID,published_version_id UUID,lifecycle_generation BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE file_versions(id UUID PRIMARY KEY,file_id UUID NOT NULL REFERENCES files(id),deleted BOOLEAN NOT NULL DEFAULT FALSE,
        created_by_type TEXT NOT NULL,created_by_id TEXT NOT NULL,device_id TEXT,major_version INTEGER,minor_version INTEGER,
        version_kind TEXT,publication_status TEXT,published_at TIMESTAMPTZ,published_by TEXT,version_comment TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
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
    const migration = await readFile(resolve(process.cwd(), 'services/sulla-files/migrations/060_repair_agent_mount_publication.sql'), 'utf8');
    await this.pool.query(migration);
    await this.pool.query('CREATE TRIGGER file_versions_prepare_lifecycle BEFORE INSERT ON file_versions FOR EACH ROW EXECUTE FUNCTION files_prepare_version_lifecycle()');
  }

  async createVersion(path: string, creatorType = 'agent', systemArea:string|null = null): Promise<{ versionStatus:string; draftVersionId:string|null; publishedVersionId:string|null }> {
    if (!this.pool) throw new Error('fixture not initialized');
    const collectionId = randomUUID(), fileId = randomUUID(), versionId = randomUUID();
    await this.pool.query('INSERT INTO collections(id,system_area) VALUES($1,$2)', [collectionId, systemArea]);
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

  async exerciseRepair():Promise<{ malformedStatus:string; draftVersionId:string|null; publishedVersionId:string|null; approvedStatus:string; approvedPublishedBy:string|null }> {
    if (!this.pool) throw new Error('fixture not initialized');
    const collectionId=randomUUID(), fileId=randomUUID(), approvedId=randomUUID(), malformedId=randomUUID();
    await this.pool.query('INSERT INTO collections(id,system_area) VALUES($1,NULL)',[collectionId]);
    await this.pool.query("INSERT INTO files(id,collection_id,path) VALUES($1,$2,'Use Cases/functions/repair/function.yaml')",[fileId,collectionId]);
    await this.pool.query("INSERT INTO file_versions(id,file_id,created_by_type,created_by_id,publication_status,published_at,published_by) VALUES($1,$2,'user','jonathon','published',NOW()-INTERVAL '1 hour','jonathon')",[approvedId,fileId]);
    await this.pool.query("UPDATE file_versions SET publication_status='superseded' WHERE id=$1",[approvedId]);
    await this.pool.query("INSERT INTO file_versions(id,file_id,created_by_type,created_by_id,publication_status) VALUES($1,$2,'agent','worker','published')",[malformedId,fileId]);
    await this.pool.query('UPDATE files SET current_version_id=$2,published_version_id=$2,draft_version_id=NULL WHERE id=$1',[fileId,malformedId]);
    const migration=await readFile(resolve(process.cwd(),'services/sulla-files/migrations/060_repair_agent_mount_publication.sql'),'utf8');
    await this.pool.query(migration);
    await this.pool.query(migration); // idempotency guard
    const file=(await this.pool.query('SELECT draft_version_id,published_version_id FROM files WHERE id=$1',[fileId])).rows[0];
    const malformed=(await this.pool.query('SELECT publication_status FROM file_versions WHERE id=$1',[malformedId])).rows[0];
    const approved=(await this.pool.query('SELECT publication_status,published_by FROM file_versions WHERE id=$1',[approvedId])).rows[0];
    return {malformedStatus:malformed.publication_status,draftVersionId:file.draft_version_id,publishedVersionId:file.published_version_id,approvedStatus:approved.publication_status,approvedPublishedBy:approved.published_by};
  }

  async explainRepairPredicate():Promise<string> {
    if (!this.pool) throw new Error('fixture not initialized');
    const collectionId=randomUUID(), fileId=randomUUID();
    await this.pool.query('INSERT INTO collections(id,system_area) VALUES($1,NULL)',[collectionId]);
    await this.pool.query("INSERT INTO files(id,collection_id,path) VALUES($1,$2,'Documents/cardinality.md')",[fileId,collectionId]);
    // Two thousand ordinary rows exceed the planner's small-table threshold while staying inside the PR test budget.
    await this.pool.query(`INSERT INTO file_versions(id,file_id,created_by_type,created_by_id,publication_status,published_at,published_by)
      SELECT gen_random_uuid(),$1,'user','load','published',NOW(),'load' FROM generate_series(1,2000)`,[fileId]);
    await this.pool.query('ANALYZE file_versions');
    const plan=await this.pool.query(`EXPLAIN (COSTS OFF) SELECT v.id FROM file_versions v
      JOIN files f ON f.id=v.file_id JOIN collections c ON c.id=f.collection_id
      WHERE v.created_by_type IN ('agent','agent-run') AND v.publication_status='published'
        AND v.published_at IS NULL AND v.published_by IS NULL AND files_is_use_case_path(c.system_area,f.path)`);
    return plan.rows.map(row=>row['QUERY PLAN']).join('\n');
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

  it('publishes a human-authored Use Case immediately', async() => {
    // risk: data availability — repairing the agent gate must not change Jonathon's own edit lifecycle.
    const result=await fixture.createVersion('Use Cases/functions/human/function.yaml','user');
    expect(result).toMatchObject({versionStatus:'published',draftVersionId:null});
    expect(result.publishedVersionId).toBeTruthy();
  });

  it('uses the partial index for the repair predicate at representative cardinality',async()=>{
    // risk: availability — rollout must not sequentially scan a large version history.
    expect(await fixture.explainRepairPredicate()).toContain('file_versions_malformed_agent_publication_idx');
  });

  it('repairs only malformed agent publications and restores the last approved pointer idempotently',async()=>{
    // risk: data integrity — a repair must preserve genuine approvals and their activation pointer.
    const result=await fixture.exerciseRepair();
    expect(result).toMatchObject({malformedStatus:'draft',approvedStatus:'superseded',approvedPublishedBy:'jonathon'});
    expect(result.draftVersionId).toBeTruthy();
    expect(result.publishedVersionId).toBeTruthy();
    expect(result.draftVersionId).not.toBe(result.publishedVersionId);
  });

  it.each(['Projects/p/TASKS.md', 'Brain/facts/x.md', 'Memory/x.md', 'Documents/x.md'])('publishes an agent-created home-collection file at %s', async(path) => {
    // risk: data availability — ordinary chat-agent writes must remain immediately visible to the human.
    const result = await fixture.createVersion(path);
    expect(result).toMatchObject({ versionStatus:'published', draftVersionId:null });
    expect(result.publishedVersionId).toBeTruthy();
  });

  it.each(['Projects/p/TASKS.md', 'Brain/facts/x.md', 'Memory/x.md', 'Documents/background-report.md'])(
    'publishes an agent-run file outside Use Cases at %s', async(path) => {
      // risk: data availability — background writers outside Use Cases retain immediate publication.
      const result = await fixture.createVersion(path, 'agent-run');
      expect(result).toMatchObject({ versionStatus:'published', draftVersionId:null });
      expect(result.publishedVersionId).toBeTruthy();
    },
  );

  it('publishes an agent Use Cases-looking path in the logs collection', async() => {
    // risk: data availability — logs are excluded by the canonical Use Cases path policy.
    if (!fixture) throw new Error('fixture unavailable');
    const result = await fixture.createVersion('Use Cases/log.txt', 'agent', 'logs');
    expect(result).toMatchObject({ versionStatus:'published', draftVersionId:null });
  });
});


class ProductionFilesFixture {
  private readonly schema = `use_case_paths_${ randomUUID().replaceAll('-', '') }`;
  private readonly signingKey = Buffer.alloc(32, 7);
  private readonly userId = 'publication-test-user';
  private readonly admin:Pool;
  private pool?:Pool;
  private server?:Server;
  private baseUrl='';
  private root='';
  private manager?:LocalFilesManager;
  private collectionId='';

  constructor(private readonly url:string) { this.admin=new Pool({connectionString:url}) }

  async initialize():Promise<void> {
    await this.admin.query(`CREATE SCHEMA "${this.schema}"`);
    this.pool=new Pool({connectionString:this.url,options:`-csearch_path=${this.schema},public`});
    await migrate(this.pool);
    this.root=await mkdtemp(join(tmpdir(),'sulla-use-case-paths-'));
    const filesRoot=join(this.root,'files'); const chunkRoot=join(this.root,'chunks');
    await mkdir(filesRoot,{recursive:true}); await mkdir(chunkRoot,{recursive:true});
    const keyring={unlocked:true,keys:async()=>({data:Buffer.alloc(32,1),dedup:Buffer.alloc(32,2)})};
    const config:any={port:0,databaseUrl:this.url,chunkRoot,dataRoot:this.root,filesRoot,caseInsensitiveRoot:false,
      capabilitySigningKey:this.signingKey,mode:'desktop',deviceId:'local-device',userId:this.userId,cloudUrl:'',paused:true,modelDir:this.root,
      fuseExperiment:true,keyring,fileRoots:[{id:'default',name:'Files',path:filesRoot,syncMode:'local',paused:true,exclusions:[],primary:true}]};
    this.collectionId=randomUUID();
    await this.pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source)
      VALUES($1,$2,'Files','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE)`,[this.collectionId,this.userId]);
    await this.pool.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user',$2,'manage')",[this.collectionId,this.userId]);
    this.manager=new LocalFilesManager(this.pool,config);
    (this.manager as any).rootCollections.set('default',this.collectionId);
    const appModulePath='../../../../../services/sulla-files/src/app.js';
    const {createApp}=await import(appModulePath);
    const app=createApp(this.pool,config,this.manager);
    this.server=createServer(app); await new Promise<void>(resolve=>this.server!.listen(0,'127.0.0.1',resolve));
    const address=this.server.address(); if (!address || typeof address==='string') throw new Error('test server did not bind');
    this.baseUrl=`http://127.0.0.1:${address.port}`;
  }

  private token(agent:boolean):string { return issueCapabilityToken({sub:this.userId,device_id:'test-device',scopes:['files/*'],...(agent?{agent_id:'test-agent',job_id:'test-job'}:{})},this.signingKey) }
  private async request(path:string,init:RequestInit,agent:boolean):Promise<any> {
    const url=new URL(path,this.baseUrl); const payload=typeof init.body==='string'||Buffer.isBuffer(init.body)?init.body:undefined;
    const result=await new Promise<{status:number;body:string}>((resolve,reject)=>{const headers:Record<string,string>={authorization:`Bearer ${this.token(agent)}`,...(agent?{'x-sulla-actor':'test-agent:test-job'}:{}),...Object.fromEntries(new Headers(init.headers).entries())};const request=httpRequest(url,{method:init.method,headers},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.on('end',()=>resolve({status:response.statusCode??500,body:Buffer.concat(chunks).toString('utf8')}));});request.on('error',reject);if(payload!==undefined)request.write(payload);request.end();});
    const body=result.body?JSON.parse(result.body):{}; if(result.status<200||result.status>=300)throw new Error(`${result.status} ${JSON.stringify(body)}`); return body;
  }

  async bufferedDraft():Promise<any> {
    const created=await this.request(`/v1/fuse/files?collectionId=${this.collectionId}&path=${encodeURIComponent('Use Cases/skills/real-path/SKILL.md')}`,
      {method:'POST',headers:{'content-type':'text/markdown'},body:'# real path'},true);
    return (await this.pool!.query(`SELECT f.*,v.publication_status FROM files f JOIN file_versions v ON v.id=f.current_version_id WHERE f.id=$1`,[created.id])).rows[0];
  }

  async streamingDraft(file:any):Promise<any> {
    const bytes=Buffer.from('# streamed path');
    await this.request(`/v1/fuse/files/${file.id}/content/stream`,{method:'PUT',headers:{'content-type':'application/octet-stream','content-length':String(bytes.length),
      'if-match':`"${file.current_version_id}"`,'x-sulla-source-hash':createHash('sha256').update('# real path').digest('hex')},body:bytes},true);
    return (await this.pool!.query(`SELECT f.*,v.publication_status FROM files f JOIN file_versions v ON v.id=f.current_version_id WHERE f.id=$1`,[file.id])).rows[0];
  }

  async approve(file:any):Promise<any> {
    const requested=await this.request(`/v1/files/${file.id}/versions/${file.current_version_id}/publish-request`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:'functional gate test'})},true);
    await this.request(`/v1/files/publish-requests/${requested.id}/approve`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'},false);
    return (await this.pool!.query(`SELECT f.published_version_id,v.publication_status,v.published_at,v.published_by FROM files f JOIN file_versions v ON v.id=f.published_version_id WHERE f.id=$1`,[file.id])).rows[0];
  }

  async replicationCases():Promise<any> {
    const logsId=randomUUID();
    await this.pool!.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,system_area,explorer_path)
      VALUES($1,$2,'Logs','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE,'logs','Logs')`,[logsId,this.userId]);
    (this.manager as any).rootCollections.set('default',logsId);
    const replicate=async(input:{id:string;path:string;status:string;publishedAt:string|null;publishedBy:string|null;collection?:any})=>{
      const fileId=randomUUID(); const target=join(this.root,'files',input.path); await mkdir(resolve(target,'..'),{recursive:true}); await writeFile(target,'');
      const entry:any={op:'put',syncAuthority:{canMaterialize:true},manifest:{hash:createHash('sha256').update(JSON.stringify({ids:[],size:0})).digest('hex'),chunk_ids:[],total_size:0},
        file:{id:fileId,collection_id:logsId,path:input.path,created_by_type:'agent-run',created_by_id:'remote',mime:'text/plain',size:0,lifecycle_generation:0},
        version:{id:input.id,file_id:fileId,chunk_collection_id:logsId,parent_version_id:null,manifest_hash:null,size:0,deleted:false,created_by_type:'agent-run',created_by_id:'remote',created_at:new Date().toISOString(),message:'remote',device_id:'older-peer',publication_status:input.status,published_at:input.publishedAt,published_by:input.publishedBy},
        ...(input.collection===undefined?{}:{collection:input.collection})};
      entry.manifest.hash=createHash('sha256').update(JSON.stringify({ids:entry.manifest.chunk_ids,size:0})).digest('hex'); entry.version.manifest_hash=entry.manifest.hash;
      await (this.manager as any).pull(entry); await (this.manager as any).pull(entry);
      return (await this.pool!.query('SELECT f.draft_version_id,f.published_version_id,v.publication_status,v.published_at,v.published_by FROM files f JOIN file_versions v ON v.id=$1 WHERE f.id=$2',[input.id,fileId])).rows[0];
    };
    const oldPeer=await replicate({id:randomUUID(),path:'Use Cases/log.txt',status:'published',publishedAt:null,publishedBy:null});
    const malformed=await replicate({id:randomUUID(),path:'Use Cases/functions/x/function.yaml',status:'published',publishedAt:null,publishedBy:null,collection:{system_area:null}});
    const approved=await replicate({id:randomUUID(),path:'Use Cases/functions/y/function.yaml',status:'published',publishedAt:new Date().toISOString(),publishedBy:'human-reviewer',collection:{system_area:null}});
    return {oldPeer,malformed,approved};
  }

  async dispose():Promise<void> { if(this.server) await new Promise<void>((resolve,reject)=>this.server!.close(error=>error?reject(error):resolve())); await this.manager?.close(); await this.pool?.end(); await this.admin.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`); await this.admin.end(); if(this.root) await rm(this.root,{recursive:true,force:true}) }
}

describeWithDatabase('Use Case publication production paths',()=>{
  const fixture=new ProductionFilesFixture(databaseUrl); beforeAll(()=>fixture.initialize(),120_000); afterAll(()=>fixture.dispose(),30_000);
  let buffered:any; let streamed:any;
  it('buffers an agent mount write as a draft through the FUSE route',async()=>{
    // risk: permissions — removing app.ts PublicationLifecyclePolicy must make this production request publish incorrectly.
    buffered=await fixture.bufferedDraft(); expect(buffered.publication_status).toBe('draft'); expect(buffered.draft_version_id).toBe(buffered.current_version_id); expect(buffered.published_version_id).toBeNull();
  });
  it('streams an agent mount write as a draft through insertStreamingUpload',async()=>{
    // risk: permissions — removing streamingUpload.ts PublicationLifecyclePolicy must make this production request publish incorrectly.
    streamed=await fixture.streamingDraft(buffered); expect(streamed.publication_status).toBe('draft'); expect(streamed.draft_version_id).toBe(streamed.current_version_id); expect(streamed.published_version_id).toBeNull();
  });
  it('requests and approves publication through the real lifecycle routes',async()=>{
    // risk: authorization — only the human approval path may activate an agent draft.
    const approved=await fixture.approve(streamed); expect(approved).toMatchObject({publication_status:'published',published_by:'publication-test-user'}); expect(approved.published_at).toBeTruthy(); expect(approved.published_version_id).toBe(streamed.current_version_id);
  });
  it('sanitizes replication with local old-peer policy and is idempotent',async()=>{
    // risk: replication integrity — local logs policy must survive absent peer metadata while canonical malformed publications remain gated.
    const result=await fixture.replicationCases();
    expect(result.oldPeer).toMatchObject({publication_status:'published'}); expect(result.oldPeer.published_version_id).toBeTruthy();
    expect(result.malformed).toMatchObject({publication_status:'draft',published_version_id:null}); expect(result.malformed.draft_version_id).toBeTruthy();
    expect(result.approved).toMatchObject({publication_status:'published',published_by:'human-reviewer'}); expect(result.approved.published_at).toBeTruthy();
  });
});
