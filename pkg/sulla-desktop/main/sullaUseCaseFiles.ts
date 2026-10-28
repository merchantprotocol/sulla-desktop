// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import { Notification } from 'electron';
import yaml from 'yaml';

import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { hashSkillContent, parseSkillMarkdown } from '@pkg/agent/services/SkillDefinitionService';
import { bundleToArtifact, type InstallableKind } from '@pkg/main/marketplace/databaseInstaller';
import { readDatabaseArtifact } from '@pkg/main/marketplace/databaseArtifacts';
import Logging from '@pkg/utils/logging';

import type { StoredFile } from '@pkg/agent/database/models/MarketplaceArtifactModel';

const console = Logging.background;
const ROOT = 'Use Cases';
const TYPES = ['agents', 'skills', 'workflows', 'functions', 'recipes'] as const;
type UseCaseType = typeof TYPES[number];
type FilesRow = { id:string; path:string; published_version_id?:string|null; publishedVersionId?:string|null };
type Request = (endpoint:string, init?:RequestInit) => Promise<Response>;

let activeUseCaseFiles: SullaUseCaseFiles | undefined;
export function registerUseCaseFiles(service:SullaUseCaseFiles | undefined):void { activeUseCaseFiles = service; }
export async function publishUseCasePackage(type:UseCaseType, slug:string, files:Record<string,Buffer|string>):Promise<void> {
  if (!activeUseCaseFiles) throw new Error('Sulla Files use-case service is not running');
  await activeUseCaseFiles.publishPackage(type, slug, files);
}

export function activePublishedVersion(row:FilesRow):string | null {
  return row.published_version_id ?? row.publishedVersionId ?? null;
}

const kindFor = (type:UseCaseType):InstallableKind => type === 'agents' ? 'agent' : type === 'skills' ? 'skill' : type === 'workflows' ? 'routine' : type.slice(0, -1) as InstallableKind;
const typeFor = (kind:InstallableKind):UseCaseType => kind === 'agent' ? 'agents' : kind === 'skill' ? 'skills' : kind === 'routine' ? 'workflows' : `${ kind }s` as UseCaseType;
const text = (file:StoredFile):string => typeof file === 'string' ? file : Buffer.from(file.content, 'base64').toString('utf8');
const bytes = (file:StoredFile):Buffer => typeof file === 'string' ? Buffer.from(file) : Buffer.from(file.content, 'base64');
const stored = (value:Buffer):StoredFile => value.includes(0) || value.toString('utf8').includes('\uFFFD') ? { encoding:'base64', content:value.toString('base64') } : value.toString('utf8');
const json = (value:unknown) => JSON.stringify(value);
const strings = (value:unknown):string[] => Array.isArray(value) ? value.map(String).map(v => v.trim()).filter(Boolean) : [];

/** Files is authoritative; this class only maintains the disposable Postgres runtime index. */
export class SullaUseCaseFiles {
  private timer?:NodeJS.Timeout;
  private running = false;
  private lastSignature = '';
  private retryDelay = 2_000;
  private lastFailure = '';
  private stopped = false;

  constructor(private readonly request:Request) {}

  start():void {
    activeUseCaseFiles = this;
    if (this.timer) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop():void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (activeUseCaseFiles === this) activeUseCaseFiles = undefined;
  }

