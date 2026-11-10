// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Files backup driver: prepare -> device-sign -> send, plus Vault escrow relay. */
import { getDesktopDeviceId } from '../../deviceIdentity';
import { getCurrentUserId } from '../../sullaCloudAuth';
import { DevicesCloudApi } from '../../devicesCloudApi';
import { isCloudSignedIn } from '../cloudFetch';
import { getCloudPreferences } from '../cloudSettings';
import { signDeviceMessage } from '../deviceKey';
import { FilesSyncContainer, FilesSyncClientError, type FilesSyncStatus, type CloudFilesCollection, type CloudRestoreAllResult } from './containerClient';
import { getSullaFilesClient } from '@pkg/main/sullaFilesClient';
import { getSullaFilesWatcher } from '@pkg/main/sullaFilesWatcher';
import Logging from '@pkg/utils/logging';
export { requireHumanFilesSync } from './humanGuard';
import { requireHumanFilesSync, type FilesSyncCaller } from './humanGuard';
import { SyncDriverHealth } from '../syncDriverHealth';
import { OfflineErrorClassifier } from '../offlineErrorClassifier';

const console=Logging.background;
const IDLE_MS=15_000, MIN_SIGNATURE_MS=1_000, MAX_BACKOFF_MS=5*60_000;

/**
 * A collection created by Mobile or Cloud does not exist in Desktop's local
 * catalog yet, so the normal per-collection pull loop cannot discover it.
 * Restore it first; the Files service then uses its ordinary verified pull to
 * materialize files (and their parent folders) without re-uploading versions.
 */
export async function restoreMissingCloudCollections(
  list:()=>Promise<{collections:CloudFilesCollection[]}>,
  restore:()=>Promise<CloudRestoreAllResult>,
):Promise<CloudRestoreAllResult|null> {
  const remote=await list();
  if(!remote.collections.some(collection=>collection.local===false&&collection.status==='active'))return null;
  return restore();
}

