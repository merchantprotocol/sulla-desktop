// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Human-owned Cloud upload preferences. Signing in never implies consent. */
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

export interface CloudPreferences {
  enabled: boolean;
  workflows: boolean; skills: boolean; customAgents: boolean; recipes: boolean;
  useCases: boolean; liveAgents: boolean; usage: boolean; memory: boolean;
  conversations: boolean; files: boolean; vault: boolean; remoteAccess: boolean;
}
export type CloudDataKind = Exclude<keyof CloudPreferences, 'enabled' | 'remoteAccess'>;
export const CLOUD_SETTING_KEYS: Record<keyof CloudPreferences, string> = {
  enabled:'cloudSyncEnabled', workflows:'cloudSyncWorkflows', skills:'cloudSyncSkills', customAgents:'cloudSyncCustomAgents',
  recipes:'cloudSyncRecipes', useCases:'cloudSyncUseCases', liveAgents:'cloudSyncLiveAgents', usage:'cloudSyncUsage',
  memory:'cloudSyncMemory', conversations:'cloudSyncConversations', files:'cloudSyncFiles', vault:'cloudSyncVault', remoteAccess:'cloudRemoteAccess',
};
const INITIALIZED_KEY='cloudSyncPreferencesInitializedV2';
const LEGACY_CURSOR_KEY='claudeSyncLastSeq';
type Listener=(prefs:CloudPreferences,changed:(keyof CloudPreferences)[])=>void;
const listeners:Listener[]=[];
function asBool(v:unknown,fallback:boolean){if(typeof v==='boolean')return v;if(v==='true')return true;if(v==='false')return false;return fallback}
async function ensureInitialized(){
  if(asBool(await SullaSettingsModel.get(INITIALIZED_KEY,false),false))return;
  const oldConversations=asBool(await SullaSettingsModel.get(CLOUD_SETTING_KEYS.conversations,false),false);
  const oldVault=asBool(await SullaSettingsModel.get(CLOUD_SETTING_KEYS.vault,false),false);
  const cursor=parseInt(String(await SullaSettingsModel.get(LEGACY_CURSOR_KEY,'0')??'0'),10);
  const hadLegacyPreferences=oldConversations||oldVault||(Number.isFinite(cursor)&&cursor>0);
  const conversations=hadLegacyPreferences ? oldConversations||(Number.isFinite(cursor)&&cursor>0) : true;
  // A genuinely fresh install syncs by default. Existing installs keep their prior explicit state.
  await SullaSettingsModel.set(CLOUD_SETTING_KEYS.enabled,hadLegacyPreferences ? conversations||oldVault : true,'boolean');
  for(const key of ['workflows','skills','customAgents','recipes','useCases','liveAgents','usage','memory','files'] as const)
    await SullaSettingsModel.set(CLOUD_SETTING_KEYS[key],true,'boolean');
  await SullaSettingsModel.set(CLOUD_SETTING_KEYS.conversations,conversations,'boolean');
  await SullaSettingsModel.set(CLOUD_SETTING_KEYS.vault,hadLegacyPreferences ? oldVault : true,'boolean');
  if(await SullaSettingsModel.get(CLOUD_SETTING_KEYS.remoteAccess,null)===null) await SullaSettingsModel.set(CLOUD_SETTING_KEYS.remoteAccess,true,'boolean');
  await SullaSettingsModel.set(INITIALIZED_KEY,true,'boolean');
}
export async function getCloudPreferences():Promise<CloudPreferences>{
  await ensureInitialized(); const get=async(k:keyof CloudPreferences,d=true)=>asBool(await SullaSettingsModel.get(CLOUD_SETTING_KEYS[k],d),d);
  return {enabled:await get('enabled',false),workflows:await get('workflows'),skills:await get('skills'),customAgents:await get('customAgents'),recipes:await get('recipes'),useCases:await get('useCases'),liveAgents:await get('liveAgents'),usage:await get('usage'),memory:await get('memory'),conversations:await get('conversations',false),files:await get('files'),vault:await get('vault',false),remoteAccess:await get('remoteAccess')};
}
export async function setCloudPreferences(patch:Partial<Record<keyof CloudPreferences,unknown>>):Promise<CloudPreferences>{
  const before=await getCloudPreferences();const changed:(keyof CloudPreferences)[]=[];
  for(const key of Object.keys(CLOUD_SETTING_KEYS) as (keyof CloudPreferences)[]){const v=patch[key];if(typeof v!=='boolean'||v===before[key])continue;await SullaSettingsModel.set(CLOUD_SETTING_KEYS[key],v,'boolean');changed.push(key)}
  const after=await getCloudPreferences();if(changed.length)for(const l of listeners)try{l(after,changed)}catch(err){console.warn('[cloudSettings] listener failed:',err)}return after;
}
export function onCloudPreferencesChanged(listener:Listener){listeners.push(listener);return()=>{const i=listeners.indexOf(listener);if(i>=0)listeners.splice(i,1)}}
export function isCloudKindEnabled(prefs:CloudPreferences,kind:CloudDataKind){return prefs.enabled&&prefs[kind]}
export const PROTECTED_SETTING_PREFIXES=['cloudSync','cloudRemoteAccess','secureChannel','pairedMobileUserId'];
export function isProtectedSetting(property:string){return PROTECTED_SETTING_PREFIXES.some(p=>property===p||property.startsWith(p))}
