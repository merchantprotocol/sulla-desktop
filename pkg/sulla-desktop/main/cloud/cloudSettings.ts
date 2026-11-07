// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Human-owned Cloud upload preferences. Signing in never implies consent. */
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

import { planConsentInit, recommendedConsentPatch } from './cloudConsentInit';

export interface CloudPreferences {
  enabled: boolean;
  usage: boolean; memory: boolean;
  conversations: boolean; files: boolean; vault: boolean; remoteAccess: boolean;
}
export type CloudDataKind = Exclude<keyof CloudPreferences, 'enabled' | 'remoteAccess'>;
export const CLOUD_SETTING_KEYS: Record<keyof CloudPreferences, string> = {
  enabled:'cloudSyncEnabled', usage:'cloudSyncUsage',
  memory:'cloudSyncMemory', conversations:'cloudSyncConversations', files:'cloudSyncFiles', vault:'cloudSyncVault', remoteAccess:'cloudRemoteAccess',
};
const INITIALIZED_KEY='cloudSyncPreferencesInitializedV3';
const LEGACY_CURSOR_KEY='claudeSyncLastSeq';
/** Explicit user action only: never includes passwords, API credentials, or remote execution. */
export const RECOMMENDED_CLOUD_DATA_KINDS: readonly CloudDataKind[] = [
  'usage','memory','conversations','files',
];
type Listener=(prefs:CloudPreferences,changed:(keyof CloudPreferences)[])=>void;
const listeners:Listener[]=[];
function asBool(v:unknown,fallback:boolean){if(typeof v==='boolean')return v;if(v==='true')return true;if(v==='false')return false;return fallback}
async function ensureInitialized(){
  if(asBool(await SullaSettingsModel.get(INITIALIZED_KEY,false),false))return;
  const keys=Object.keys(CLOUD_SETTING_KEYS) as (keyof CloudPreferences)[];
  const current=Object.fromEntries(await Promise.all(keys.map(async key=>[key,await SullaSettingsModel.get(CLOUD_SETTING_KEYS[key],null)]))) as Partial<Record<keyof CloudPreferences,unknown>>;
  // New installs start with no uploads. Existing installations keep every explicit
  // value, including false and mixed settings; only missing keys get the safe off default.
  const plan=planConsentInit(keys,current,await SullaSettingsModel.get(LEGACY_CURSOR_KEY,'0'));
  for(const key of keys)if(key in plan)await SullaSettingsModel.set(CLOUD_SETTING_KEYS[key],plan[key],'boolean');
  await SullaSettingsModel.set(INITIALIZED_KEY,true,'boolean');
}

export function recommendedCloudPreferencesPatch():Partial<Record<keyof CloudPreferences,boolean>>{
  return recommendedConsentPatch(RECOMMENDED_CLOUD_DATA_KINDS) as Partial<Record<keyof CloudPreferences,boolean>>;
}
export async function enableRecommendedCloudPreferences():Promise<CloudPreferences>{
  return setCloudPreferences(recommendedCloudPreferencesPatch());
}

export async function getCloudPreferences():Promise<CloudPreferences>{
  await ensureInitialized(); const get=async(k:keyof CloudPreferences,d=true)=>asBool(await SullaSettingsModel.get(CLOUD_SETTING_KEYS[k],d),d);
  return {enabled:await get('enabled',false),usage:await get('usage'),memory:await get('memory'),conversations:await get('conversations',false),files:await get('files'),vault:await get('vault',false),remoteAccess:await get('remoteAccess')};
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