class FilesSyncV1Impl {
  private readonly health=new SyncDriverHealth();
  private readonly offline=new OfflineErrorClassifier();
  private lastSuccessLogAt=0;
  private timer:ReturnType<typeof setTimeout>|null=null; private running=false; private stopped=true; private backoff=1_000; private lastSignatureAt=0;
  // A wake that lands mid-tick must not be lost when that tick reschedules itself.
  private wakeRequested=false;
  start():void { this.stopped=false; this.health.setRunning(true); this.schedule(0) }
  restart():void { this.stop(); this.start() }
  stop():void { this.stopped=true; this.health.setRunning(false); this.wakeRequested=false; if(this.timer) clearTimeout(this.timer); this.timer=null }
  wake():void { if(this.stopped) return; if(this.running) this.wakeRequested=true; else this.schedule(0) }
  /** Network is back: drop the offline backoff and try now. */
  resumeAfterOffline():void { this.backoff=1_000; this.wake() }
  async status():Promise<FilesSyncStatus & {driverHealth:ReturnType<SyncDriverHealth['snapshot']>}> { return {...await FilesSyncContainer.status(),driverHealth:this.health.snapshot()} }
  driverHealth():ReturnType<SyncDriverHealth['snapshot']> { return this.health.snapshot() }
  async setEnabled(collectionId:string,enabled:boolean,caller:FilesSyncCaller):Promise<FilesSyncStatus> { requireHumanFilesSync(caller); await FilesSyncContainer.enable(collectionId,enabled); if(enabled)await this.relayEscrow().catch(error=>{ const code=error instanceof FilesSyncClientError?error.code:''; if(code!=='vault_locked'&&code!=='no_cloud_vault')throw error }); this.wake(); return this.status() }
  async deleteCloudCopy(collectionId:string,caller:FilesSyncCaller):Promise<FilesSyncStatus> { requireHumanFilesSync(caller); await FilesSyncContainer.deleteCloudCopy(collectionId); this.wake(); return this.status() }
  // Profile › Files off with "delete the Cloud copy": hide every collection
  // from Cloud Files and stop and crypto-shred each backup.
  async deleteAllCloudCopies(caller:FilesSyncCaller):Promise<FilesSyncStatus> {
    requireHumanFilesSync(caller);
    const collections=await getSullaFilesClient().json<Array<{id:string;system_area:string|null}>>('/v1/collections');
    for(const collection of collections){
      if(collection.system_area)continue;
      await getSullaFilesClient().json(`/v1/collections/${encodeURIComponent(collection.id)}/cloud-sync`,{method:'PATCH',body:JSON.stringify({enabled:false})});
    }
    for(const collection of (await this.status()).collections){
      if(collection.enabled)await FilesSyncContainer.enable(collection.collectionId,false);
      try { await FilesSyncContainer.deleteCloudCopy(collection.collectionId) }
      catch(error) { if(!(error instanceof FilesSyncClientError)||error.status!==409)throw error }
    }
    await this.drainDeletes();
    return this.status();
  }
  async cloudCollections(caller:FilesSyncCaller):Promise<CloudFilesCollection[]> { requireHumanFilesSync(caller); return (await FilesSyncContainer.cloudCollections()).collections.filter(collection=>collection.local===false) }
  async restore(collectionId:string,name:string,caller:FilesSyncCaller):Promise<{restored:true;collectionId:string}> {
    requireHumanFilesSync(caller);
    if(!/^[0-9a-f-]{36}$/i.test(collectionId)||typeof name!=='string'||!name.trim()||name.length>128)throw new FilesSyncClientError('invalid_request',400);
    const key=await this.restoreKey();
    const restored=await FilesSyncContainer.restore({collectionId,name:name.trim(),...key});
    this.wake(); return restored;
  }
  // New Desktop: one vault unlock restores every Cloud collection this machine doesn't have yet.
  async restoreAll(caller:FilesSyncCaller):Promise<CloudRestoreAllResult> {
    requireHumanFilesSync(caller);
    const result=await FilesSyncContainer.restoreAll(await this.restoreKey());
    this.wake(); return result;
  }
  // The local vault's escrow key, or the Cloud vault's after the human unlocked it on this Desktop.
  private async restoreKey():Promise<{requestId:string;transport:unknown;vaultId:string;vaultEpoch:number}> {
    const request=await FilesSyncContainer.escrowRequest();
    let wrapped;
    try { wrapped=await FilesSyncContainer.vaultEscrowKey(request) }
    catch(error) { if(!(error instanceof FilesSyncClientError)||error.code!=='no_cloud_vault')throw error; wrapped=await FilesSyncContainer.vaultRestoreKey(request) }
    return {requestId:request.requestId,transport:wrapped.transport,vaultId:wrapped.vaultId,vaultEpoch:wrapped.vaultEpoch};
  }
  private schedule(ms:number):void { if(this.stopped)return; if(this.wakeRequested){this.wakeRequested=false;ms=0} if(this.timer)clearTimeout(this.timer); this.health.scheduledIn(ms); this.timer=setTimeout(()=>{this.timer=null;void this.tick()},ms); this.timer.unref?.() }
  private async identity():Promise<{userId:string;deviceId:string}|null> {
    if(!await isCloudSignedIn())return null;
    const state=DevicesCloudApi.getState(); if(!state.registered||state.revoked)return null;
    const userId=await getCurrentUserId().catch(()=>''); return userId?{userId,deviceId:await getDesktopDeviceId()}:null;
  }
  // Profile › Files on means every collection Desktop Files shows is listed
  // in Cloud Files and backed up, including folders added later. System
  // areas (Sulla) never leave the machine.
  private async enrollCollections():Promise<void> {
    const collections=await getSullaFilesClient().json<Array<{id:string;system_area:string|null;cloud_catalog_sync?:boolean}>>('/v1/collections');
    const backup=new Map((await this.status()).collections.map(c=>[c.collectionId,c.enabled]));
    for(const collection of collections){
      if(collection.system_area)continue;
      if(!collection.cloud_catalog_sync)await getSullaFilesClient().json(`/v1/collections/${encodeURIComponent(collection.id)}/cloud-sync`,{method:'PATCH',body:JSON.stringify({enabled:true})});
      if(backup.get(collection.id)===false)await FilesSyncContainer.enable(collection.id,true);
    }
  }
  private async relayEscrow():Promise<void> {
    const request=await FilesSyncContainer.escrowRequest();
    const wrapped=await FilesSyncContainer.vaultEscrowKey(request);
    await FilesSyncContainer.escrowKey({requestId:request.requestId,transport:wrapped.transport,vaultId:wrapped.vaultId,vaultEpoch:wrapped.vaultEpoch});
  }
  private async restoreMissing():Promise<void> {
    await restoreMissingCloudCollections(
      ()=>FilesSyncContainer.cloudCollections(),
      async()=>FilesSyncContainer.restoreAll(await this.restoreKey()),
    );
  }
  // The driver only runs while Files is on, so queued deletes are sent here.
  private async drainDeletes():Promise<void> {
    for(let i=0;this.running&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,100));
    if(this.running)return;
    const who=await this.identity(); if(!who)return;
    this.running=true;
    try {
      for(let i=0;i<100;i++){
        const prepared=await FilesSyncContainer.prepare(); if(!prepared||prepared.op!=='delete')return;
        const wait=Math.max(0,MIN_SIGNATURE_MS-(Date.now()-this.lastSignatureAt)); if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
        const proof=signDeviceMessage('files-sync-v1',[who.userId,who.deviceId,prepared.collectionId,prepared.op,prepared.sha256]); this.lastSignatureAt=Date.now();
        const sent=await FilesSyncContainer.send(prepared.handle,who.deviceId,proof.ts,proof.signature);
        if(sent.status!=='sent')throw new FilesSyncClientError(`delete_${sent.status}`,502);
      }
    } finally { this.running=false }
  }
  private async tick():Promise<void> {
    if(this.running||this.stopped)return; this.running=true;
    if(!getSullaFilesWatcher().isReadyForSync()) {
      this.running=false;
      this.schedule(1_000);
      return;
    }
    this.health.attempted();
    // The attempt is due now; the supervisor's stall grace runs from here, so a slow in-flight sync is not restarted early.
    this.health.scheduledIn(0);
    try {
      const prefs=await getCloudPreferences(); if(!prefs.enabled||!prefs.files){this.backoff=1_000;this.schedule(IDLE_MS);return}
      const who=await this.identity(); if(!who){this.backoff=1_000;this.schedule(IDLE_MS);return}
      await this.restoreMissing();
      await this.enrollCollections();
      const status=await this.status(); const enabled=status.collections.filter(c=>c.enabled);
      if(!enabled.length){this.backoff=1_000;this.schedule(IDLE_MS);return}
      if(enabled.some(c=>c.status==='needs-vault')) await this.relayEscrow();
      const prepared=await FilesSyncContainer.prepare();
      if(!prepared){this.backoff=1_000;this.schedule(IDLE_MS);return}
      const wait=Math.max(0,MIN_SIGNATURE_MS-(Date.now()-this.lastSignatureAt)); if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
      const proof=signDeviceMessage('files-sync-v1',[who.userId,who.deviceId,prepared.collectionId,prepared.op,prepared.sha256]); this.lastSignatureAt=Date.now();
      const sent=await FilesSyncContainer.send(prepared.handle,who.deviceId,proof.ts,proof.signature);
      if(sent.status==='failed')throw new FilesSyncClientError('send_failed',502);
      if(sent.status==='sent') {
        const previous=this.health.snapshot();
        const endedOffline=this.health.succeeded();
        if(endedOffline) console.log('[FilesSyncV1] back online; sync resumed');
        const now=Date.now();
        if(previous.consecutiveFailures>0||now-this.lastSuccessLogAt>=10*60_000) {
          console.log('[FilesSyncV1] sync ok pushed=1 pulled=0');
          this.lastSuccessLogAt=now;
        }
      }
      this.backoff=sent.status==='retry'?Math.min(this.backoff*2,MAX_BACKOFF_MS):1_000; this.schedule(sent.status==='retry'?this.backoff:MIN_SIGNATURE_MS);
    } catch(error) {
      const code=error instanceof FilesSyncClientError?error.code:'sync_failed';
      if(this.offline.isOffline(error)) {
        // Offline: one line when it starts, no error streak; backoff keeps retries quiet until 'online' resumes us.
        if(this.health.unreachable()) console.log('[FilesSyncV1] offline; backup waits and resumes when the network is back');
      } else {
        if(this.health.failed(code)) console.log('[FilesSyncV1] back online; sync resumed');
        if(code!=='vault_locked'&&code!=='no_cloud_vault')console.warn(`[FilesSyncV1] driver retry: ${code}`);
      }
      this.schedule(this.backoff=Math.min(this.backoff*2,MAX_BACKOFF_MS));
    } finally { this.running=false }
  }
}
export const FilesSyncV1=new FilesSyncV1Impl();
