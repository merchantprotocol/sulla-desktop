// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import { Notification } from 'electron';
import yaml from 'yaml';

import { BUILTIN_AGENT_RENAMES, newerBuiltinAgentSlug } from '@pkg/shared/agentJobNames';
import { AgentModelCategoryPolicy } from '@pkg/agent/languagemodels/AgentModelCategoryPolicy';
import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { UseCaseRemovalRepository } from '@pkg/agent/database/repositories/UseCaseRemovalRepository';
import { isRetiredCodingManagerSlug, RETIRED_CODING_MANAGER_SLUGS } from '@pkg/agent/builtinAgents/index';
import { hashSkillContent, parseSkillMarkdown } from '@pkg/agent/services/SkillDefinitionService';
import { installMemoryPackForSkill, listPacks, uninstallPack } from '@pkg/agent/memory/MemoryPackLoader';
import { bundleToArtifact, type InstallableKind } from '@pkg/main/marketplace/databaseInstaller';
import { readDatabaseArtifact } from '@pkg/main/marketplace/databaseArtifacts';
import Logging from '@pkg/utils/logging';

import type { StoredFile } from '@pkg/agent/database/models/MarketplaceArtifactModel';
import type { PoolClient } from 'pg';
import type { UseCaseChangePublisher } from '@pkg/agent/useCases/UseCaseChangeBus';
import { FilesListingPager } from '../agent/files/FilesListingPager';
import { agentPackageModels, readAgentPackage } from './marketplace/agentPackageManifest';

const USE_CASE_ROW_LIMIT = 20_000;
const USE_CASE_REQUEST_TIMEOUT_MS = 120_000;

const console = Logging.background;
const ROOT = 'Use Cases';
/** Files tags the owner's home collection, where Use Cases live, as the 'sulla' system area (HomeSystemFileRepository.systemAreas). */
const OWNER_HOME_AREA = 'sulla';
const TYPES = ['agents', 'skills', 'workflows', 'functions', 'recipes'] as const;
type UseCaseType = typeof TYPES[number];
type FilesRow = { id:string; path:string; published_version_id?:string|null; publishedVersionId?:string|null; deleted_at?:string|null };
type PublishedAgentRow = { id:string; source_kind:string; removed_from_editor:boolean; use_case_file_id:string|null; use_case_version_id:string|null };
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
const agentModelSlot = (tier: unknown, legacy: unknown): 'primary'|'secondary'|'subconscious' => {
  if (tier === 'primary' || tier === 'secondary' || tier === 'subconscious') return tier;
  const model = typeof legacy === 'string' ? legacy.toLowerCase() : '';
  if (/(haiku|mini|flash|nano|lite|luna|fast)/.test(model)) return 'subconscious';
  if (/(sonnet|sol|turbo|medium)/.test(model)) return 'secondary';
  return 'primary';
};
const publishedAgentId = (slug:string, fileId:string):string => `agent-${ crypto.createHash('sha256').update(`sulla-use-case-agent\0${ slug }\0${ fileId }`).digest('hex').slice(0, 32) }`;


/** A lost pending registration whose exact mapping removal failed; its durable marker keeps it retryable. */
class MappingCleanupPending extends Error {}

/** Files is authoritative; this class only maintains the disposable Postgres runtime index. */
export class SullaUseCaseFiles {
  private timer?:NodeJS.Timeout;
  private running = false;
  private lastSignature = '';
  private retryDelay = 2_000;
  private lastFailure = '';
  private stopped = false;
  private readonly reportedModelConflicts = new Set<string>();

  constructor(private readonly request:Request, private readonly notifier?:UseCaseChangePublisher) {}

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

