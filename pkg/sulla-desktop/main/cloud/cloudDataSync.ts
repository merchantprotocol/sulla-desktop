// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Opt-in device projections for Cloud-readable data and sealed memory. */
import crypto from 'node:crypto';
import { getDesktopDeviceId } from '../deviceIdentity';
import { getCurrentUserId } from '../sullaCloudAuth';
import { cloudRequest, isCloudSignedIn } from './cloudFetch';
import { getCloudPreferences, isCloudKindEnabled, type CloudDataKind } from './cloudSettings';
import { signDeviceMessage } from './deviceKey';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import Logging from '@pkg/utils/logging';
const console=Logging.background;
export type ProjectionKind='skills'|'customAgents'|'recipes'|'usage'|'memory'|'modelCatalog';
export interface ProjectionStatus{kind:ProjectionKind;lastSyncAt?:string;lastError?:string;skipped?:string;count?:number}
const PATH:Record<ProjectionKind,string>={skills:'skills',customAgents:'custom-agents',recipes:'recipes',usage:'usage',memory:'memory',modelCatalog:'model-catalog'};
const INTERVAL_MS=5*60_000, MAX_CONTENT=200*1024;
const MODEL_CATALOG_TTL_MS=60*60_000;
let modelCatalogCache:{expiresAt:number;value:any}|null=null;
class CloudDataSyncImpl{
 private timer:ReturnType<typeof setInterval>|null=null; private inFlight=new Map<ProjectionKind,Promise<ProjectionStatus>>();
 private status={} as Record<ProjectionKind,ProjectionStatus>;
 constructor(){for(const k of Object.keys(PATH) as ProjectionKind[])this.status[k]={kind:k}}
 start(){if(this.timer)return;this.timer=setInterval(()=>void this.syncEnabled(),INTERVAL_MS);this.timer.unref?.();void this.syncEnabled()}
 stop(){if(this.timer)clearInterval(this.timer);this.timer=null}
 getStatus(){return Object.values(this.status)}
 async syncEnabled(force=false){const p=await getCloudPreferences().catch(()=>null);if(!p?.enabled)return;for(const k of Object.keys(PATH) as ProjectionKind[])if(k==='modelCatalog'?p.enabled:isCloudKindEnabled(p,k as CloudDataKind))await this.syncNow(k,force)}
 syncNow(kind:ProjectionKind,force=true){const old=this.inFlight.get(kind);if(old)return old;const run=this.run(kind,force).finally(()=>this.inFlight.delete(kind));this.inFlight.set(kind,run);return run}
 async deleteCloudCopy(kind:CloudDataKind){if(!await isCloudSignedIn())return false;const deviceId=await getDesktopDeviceId();const apiKind=kind==='liveAgents'?'agents':kind==='useCases'?'use-cases':PATH[kind as ProjectionKind]??kind;const r=await cloudRequest('DELETE',`/cloud-runtime/v1/device/${apiKind}?deviceId=${encodeURIComponent(deviceId)}`);return r.ok}
 async deleteAll(){if(!await isCloudSignedIn())return false;const deviceId=await getDesktopDeviceId();return (await cloudRequest('DELETE',`/cloud-runtime/v1/device?deviceId=${encodeURIComponent(deviceId)}`)).ok}
 private set(k:ProjectionKind,v:Omit<ProjectionStatus,'kind'>){return this.status[k]={kind:k,...v}}
 private async run(kind:ProjectionKind,force:boolean):Promise<ProjectionStatus>{try{
  const prefs=await getCloudPreferences();if(kind==='modelCatalog'?!prefs.enabled:!isCloudKindEnabled(prefs,kind as CloudDataKind))return this.set(kind,{skipped:'disabled'});
  const userId=await getCurrentUserId().catch(()=>'');if(!await isCloudSignedIn()||!userId)return this.set(kind,{skipped:'signed-out'});
  const deviceId=await getDesktopDeviceId();const built=await buildProjection(kind,deviceId);if(!built)return this.set(kind,{skipped:'needs-vault'});
  const body=JSON.stringify(built);const hash=crypto.createHash('sha256').update(body).digest('hex');const key=`cloudSync${kind}LastHash`;const last=String(await SullaSettingsModel.get(key,'')??'');
  if(!force&&hash===last)return this.set(kind,{...this.status[kind],skipped:'unchanged'});
  const proof=signDeviceMessage('sync-upload',[userId,deviceId,PATH[kind],hash]);const r=await cloudRequest('PUT',`/cloud-runtime/v1/device/${PATH[kind]}`,{headers:{'Content-Type':'application/json','X-Sulla-Timestamp':String(proof.ts),'X-Sulla-Device-Signature':proof.signature},body});
  if(!r.ok)throw new Error(`upload failed (${r.status})`);await SullaSettingsModel.set(key,hash,'string');return this.set(kind,{lastSyncAt:new Date().toISOString(),count:countProjection(kind,built)});
 }catch(e){const message=e instanceof Error?e.message:String(e);console.warn(`[CloudDataSync] ${kind}: ${message}`);return this.set(kind,{lastSyncAt:this.status[kind].lastSyncAt,lastError:message})}}
}
// The Cloud API rejects a whole upload on a bad date or a missing skills list,
// so normalise both instead of trusting each row.
function iso(v:unknown,fallback:string){const d=new Date(v as any);return v!=null&&!Number.isNaN(d.getTime())?d.toISOString():fallback}
function countProjection(kind:ProjectionKind,b:any){if(kind==='customAgents')return b.agents.length;if(kind==='modelCatalog')return b.providers.reduce((n:number,p:any)=>n+p.models.length,0);if(kind==='memory')return b.count;if(kind==='usage')return b.providers.length;return b[kind].length}
function capUtf8(value:string){if(Buffer.byteLength(value,'utf8')<=MAX_CONTENT)return value;let end=Math.min(value.length,MAX_CONTENT);while(end>0&&Buffer.byteLength(value.slice(0,end),'utf8')>MAX_CONTENT)end-=1024;return value.slice(0,Math.max(0,end))}
async function buildProjection(kind:ProjectionKind,deviceId:string):Promise<any|null>{const generatedAt=new Date().toISOString();
 if(kind==='skills'){const {SkillDefinitionModel}=await import('@pkg/agent/database/models/SkillDefinitionModel');const skills=(await SkillDefinitionModel.list({includeDisabled:true})).map(s=>({slug:s.slug,name:s.title,description:s.description,category:typeof s.frontmatter.category==='string'?s.frontmatter.category:'',content:capUtf8(s.body),promptLength:s.body.length,source:s.source_kind,draft:!s.enabled,updatedAt:iso(s.updated_at,generatedAt)}));return{deviceId,generatedAt,skills}}
 if(kind==='modelCatalog'){
  if(modelCatalogCache&&modelCatalogCache.expiresAt>Date.now())return{deviceId,generatedAt,providers:modelCatalogCache.value};
  const {getModelProviderService}=await import('@pkg/agent/services/ModelProviderService');const svc=getModelProviderService();const connected=(await svc.getAvailableProviders()).filter(p=>p.connected);const providers=await Promise.all(connected.map(async p=>({id:p.id,name:p.name,models:(await svc.getModelsForProvider(p.id)).map(m=>({id:m.id,name:m.name}))})));
  modelCatalogCache={expiresAt:Date.now()+MODEL_CATALOG_TTL_MS,value:providers};return{deviceId,generatedAt,providers}}
 if(kind==='customAgents'){const {agentDefinitionService}=await import('@pkg/agent/services/AgentDefinitionService');const agents=(await agentDefinitionService.list()).filter(a=>a.status!=='archive').map(a=>({slug:a.slug,name:a.name,description:a.description,provider:a.provider,model:a.model,prompt:capUtf8(a.prompt_content),skills:Array.isArray(a.skill_refs)?a.skill_refs:[],source:a.source_kind,updatedAt:iso(a.updated_at,generatedAt)}));return{deviceId,generatedAt,agents}}
 if(kind==='recipes'){const {RecipeDefinitionModel}=await import('@pkg/agent/database/models/MarketplaceArtifactModel');const {getRecipeDockerStatus}=await import('../sullaRecipeDockerEvents');const rows=await RecipeDefinitionModel.list();const recipes=await Promise.all(rows.map(async r=>{const st=await getRecipeDockerStatus(r.slug);return{slug:r.slug,name:r.name,description:r.description,version:r.version??'1.0.0',running:st.running,containers:st.containers.map(({service,state,status,ports})=>({service,state,status,ports})),webPorts:st.webPorts??[],updatedAt:iso(r.updated_at,generatedAt)}}));return{deviceId,generatedAt,recipes}}
 if(kind==='usage'){const {getUsageSummary}=await import('@pkg/agent/usage/providerUsage');const {profileId:_profileId,generatedAt:_generatedAt,...summary}=await getUsageSummary(24*30);return{deviceId,generatedAt,...summary}}
 const {getVaultKeyService}=await import('@pkg/agent/services/VaultKeyService');const vault=getVaultKeyService();if(!vault.isSetUp()||!vault.isUnlocked())return null;const {postgresClient}=await import('@pkg/agent/database/PostgresClient');const [observations,identity]=await Promise.all([postgresClient.query('SELECT * FROM observations ORDER BY created_at'),postgresClient.query('SELECT * FROM identity_observations ORDER BY created_at')]);const plaintext=JSON.stringify({observations,identity});const {getVaultBackupService}=await import('@pkg/agent/services/VaultBackupService');let snapshot;try{snapshot=JSON.parse(await getVaultBackupService().buildExport())}catch(error){if(error instanceof Error&&error.message.startsWith('VAULT_UI_REQUIRED:'))return null;throw error}return{deviceId,generatedAt,count:observations.length+identity.length,keyMaterial:snapshot.keyMaterial,sealed:vault.encrypt(plaintext)}}
export const CloudDataSync=new CloudDataSyncImpl();