  private schedule(delay:number):void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.runScheduledScan(), delay);
    this.timer.unref();
  }

  private async runScheduledScan():Promise<void> {
    this.timer = undefined;
    try {
      await this.scan();
      this.retryDelay = 2_000;
      this.lastFailure = '';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastFailure) {
        this.lastFailure = message;
        console.warn('[UseCases] scan failed:', error);
      }
      this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
    } finally {
      this.schedule(this.retryDelay);
    }
  }

  private async areas():Promise<{ id:string; systemArea:string }[]> {
    const response = await this.request('/v1/local/system-areas');
    if (!response.ok) throw new Error(`Files system areas unavailable (${ response.status })`);
    return response.json();
  }

  private async list(collectionId:string):Promise<FilesRow[]> {
    const query = new URLSearchParams({ collectionId, path: ROOT });
    const response = await this.request(`/v1/files?${ query }`);
    if (!response.ok) throw new Error(`Use Cases listing failed (${ response.status })`);
    return response.json();
  }

  private async content(file:FilesRow, versionId:string):Promise<Buffer> {
    const response = await this.request(`/v1/files/${ encodeURIComponent(file.id) }/preview?versionId=${ encodeURIComponent(versionId) }`);
    if (!response.ok) throw new Error(`${ file.path }: published content unavailable (${ response.status })`);
    return Buffer.from(await response.arrayBuffer());
  }

  private packageFiles(artifact:Awaited<ReturnType<typeof readDatabaseArtifact>>):Record<string,StoredFile> {
    const files = { ...artifact.files };
    if (artifact.kind === 'agent') files['agent.json'] = `${ JSON.stringify(artifact.manifest, null, 2) }\n`;
    if (artifact.kind === 'function' && !files['function.yaml']) files['function.yaml'] = yaml.stringify(artifact.manifest);
    if (artifact.kind === 'recipe' && !files['installation.yaml']) files['installation.yaml'] = yaml.stringify(artifact.manifest);
    if (artifact.kind === 'routine' && !files['routine.yaml']) files['routine.yaml'] = yaml.stringify(artifact.manifest);
    return files;
  }

  private async ingestPublished(collectionId:string, path:string, body:Buffer):Promise<void> {
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    const query = new URLSearchParams({ collectionId, path });
    const payload = new ArrayBuffer(body.byteLength); new Uint8Array(payload).set(body);
    const ingested = await this.request(`/v1/local/system-areas/ingest?${ query }`, { method:'PUT', headers:{ 'content-type':'application/octet-stream', 'x-sulla-source-hash':hash }, body:payload });
    if (!ingested.ok) throw new Error(`Could not export ${ path } (${ ingested.status }): ${ await ingested.text() }`);
    const row = await ingested.json() as { id:string; current_version_id:string };
    const published = await this.request(`/v1/files/${ encodeURIComponent(row.id) }/versions/${ encodeURIComponent(row.current_version_id) }/publish`, { method:'POST', body:json({ comment:'Initial Postgres use-case export' }) });
    if (!published.ok) throw new Error(`Could not publish ${ path } (${ published.status }): ${ await published.text() }`);
  }

  /** Publish a human-authored use-case package through Files, never Postgres. */
  async publishPackage(type:UseCaseType, slug:string, files:Record<string,Buffer|string>):Promise<void> {
    const area = (await this.areas()).find(item => !item.systemArea);
    if (!area) throw new Error('Sulla Files home collection is unavailable');
    for (const [name, value] of Object.entries(files)) {
      await this.ingestPublished(area.id, `${ ROOT }/${ type }/${ slug }/${ name }`, typeof value === 'string' ? Buffer.from(value) : value);
    }
  }

  /** Exactly-once migration of the old DB truth. Existing unmatched mirror content is retained under _legacy-import. */
  private async initialExport(collectionId:string, existing:FilesRow[]):Promise<void> {
    const state = await postgresClient.queryOne('SELECT initial_export_completed_at FROM use_case_files_state WHERE singleton=TRUE');
    if (state?.initial_export_completed_at) return;
    const definitions:{ kind:InstallableKind; slug:string }[] = [];
    for (const [kind, table, column, where] of [
      ['agent','agent_definitions','slug',"status <> 'archive'"], ['skill','skill_definitions','slug','deleted_at IS NULL'],
      ['routine','workflows','id',"status <> 'archive'"], ['function','function_definitions','slug','TRUE'], ['recipe','recipe_definitions','slug','TRUE'],
    ] as const) {
      for (const row of await postgresClient.query(`SELECT ${ column } AS slug FROM ${ table } WHERE ${ where } ORDER BY ${ column }`)) definitions.push({ kind, slug:String(row.slug) });
    }
    const live = new Set(definitions.map(item => `${ typeFor(item.kind) }/${ item.slug }`));
    for (const file of existing) {
      const relative = file.path.slice(`${ ROOT }/`.length);
      const [type, slug, ...rest] = relative.split('/');
      if (!(TYPES as readonly string[]).includes(type) || !slug || live.has(`${ type }/${ slug }`)) continue;
      const target = `${ ROOT }/_legacy-import/${ type }/${ slug }/${ rest.join('/') }`;
      const moved = await this.request('/v1/local/system-areas/move', { method:'POST', body:json({ fileId:file.id, targetPath:target }) });
      if (!moved.ok) throw new Error(`Could not retain legacy import ${ file.path } (${ moved.status }): ${ await moved.text() }`);
    }
    for (const item of definitions) {
      const artifact = await readDatabaseArtifact(item.kind, item.slug);
      for (const [name, stored] of Object.entries(this.packageFiles(artifact))) {
        await this.ingestPublished(collectionId, `${ ROOT }/${ typeFor(item.kind) }/${ item.slug }/${ name }`, bytes(stored));
      }
    }
    await postgresClient.query('UPDATE use_case_files_state SET initial_export_completed_at=NOW(),last_error=NULL WHERE singleton=TRUE');
    this.lastSignature = '';
  }

  private async auditError(file:FilesRow|undefined, versionId:string|undefined, message:string):Promise<void> {
    await this.request('/v1/local/system-areas/audit', { method:'POST', body:json({ fileId:file?.id, versionId, action:'use-case-index-error', details:{ message } }) }).catch(() => undefined);
    if (Notification.isSupported()) new Notification({ title:'Use Case wasn\'t activated', body:message.slice(0, 240) }).show();
  }

  private async activate(type:UseCaseType, slug:string, packageRows:FilesRow[]):Promise<void> {
    const published = packageRows.filter(row => activePublishedVersion(row));
    if (!published.length) return;
    const files:Record<string,StoredFile> = {};
    for (const row of published) {
      const version = String(activePublishedVersion(row));
      files[row.path.split('/').slice(3).join('/')] = stored(await this.content(row, version));
    }
    const kind = kindFor(type);
    const artifact = bundleToArtifact(kind, files, slug);
    const anchorName = kind === 'agent' ? 'agent.json' : kind === 'skill' ? 'SKILL.md' : kind === 'routine' ? (files['routine.yaml'] ? 'routine.yaml' : 'workflow.yaml') : kind === 'function' ? 'function.yaml' : (files['installation.yaml'] ? 'installation.yaml' : 'manifest.yaml');
    const anchor = published.find(row => row.path.endsWith(`/${ anchorName }`));
    if (!anchor) throw new Error(`${ type }/${ slug } is missing ${ anchorName }`);
    const versionId = String(activePublishedVersion(anchor));
    const manifest = artifact.manifest as any;
    await postgresClient.transaction(async client => {
      if (kind === 'agent') {
        const metadata = manifest.metadata ?? {}; const spec = manifest.spec ?? {}; const directory = spec.directory ?? {};
        if (manifest.apiVersion !== 'sulla/v3' || !metadata.title || typeof spec.prompt !== 'string' || metadata.slug !== slug) throw new Error(`agents/${ slug } has an invalid sulla/v3 agent.json`);
        await client.query(`INSERT INTO agent_definitions(id,slug,name,description,system_prompt,soul_content,allowed_tools,skill_refs,routine_refs,model_priority,version,status,enabled,config,prompt_content,goals_content,prompt_files,provider,model,source_kind,when_to_call,when_not_to_call,send,returns,cost_tier,can_call,front_door,use_case_file_id,use_case_version_id)
          VALUES('agent-'||gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,'[]','1.0.0','production',TRUE,$9,$4,$10,$11,$12,$13,'local',$14,$15,$16,$17,$18,$19,$20,$21,$22)
          ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,system_prompt=EXCLUDED.system_prompt,soul_content=EXCLUDED.soul_content,allowed_tools=EXCLUDED.allowed_tools,skill_refs=EXCLUDED.skill_refs,routine_refs=EXCLUDED.routine_refs,status='production',enabled=TRUE,config=EXCLUDED.config,prompt_content=EXCLUDED.prompt_content,goals_content=EXCLUDED.goals_content,prompt_files=EXCLUDED.prompt_files,provider=EXCLUDED.provider,model=EXCLUDED.model,when_to_call=EXCLUDED.when_to_call,when_not_to_call=EXCLUDED.when_not_to_call,send=EXCLUDED.send,returns=EXCLUDED.returns,cost_tier=EXCLUDED.cost_tier,can_call=EXCLUDED.can_call,front_door=COALESCE(agent_definitions.front_door,EXCLUDED.front_door),use_case_file_id=EXCLUDED.use_case_file_id,use_case_version_id=EXCLUDED.use_case_version_id,updated_at=NOW()`,
        [slug,metadata.title,metadata.description??'',spec.prompt,spec.soul??'',strings(spec.tools),strings(spec.skills),strings(spec.routines),json(spec.config??{}),spec.goals??'',json(spec.promptFiles??{}),spec.provider??null,spec.model??null,directory.whenToCall??'',directory.whenNotToCall??'',directory.send??'',directory.returns??'',directory.costTier??null,strings(directory.canCall),typeof directory.frontDoor==='boolean'?directory.frontDoor:null,anchor.id,versionId]);
      } else if (kind === 'skill') {
        const raw = text(files['SKILL.md']); const parsed = parseSkillMarkdown(raw, slug, Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'SKILL.md')));
        if (!parsed || parsed.slug !== slug) throw new Error(`skills/${ slug } has an invalid SKILL.md`);
        const c = parsed.content; const hash = hashSkillContent(c);
        await client.query(`INSERT INTO skill_definitions(id,slug,title,description,tags,triggers,body,frontmatter,frontmatter_text,files,version,source_kind,source_hash,content_hash,enabled,deleted_at,use_case_file_id,use_case_version_id)
          VALUES('skill-'||gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'local',$11,$11,TRUE,NULL,$12,$13)
          ON CONFLICT(slug) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,tags=EXCLUDED.tags,triggers=EXCLUDED.triggers,body=EXCLUDED.body,frontmatter=EXCLUDED.frontmatter,frontmatter_text=EXCLUDED.frontmatter_text,files=EXCLUDED.files,version=EXCLUDED.version,content_hash=EXCLUDED.content_hash,enabled=TRUE,deleted_at=NULL,use_case_file_id=EXCLUDED.use_case_file_id,use_case_version_id=EXCLUDED.use_case_version_id,updated_at=NOW()`,
        [slug,c.title,c.description,c.tags,c.triggers,c.body,json(c.frontmatter),c.frontmatter_text,json(c.files),c.version,hash,anchor.id,versionId]);
      } else if (kind === 'routine') {
        if (!Array.isArray(manifest.nodes) || !Array.isArray(manifest.edges)) throw new Error(`workflows/${ slug } must contain nodes and edges arrays`);
        manifest.id = slug;
        await client.query(`INSERT INTO workflows(id,name,description,version,status,definition,enabled,source_kind,use_case_file_id,use_case_version_id) VALUES($1,$2,$3,$4,'production',$5,TRUE,'user',$6,$7)
          ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,version=EXCLUDED.version,status='production',definition=EXCLUDED.definition,enabled=TRUE,use_case_file_id=EXCLUDED.use_case_file_id,use_case_version_id=EXCLUDED.use_case_version_id,updated_at=NOW()`,
        [slug,manifest.name??slug,manifest.description??'',manifest.version??'1.0.0',json(manifest),anchor.id,versionId]);
      } else if (kind === 'function') {
        const spec=manifest.spec??{}; if (!['python','node','shell','agent'].includes(spec.runtime) || !spec.entrypoint) throw new Error(`functions/${ slug } has an invalid function.yaml`);
        if (!files[String(spec.entrypoint).split('::')[0]]) throw new Error(`functions/${ slug } is missing entrypoint ${ spec.entrypoint }`);
        await client.query(`INSERT INTO function_definitions(slug,name,description,manifest,runtime,files,source_kind,version,use_case_file_id,use_case_version_id,enabled) VALUES($1,$2,$3,$4,$5,$6,'user',$7,$8,$9,TRUE)
          ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,manifest=EXCLUDED.manifest,runtime=EXCLUDED.runtime,files=EXCLUDED.files,version=EXCLUDED.version,use_case_file_id=EXCLUDED.use_case_file_id,use_case_version_id=EXCLUDED.use_case_version_id,enabled=TRUE,updated_at=NOW()`,
        [slug,manifest.name??manifest.metadata?.name??slug,manifest.description??manifest.metadata?.description??'',json(manifest),spec.runtime,json(files),manifest.version??'1.0.0',anchor.id,versionId]);
      } else {
        const composeName=String(manifest.compose?.composeFile??manifest.composeFile??'docker-compose.yml'); const compose=files[composeName]??files['docker-compose.yml']??files['compose.yaml'];
        if (!compose) throw new Error(`recipes/${ slug } is missing its compose file`);
        await client.query(`INSERT INTO recipe_definitions(slug,name,description,manifest,compose,files,source_kind,version,use_case_file_id,use_case_version_id,enabled) VALUES($1,$2,$3,$4,$5,$6,'user',$7,$8,$9,TRUE)
          ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,manifest=EXCLUDED.manifest,compose=EXCLUDED.compose,files=EXCLUDED.files,version=EXCLUDED.version,use_case_file_id=EXCLUDED.use_case_file_id,use_case_version_id=EXCLUDED.use_case_version_id,enabled=TRUE,updated_at=NOW()`,
        [slug,manifest.name??slug,manifest.description??'',json(manifest),text(compose),json(files),manifest.version??'1.0.0',anchor.id,versionId]);
      }
    });
  }

  private async disableMissing(active:Set<string>):Promise<void> {
    await postgresClient.query(`UPDATE agent_definitions SET enabled=FALSE,status='archive',updated_at=NOW() WHERE use_case_file_id IS NOT NULL AND NOT (slug=ANY($1::text[]))`, [[...active].filter(k=>k.startsWith('agents/')).map(k=>k.slice(7))]);
    await postgresClient.query(`UPDATE skill_definitions SET enabled=FALSE,deleted_at=COALESCE(deleted_at,NOW()),updated_at=NOW() WHERE use_case_file_id IS NOT NULL AND NOT (slug=ANY($1::text[]))`, [[...active].filter(k=>k.startsWith('skills/')).map(k=>k.slice(7))]);
    await postgresClient.query(`UPDATE workflows SET enabled=FALSE,status='archive',updated_at=NOW() WHERE use_case_file_id IS NOT NULL AND NOT (id=ANY($1::text[]))`, [[...active].filter(k=>k.startsWith('workflows/')).map(k=>k.slice(10))]);
    for (const [table,type] of [['function_definitions','functions'],['recipe_definitions','recipes']] as const) await postgresClient.query(`UPDATE ${ table } SET enabled=FALSE,use_case_version_id=NULL,updated_at=NOW() WHERE use_case_file_id IS NOT NULL AND NOT (slug=ANY($1::text[]))`, [[...active].filter(k=>k.startsWith(`${type}/`)).map(k=>k.slice(type.length+1))]);
  }

  async scan():Promise<void> {
    if (this.running) return; this.running = true;
    try {
      const area = (await this.areas()).find(item => !item.systemArea); if (!area) return;
      let rows = await this.list(area.id); await this.initialExport(area.id, rows); rows = await this.list(area.id);
      const relevant = rows.filter(row => row.path.startsWith(`${ ROOT }/`) && !row.path.startsWith(`${ ROOT }/_legacy-import/`));
      const signature = relevant.map(row => `${ row.id }:${ activePublishedVersion(row) ?? '-' }:${ row.path }`).sort().join('|');
      if (signature === this.lastSignature) return;
      const groups = new Map<string,FilesRow[]>();
      for (const row of relevant) { const [type,slug] = row.path.slice(`${ROOT}/`.length).split('/'); if (!(TYPES as readonly string[]).includes(type) || !slug) continue; const key=`${type}/${slug}`; groups.set(key,[...(groups.get(key)??[]),row]) }
      const active = new Set<string>();
      for (const [key, packageRows] of groups) {
        const [type,slug]=key.split('/') as [UseCaseType,string];
        if (!packageRows.some(row => activePublishedVersion(row))) continue;
        // An invalid newly-published version never disables the last valid index row.
        active.add(key);
        try { await this.activate(type,slug,packageRows); active.add(key) }
        catch(error) { const anchor=packageRows.find(row=>activePublishedVersion(row)); await this.auditError(anchor,anchor ? String(activePublishedVersion(anchor)) : undefined,`${key}: ${error instanceof Error?error.message:String(error)}`) }
      }
      await this.disableMissing(active);
      const { skillsRegistry } = await import('@pkg/agent/database/registry/SkillsRegistry'); await skillsRegistry.invalidate();
      await postgresClient.query('UPDATE use_case_files_state SET last_scan_at=NOW(),last_error=NULL WHERE singleton=TRUE');
      this.lastSignature = signature;
    } catch(error) {
      await postgresClient.query('UPDATE use_case_files_state SET last_error=$1 WHERE singleton=TRUE',[error instanceof Error?error.message:String(error)]).catch(()=>undefined);
      throw error;
    } finally { this.running=false }
  }
}