  private async requestFiles(endpoint:string, init:RequestInit = {}):Promise<Response> {
    try {
      return await this.request(endpoint, { ...init, signal:init.signal ?? AbortSignal.timeout(USE_CASE_REQUEST_TIMEOUT_MS) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Files request ${ endpoint } failed: ${ message }`, { cause:error });
    }
  }

  private async areas():Promise<{ id:string; systemArea:string }[]> {
    const endpoint = '/v1/local/system-areas';
    const response = await this.requestFiles(endpoint);
    if (!response.ok) throw new Error(`Files request ${ endpoint } failed (${ response.status })`);
    return response.json();
  }

  /**
   * The full Use Cases subtree, read page by page. scan() disables anything it does not
   * see, so a partial list must never be returned: past the cap the scan fails instead.
   * Memory is bounded by the Use Cases folder (USE_CASE_ROW_LIMIT rows), not the collection.
   */
  private async list(collectionId:string):Promise<FilesRow[]> {
    const rows:FilesRow[] = [];
    for await (const page of FilesListingPager.pages<FilesRow>(url => this.requestFiles(url), '/v1/files', { collectionId, path: ROOT })) {
      if (rows.length + page.length > USE_CASE_ROW_LIMIT) throw new Error(`Use Cases folder exceeds ${ USE_CASE_ROW_LIMIT } files; nothing was activated or disabled`);
      rows.push(...page);
    }
    return rows;
  }

  private async content(file:FilesRow, versionId:string):Promise<Buffer> {
    const endpoint = `/v1/files/${ encodeURIComponent(file.id) }/preview?versionId=${ encodeURIComponent(versionId) }`;
    const response = await this.requestFiles(endpoint);
    if (!response.ok) throw new Error(`Files request ${ endpoint } failed (${ response.status }); ${ file.path } published content unavailable`);
    return Buffer.from(await response.arrayBuffer());
  }

  private packageFiles(artifact:Pick<Awaited<ReturnType<typeof readDatabaseArtifact>>, 'kind'|'manifest'|'files'>):Record<string,StoredFile> {
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
    const endpoint = `/v1/local/system-areas/ingest?${ query }`;
    const ingested = await this.requestFiles(endpoint, { method:'PUT', headers:{ 'content-type':'application/octet-stream', 'x-sulla-source-hash':hash }, body:payload });
    if (!ingested.ok) throw new Error(`Files request ${ endpoint } failed (${ ingested.status }): ${ await ingested.text() }`);
    const row = await ingested.json() as { id:string; current_version_id:string };
    const published = await this.requestFiles(`/v1/files/${ encodeURIComponent(row.id) }/versions/${ encodeURIComponent(row.current_version_id) }/publish`, { method:'POST', body:json({ comment:'Initial Postgres use-case export' }) });
    if (!published.ok) throw new Error(`Files request /v1/files/${ encodeURIComponent(row.id) }/versions/${ encodeURIComponent(row.current_version_id) }/publish failed (${ published.status }): ${ await published.text() }`);
  }

  /** Publish a human-authored use-case package through Files, never Postgres. */
  async publishPackage(type:UseCaseType, slug:string, files:Record<string,Buffer|string>):Promise<void> {
    if (type === 'agents') {
      const entries = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, value.toString()]));
      agentPackageModels(readAgentPackage(entries, slug).manifest);
    }
    const area = (await this.areas()).find(item => item.systemArea === OWNER_HOME_AREA);
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
      const moved = await this.requestFiles('/v1/local/system-areas/move', { method:'POST', body:json({ fileId:file.id, targetPath:target }) });
      if (!moved.ok) throw new Error(`Files request /v1/local/system-areas/move failed (${ moved.status }) for ${ file.path }: ${ await moved.text() }`);
    }
    for (const item of definitions) {
      const artifact = item.kind === 'agent'
        ? { kind:'agent' as const, manifest:await (await import('./marketplace/localAgentPackages')).exportLocalAgentPackage(item.slug), files:{} }
        : await readDatabaseArtifact(item.kind, item.slug);
      for (const [name, stored] of Object.entries(this.packageFiles(artifact))) {
        await this.ingestPublished(collectionId, `${ ROOT }/${ typeFor(item.kind) }/${ item.slug }/${ name }`, bytes(stored));
      }
    }
    await postgresClient.query('UPDATE use_case_files_state SET initial_export_completed_at=NOW(),last_error=NULL WHERE singleton=TRUE');
    this.lastSignature = '';
  }

  /**
   * The owner's model choice was kept over this file version. Shown
   * once per file version and app run through the Files audit trail and a notification; rereads of
   * the same indexed version are no-ops, so it does not repeat on every scan.
   */
  private async reportModelConflict(slug:string, anchor:FilesRow, versionId:string, message:string):Promise<void> {
    const key = `${ slug }\0${ anchor.id }\0${ versionId }`;
    if (this.reportedModelConflicts.has(key)) return;
    const detail = `agents/${ slug }: ${ message }`;
    const recorded = await this.requestFiles('/v1/local/system-areas/audit', { method:'POST', body:json({ fileId:anchor.id, versionId, action:'use-case-model-conflict', details:{ message:detail } }) });
    if (!recorded.ok) throw new Error(`Files could not record the model settings conflict (${ recorded.status })`);
    this.reportedModelConflicts.add(key);
    console.warn(`[UseCases] model mapping conflict: ${ detail }`);
    if (Notification.isSupported()) new Notification({ title:'Use Case model settings need review', body:detail.slice(0, 240) }).show();
  }

  private async auditError(file:FilesRow|undefined, versionId:string|undefined, message:string):Promise<void> {
    await this.requestFiles('/v1/local/system-areas/audit', { method:'POST', body:json({ fileId:file?.id, versionId, action:'use-case-index-error', details:{ message } }) }).catch(() => undefined);
    if (Notification.isSupported()) new Notification({ title:'Use Case wasn\'t activated', body:message.slice(0, 240) }).show();
  }

  /**
   * `pending` is the pre-migration phase: register one brand-new agent from its exact, human-approved
   * root anchor. It never updates an existing row; a concurrent registration wins and is preserved.
   */
  private async activate(type:UseCaseType, packageSlug:string, packageRows:FilesRow[], pending?:{ anchor:FilesRow }, renamed?:PublishedAgentRow & { slug:string }):Promise<void> {
    if (kindFor(type) === 'agent' && isRetiredCodingManagerSlug(packageSlug)) throw new Error(`agents/${ packageSlug } is retired and cannot be activated`);
    const published = packageRows.filter(row => activePublishedVersion(row));
    if (!published.length) return;
    const files:Record<string,StoredFile> = {};
    for (const row of published) {
      const version = String(activePublishedVersion(row));
      files[row.path.split('/').slice(3).join('/')] = stored(await this.content(row, version));
    }
    const kind = kindFor(type);
    const artifact = bundleToArtifact(kind, files, packageSlug);
    const anchorName = kind === 'agent' ? readAgentPackage(Object.fromEntries(Object.entries(files).map(([name, file]) => [name, text(file)])), packageSlug).anchor : kind === 'skill' ? 'SKILL.md' : kind === 'routine' ? (files['routine.yaml'] ? 'routine.yaml' : 'workflow.yaml') : kind === 'function' ? 'function.yaml' : (files['installation.yaml'] ? 'installation.yaml' : 'manifest.yaml');
    const anchor = pending ? (pending.anchor.path === `${ ROOT }/${ type }/${ packageSlug }/${ anchorName }` ? pending.anchor : undefined) : published.find(row => row.path === `${ ROOT }/${ type }/${ packageSlug }/${ anchorName }`);
    if (!anchor) throw new Error(`${ type }/${ packageSlug } is missing ${ anchorName }`);
    const slug = renamed?.slug ?? packageSlug;
    const versionId = String(activePublishedVersion(anchor));
    const manifest = artifact.manifest as any;
    let agentId:string | undefined;
    let createdAgentBinding:{ editToken:string; revision:number } | undefined;
    let observedAgent: PublishedAgentRow | null = null;
    if (kind === 'agent') {
      observedAgent = renamed ?? await postgresClient.queryOne<PublishedAgentRow>(
        `SELECT id,source_kind,config @> '{"removedFromEditor":true}'::jsonb AS removed_from_editor,use_case_file_id,use_case_version_id FROM agent_definitions WHERE slug=$1`, [slug]) ?? null;
      if (observedAgent?.removed_from_editor) return;
      if (observedAgent && !['local', 'user'].includes(observedAgent.source_kind)) throw new Error(`agents/${ slug } conflicts with an existing ${ observedAgent.source_kind } agent; the existing definition was preserved`);
      if (observedAgent && pending) throw new Error(`agents/${ slug } already has a definition; it was preserved until the Use Cases migration runs`);
      agentId = observedAgent?.id ?? publishedAgentId(slug, anchor.id);
    }
    const project = async(client:PoolClient) => {
      if (kind === 'agent') {
        const metadata = manifest.metadata ?? {}; const spec = manifest.spec ?? {}; const directory = spec.directory ?? {};
        if (manifest.apiVersion !== 'sulla/v3' || !metadata.title || typeof spec.prompt !== 'string' || metadata.slug !== packageSlug) throw new Error(`agents/${ slug } has an invalid sulla/v3 agent.json`);
        const rename = renamed && BUILTIN_AGENT_RENAMES.find(([old]) => old === packageSlug);
        const title = rename && metadata.title === rename[2] ? rename[3] : metadata.title;
        const profileChoice = spec.modelChoice?.mode === 'class' ? spec.modelChoice : spec.config?.modelChoice;
        const category = profileChoice?.mode === 'class' ? new AgentModelCategoryPolicy().resolve({ choice: profileChoice, slug }) : null;
        const registered = await client.query(`INSERT INTO agent_definitions(id,slug,name,description,system_prompt,soul_content,allowed_tools,skill_refs,routine_refs,model_priority,version,status,enabled,config,prompt_content,goals_content,prompt_files,provider,model,model_slot,source_kind,when_to_call,when_not_to_call,send,returns,cost_tier,can_call,front_door,use_case_file_id,use_case_version_id,agent_awareness,model_choice)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]','1.0.0','production',TRUE,$10,$5,$11,$12,$13,NULL,$14,'local',$15,$16,$17,$18,$19,$20,$21,$22,$23,COALESCE($24,TRUE),$25)
          ${ !observedAgent ? 'ON CONFLICT DO NOTHING' : `ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,system_prompt=EXCLUDED.system_prompt,soul_content=EXCLUDED.soul_content,allowed_tools=EXCLUDED.allowed_tools,skill_refs=EXCLUDED.skill_refs,routine_refs=EXCLUDED.routine_refs,status='production',enabled=TRUE,config=EXCLUDED.config,prompt_content=EXCLUDED.prompt_content,goals_content=EXCLUDED.goals_content,prompt_files=EXCLUDED.prompt_files,provider=EXCLUDED.provider,model=NULL,model_slot=EXCLUDED.model_slot,when_to_call=EXCLUDED.when_to_call,when_not_to_call=EXCLUDED.when_not_to_call,send=EXCLUDED.send,returns=EXCLUDED.returns,cost_tier=EXCLUDED.cost_tier,can_call=EXCLUDED.can_call,front_door=COALESCE(agent_definitions.front_door,EXCLUDED.front_door),use_case_file_id=EXCLUDED.use_case_file_id,use_case_version_id=EXCLUDED.use_case_version_id,agent_awareness=COALESCE($24,agent_definitions.agent_awareness),updated_at=NOW()` }
          ${ !observedAgent ? '' : `WHERE agent_definitions.id=EXCLUDED.id
            AND agent_definitions.source_kind=$26
            AND agent_definitions.use_case_file_id IS NOT DISTINCT FROM $27
            AND agent_definitions.use_case_version_id IS NOT DISTINCT FROM $28
            AND NOT COALESCE(agent_definitions.config @> '{"removedFromEditor":true}'::jsonb,FALSE)` }
          RETURNING id`,
        [agentId,slug,title,metadata.description??'',spec.prompt,spec.soul??'',strings(spec.tools),strings(spec.skills),strings(spec.routines),json(spec.config??{}),spec.goals??'',json(spec.promptFiles??{}),spec.provider??null,agentModelSlot(spec.modelSlot,spec.model),directory.whenToCall??'',directory.whenNotToCall??'',directory.send??'',directory.returns??'',directory.costTier??null,strings(directory.canCall),typeof directory.frontDoor==='boolean'?directory.frontDoor:null,anchor.id,versionId,typeof spec.agentAwareness==='boolean'?spec.agentAwareness:null,category ? json(category) : null,...(observedAgent ? [observedAgent.source_kind,observedAgent.use_case_file_id,observedAgent.use_case_version_id] : [])]);
        if (!registered.rows.length || String(registered.rows[0]?.id ?? '') !== agentId) {
          throw new Error(`agents/${ slug } ${ pending ? 'was registered concurrently' : 'changed during activation' }; the newer definition was preserved`);
        }
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
    };
    let projected = false;
    try {
      if (kind === 'agent' && agentId) {
        const { workerModelRouting } = await import('@pkg/agent/services/WorkerModelRouting');
        const publication = { fileId:anchor.id, versionId };
        if (pending) await workerModelRouting.assertReusablePublicationMapping(slug, agentId, publication);
        // A same-version read cannot undo or warn on a subsequent owner edit.
        if (observedAgent?.use_case_file_id !== anchor.id || observedAgent.use_case_version_id !== versionId) {
          const declared = agentPackageModels(manifest);
          const verifyVersion = async() => {
            const response = await this.requestFiles(`/v1/files/${ encodeURIComponent(anchor.id) }`);
            if (!response.ok) throw new Error(`Files could not confirm the current publication (${ response.status })`);
            const current = await response.json() as FilesRow;
            if (current.deleted_at || current.id !== anchor.id || current.path !== anchor.path || activePublishedVersion(current) !== versionId) {
              throw new Error(`agents/${ slug } has a newer file publication. Its model settings will be checked again.`);
            }
          };
          const result = await workerModelRouting.reconcilePublishedPackageBinding(slug, agentId, declared, publication, {
            pending:!!pending, verifyVersion, ...(pending ? {} : { project }),
          });
          if (result.outcome === 'conflict') {
            await verifyVersion();
            await this.reportModelConflict(slug, anchor, versionId, result.message);
          }
          else if (result.outcome === 'written') {
            if (pending) createdAgentBinding = result.written ?? undefined;
            else projected = true;
          }
        }
      }
      if (!projected) await postgresClient.transaction(project);
    } catch (error) {
      if (createdAgentBinding && agentId) {
        const { workerModelRouting } = await import('@pkg/agent/services/WorkerModelRouting');
        await workerModelRouting.removeBindingForDefinition(slug, agentId, createdAgentBinding).catch((cleanupError) => {
          // The marked mapping stays durable; settlePendingRegistrations retries it after a restart.
          throw new MappingCleanupPending(`${ error instanceof Error ? error.message : String(error) }; its new model mapping could not be removed yet and will be retried: ${ cleanupError instanceof Error ? cleanupError.message : String(cleanupError) }`);
        });
      }
      throw error;
    }
    if (pending && createdAgentBinding && agentId) {
      const { workerModelRouting } = await import('@pkg/agent/services/WorkerModelRouting');
      // Best effort: a marker left behind is settled by the next scan from the committed row.
      await workerModelRouting.clearPendingPublication(slug, agentId, createdAgentBinding).catch(() => undefined);
    }
    if (kind !== 'integration') this.notifier?.announce({ type: kind === 'routine' ? 'workflow' : kind, slug, change: 'published' });
    if (kind === 'skill') {
      const raw = text(files['SKILL.md']);
      const parsed = parseSkillMarkdown(raw, slug, Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'SKILL.md')));
      await installMemoryPackForSkill(slug, parsed?.content.frontmatter, files);
    }
  }

  private async disableMissing(active:Set<string>):Promise<void> {
    // Read before the disable so the index hears which rows left; a failed read only loses the hint (reconcile repairs it).
    const removed = await new UseCaseRemovalRepository(postgresClient).listRemoved(active);
    await postgresClient.query(`UPDATE agent_definitions SET enabled=FALSE,status='archive',updated_at=NOW() WHERE slug=ANY($1::text[]) OR (use_case_file_id IS NOT NULL AND NOT (slug=ANY($2::text[])))`, [RETIRED_CODING_MANAGER_SLUGS, [...active].filter(k=>k.startsWith('agents/')).map(k=>k.slice(7))]);
    await postgresClient.query(`UPDATE skill_definitions SET enabled=FALSE,deleted_at=COALESCE(deleted_at,NOW()),updated_at=NOW() WHERE use_case_file_id IS NOT NULL AND NOT (slug=ANY($1::text[]))`, [[...active].filter(k=>k.startsWith('skills/')).map(k=>k.slice(7))]);
    await postgresClient.query(`UPDATE workflows SET enabled=FALSE,status='archive',updated_at=NOW() WHERE use_case_file_id IS NOT NULL AND NOT (id=ANY($1::text[]))`, [[...active].filter(k=>k.startsWith('workflows/')).map(k=>k.slice(10))]);
    for (const [table,type] of [['function_definitions','functions'],['recipe_definitions','recipes']] as const) await postgresClient.query(`UPDATE ${ table } SET enabled=FALSE,use_case_version_id=NULL,updated_at=NOW() WHERE use_case_file_id IS NOT NULL AND NOT (slug=ANY($1::text[]))`, [[...active].filter(k=>k.startsWith(`${type}/`)).map(k=>k.slice(type.length+1))]);
    for (const row of removed) this.notifier?.announce({ type: row.type as 'agent'|'skill'|'workflow'|'function'|'recipe', slug: row.slug, change: 'deleted' });
  }

  /** The exact root manifest of an agent package, by readAgentPackage precedence; never a nested same-name file. */
  private static rootAgentAnchor(slug:string, packageRows:FilesRow[]):FilesRow | undefined {
    const root = (name:string) => packageRows.find(row => row.path === `${ ROOT }/agents/${ slug }/${ name }` && activePublishedVersion(row));
    return root('agent.json') ?? root('agent.yaml') ?? root('agent.yml');
  }

  private async renamedPublication(slug:string, anchor?:FilesRow) {
    const canonical = newerBuiltinAgentSlug(slug);
    // Never redirect a custom package just because its folder matches a historical name.
    return canonical && anchor ? postgresClient.queryOne<PublishedAgentRow & {slug:string}>(
      `SELECT id,slug,source_kind,config @> '{"removedFromEditor":true}'::jsonb AS removed_from_editor,use_case_file_id,use_case_version_id
         FROM agent_definitions WHERE slug=$1 AND is_builtin AND use_case_file_id=$2`, [canonical, anchor.id]) : null;
  }

  /** True only when Files holds a human-approved publish request for exactly this file version. */
  private async approvedPublication(anchor:FilesRow):Promise<boolean> {
    const query = new URLSearchParams({ status:'approved', fileId:anchor.id });
    const response = await this.request(`/v1/files/publish-requests?${ query }`);
    if (!response.ok) throw new Error(`Files publication approvals unavailable (${ response.status })`);
    const body = await response.json() as { requests?:unknown };
    if (!Array.isArray(body?.requests)) throw new Error('Files returned invalid publication approvals');
    const versionId = activePublishedVersion(anchor);
    return body.requests.some((item:any) => item?.status === 'approved' && item.file_id === anchor.id && item.version_id === versionId && item.path === anchor.path);
  }

  /**
   * Before the one-time migration has run, Files cannot yet be authoritative for the whole catalog:
   * register only brand-new agents whose exact root anchor version a human approved. Nothing is
   * exported, moved, published, disabled or reconciled, no other package type or memory pack is
   * touched, and the migration timestamp stays unset. Everything else waits for the migration.
   */
  /**
   * Settle every durably marked pending-registration mapping against its definition row. The row
   * with the marked id, file and version committed: drop only the marker. Another definition holds
   * the slug: remove only that exact marked mapping. The same id with other provenance: keep both
   * and report it until the owner edits the mapping (which drops the marker). No row yet: leave it
   * for the registration to finish; absence never authorizes a deletion. Owner-edited mappings
   * carry no marker and are never touched. A failed settlement fails the scan and is retried.
   * Returns the slugs left unresolved.
   */
  private async settlePendingRegistrations():Promise<string[]> {
    const { workerModelRouting } = await import('@pkg/agent/services/WorkerModelRouting');
    const unresolved:string[] = [];
    for (const entry of await workerModelRouting.pendingPublicationBindings()) {
      const row = await postgresClient.queryOne<{id:string;use_case_file_id:string|null;use_case_version_id:string|null}>('SELECT id,use_case_file_id,use_case_version_id FROM agent_definitions WHERE slug=$1', [entry.slug]);
      if (!row) continue;
      const created = { editToken:entry.editToken, revision:entry.revision };
      if (row.id !== entry.agentId) await workerModelRouting.removeBindingForDefinition(entry.slug, entry.agentId, created);
      else if (row.use_case_file_id === entry.fileId && row.use_case_version_id === entry.versionId) await workerModelRouting.clearPendingPublication(entry.slug, entry.agentId, created);
      else unresolved.push(`agents/${ entry.slug }`);
    }
    return unresolved;
  }

  private async scanPendingMigration(collectionId:string, unresolvedMappings:string[] = []):Promise<void> {
    const rows = (await this.list(collectionId)).filter(row => row.path.startsWith(`${ ROOT }/agents/`));
    const signature = `pending|${ rows.map(row => `${ row.id }:${ activePublishedVersion(row) ?? '-' }:${ row.path }`).sort().join('|') }`;
    if (signature === this.lastSignature && !unresolvedMappings.length) return;
    const groups = new Map<string,FilesRow[]>();
    for (const row of rows) { const slug = row.path.split('/')[2]; if (slug) groups.set(slug, [...(groups.get(slug) ?? []), row]) }
    // Every read that decides eligibility happens before the first write.
    const eligible:{ slug:string; packageRows:FilesRow[]; anchor:FilesRow }[] = [];
    // Awaiting a human approval or a free slug: re-evaluated on every scan, never cached away.
    const deferred:string[] = [];
    for (const [slug, packageRows] of groups) {
      if (!packageRows.some(row => activePublishedVersion(row))) continue;
      if (isRetiredCodingManagerSlug(slug)) continue;
      const anchor = SullaUseCaseFiles.rootAgentAnchor(slug, packageRows);
      const existing = await this.renamedPublication(slug, anchor) ?? await postgresClient.queryOne<{ use_case_file_id: string | null; use_case_version_id: string | null; removed_from_editor: boolean }>(
        `SELECT use_case_file_id,use_case_version_id,config @> '{"removedFromEditor":true}'::jsonb AS removed_from_editor FROM agent_definitions WHERE slug=$1`, [slug]);
      if (existing?.removed_from_editor) continue;
      // The same indexed anchor version is a permanent no-op: owner edits to it are never undone.
      if (anchor && existing && existing.use_case_file_id === anchor.id && existing.use_case_version_id === activePublishedVersion(anchor)) continue;
      if (!anchor || existing || !await this.approvedPublication(anchor)) { deferred.push(`agents/${ slug }`); continue }
      eligible.push({ slug, packageRows, anchor });
    }
    const failedPackages:string[] = [];
    const cleanupPending:string[] = [];
    for (const { slug, packageRows, anchor } of eligible) {
      try { await this.activate('agents', slug, packageRows, { anchor }) }
      catch(error) { failedPackages.push(`agents/${ slug }`); if (error instanceof MappingCleanupPending) cleanupPending.push(`agents/${ slug }`); await this.auditError(anchor, String(activePublishedVersion(anchor)), `agents/${ slug }: ${ error instanceof Error ? error.message : String(error) }`) }
    }
    if (unresolvedMappings.length) throw new Error(`An unsettled model mapping from a different publication needs the owner's decision in AI Models for: ${ unresolvedMappings.join(', ') }`);
    if (cleanupPending.length) throw new Error(`A new model mapping could not be removed yet and will be retried for: ${ cleanupPending.join(', ') }`);
    if (failedPackages.length) throw new Error(`Use Case activation will retry for: ${ failedPackages.join(', ') }`);
    if (deferred.length) console.info(`[UseCases] waiting for the Use Cases migration: ${ deferred.join(', ') }`);
    await postgresClient.query('UPDATE use_case_files_state SET last_error=NULL WHERE singleton=TRUE');
    // Cache only a settled listing: a deferred package can become eligible without any Files change.
    this.lastSignature = deferred.length ? '' : signature;
  }

  async scan():Promise<void> {
    if (this.running) return; this.running = true;
    try {
      const area = (await this.areas()).find(item => item.systemArea === OWNER_HOME_AREA); if (!area) throw new Error('Files reported no owner home area for Use Cases');
      const state = await postgresClient.queryOne('SELECT initial_export_completed_at FROM use_case_files_state WHERE singleton=TRUE');
      if (!state?.initial_export_completed_at) return await this.scanPendingMigration(area.id, await this.settlePendingRegistrations());
      let rows = await this.list(area.id); await this.initialExport(area.id, rows); rows = await this.list(area.id);
      const relevant = rows.filter(row => row.path.startsWith(`${ ROOT }/`) && !row.path.startsWith(`${ ROOT }/_legacy-import/`));
      const signature = `completed|${ relevant.map(row => `${ row.id }:${ activePublishedVersion(row) ?? '-' }:${ row.path }`).sort().join('|') }`;
      if (signature === this.lastSignature) return;
      const groups = new Map<string,FilesRow[]>();
      for (const row of relevant) { const [type,slug] = row.path.slice(`${ROOT}/`.length).split('/'); if (!(TYPES as readonly string[]).includes(type) || !slug) continue; const key=`${type}/${slug}`; groups.set(key,[...(groups.get(key)??[]),row]) }
      const active = new Set<string>();
      let activated = 0;
      const failedPackages:string[] = [];
      for (const [key, packageRows] of groups) {
        const [type,slug]=key.split('/') as [UseCaseType,string];
        if (!packageRows.some(row => activePublishedVersion(row))) continue;
        if (type === 'agents' && isRetiredCodingManagerSlug(slug)) continue;
        // An invalid newly-published version never disables the last valid index row.
        const renamed = type === 'agents' ? await this.renamedPublication(slug, SullaUseCaseFiles.rootAgentAnchor(slug, packageRows)) : null;
        active.add(renamed ? `agents/${ renamed.slug }` : key);
        if (type === 'skills') {
          const existing = await postgresClient.queryOne<{enabled:boolean;deleted_at:string|null;use_case_file_id:string|null}>('SELECT enabled,deleted_at,use_case_file_id FROM skill_definitions WHERE slug=$1',[slug]);
          if (existing?.use_case_file_id && (!existing.enabled || existing.deleted_at)) continue;
        }
        try { await this.activate(type,slug,packageRows,undefined,renamed ?? undefined); activated++ }
        catch(error) { failedPackages.push(key); const anchor=type === 'agents' ? SullaUseCaseFiles.rootAgentAnchor(slug, packageRows) : packageRows.find(row=>activePublishedVersion(row)); await this.auditError(anchor,anchor ? String(activePublishedVersion(anchor)) : undefined,`${key}: ${error instanceof Error?error.message:String(error)}`) }
      }
      await this.disableMissing(active);
      const enabledPackSkills = await postgresClient.query<{slug:string}>(`SELECT slug FROM skill_definitions WHERE enabled=TRUE AND deleted_at IS NULL AND use_case_version_id IS NOT NULL AND frontmatter->>'memory_pack'='true'`);
      const activePackSlugs = new Set(enabledPackSkills.map(row => row.slug));
      for (const pack of await listPacks()) if (!activePackSlugs.has(String(pack.slug))) await uninstallPack(String(pack.slug));
      const { skillsRegistry } = await import('@pkg/agent/database/registry/SkillsRegistry'); await skillsRegistry.invalidate();
      if (failedPackages.length) throw new Error(`Use Case activation will retry for: ${ failedPackages.join(', ') }`);
      await postgresClient.query('UPDATE use_case_files_state SET last_scan_at=NOW(),last_error=NULL WHERE singleton=TRUE');
      this.lastSignature = signature;
      console.info(`[UseCases] scan ok: ${ activated } activated`);
    } catch(error) {
      await postgresClient.query('UPDATE use_case_files_state SET last_error=$1 WHERE singleton=TRUE',[error instanceof Error?error.message:String(error)]).catch(()=>undefined);
      throw error;
    } finally { this.running=false }
  }
}
