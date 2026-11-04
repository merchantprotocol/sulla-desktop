// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import { BrowserWindow, dialog } from 'electron';

import { getConfiguredApprovalClient } from '@pkg/vault-broker';
import { getDesktopDeviceId } from '../deviceIdentity';
import { getCurrentUserId } from '../sullaCloudAuth';
import { cloudRequest } from './cloudFetch';
import { CloudVaultSyncHttpTransport, type EnrollmentRequest, type VaultSyncSignature } from './vaultSyncV3/transport';
import { signDeviceMessage } from './deviceKey';

interface ApprovalRequest {
  id: string; vaultId: string; vaultEpoch: number; publicKey: string; expiresAt: string;
  browser?: string; site?: string; near?: string; deviceName?: string;
}

class VaultDeviceApprovalService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly seen = new Set<string>();

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll().catch(() => undefined) }, 15_000);
    this.timer.unref?.();
    void this.poll().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.seen.clear();
  }

  private async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const client = getConfiguredApprovalClient();
      if (!client) return;
      const response = await client.sullaCloudRequest({ method: 'GET', path: '/auth/password/device-approval/requests', responseType: 'json' });
      const body = response.status === 200 ? response.body as { requests?: ApprovalRequest[] } : { requests: [] };
      for (const request of body.requests ?? []) {
        if (this.seen.has(request.id)) continue;
        this.seen.add(request.id);
        if (!await this.prompt(request)) continue; // No relay response of any kind without the tap.
        const wrapped = await client.wrapUserKeyForApprovedDevice({ ...request, requestId: request.id, approved: true });
        await client.sullaCloudRequest({
          method: 'POST', path: `/auth/password/device-approval/requests/${ encodeURIComponent(request.id) }/respond`,
          body: { wrappedUserKey: wrapped.wrappedUserKey }, responseType: 'json',
        });
      }
      await this.pollEnrollment(client);
    } finally {
      this.inFlight = false;
    }
  }

  private async prompt(request: ApprovalRequest): Promise<boolean> {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      type: 'question' as const,
      buttons: ['Deny', 'Approve'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Sulla Desktop',
      message: `Approve vault access for ${ request.deviceName || 'this browser' }?`,
      detail: `Only approve if you're unlocking your vault right now.\n\nBrowser  ${ request.browser || 'Browser details unavailable' }\nSite  ${ request.site || 'vault.sulladesktop.com' }\nNear  ${ request.near || 'Location unavailable' }\nWhen  Just now`,
    };
    const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    return result.response === 1;
  }

  private async pollEnrollment(client:NonNullable<ReturnType<typeof getConfiguredApprovalClient>>):Promise<void>{
    const deviceId=await getDesktopDeviceId();
    const transport=new CloudVaultSyncHttpTransport({client:{request:(url,init)=>cloudRequest(init?.method ?? 'GET',url,{headers:init?.headers as Record<string,string>|undefined,body:init?.body as BodyInit|undefined,responseType:'json'})},authHeaders:async()=>({})});
    const status=await transport.getStatus(deviceId);
    const vault=status as {enabled?:boolean;vaultId?:string;epoch?:number}; if(!vault.enabled||!vault.vaultId)return;
    const userId=await getCurrentUserId();
    const listed=await transport.listEnrollmentRequests(vault.vaultId,this.signature(vault.vaultId,'enrollment-list',undefined,deviceId,userId));
    for(const request of listed.requests??[]){
      if(this.seen.has(`enroll:${request.id}`))continue; this.seen.add(`enroll:${request.id}`);
      if(!await this.promptEnrollment(request))continue;
      const [bundleBody,recordsBody]=await Promise.all([transport.getBundle(vault.vaultId,deviceId),transport.getRecords(vault.vaultId,deviceId)]);
      const wrapped=await client.wrapVaultEnrollment({requestId:request.id,vaultId:vault.vaultId,vaultEpoch:Number(vault.epoch??(bundleBody.bundle as any)?.epoch),publicKey:request.publicKey!,bundle:bundleBody.bundle??bundleBody,head:recordsBody.head,records:recordsBody.records,approved:true});
      await transport.respondToEnrollmentRequest(vault.vaultId,request.id,{wrappedUserKey:wrapped.wrappedUserKey},this.signature(vault.vaultId,`enrollment-respond:${request.id}`,{wrappedUserKey:wrapped.wrappedUserKey},deviceId,userId));
      break;
    }
  }

  private signature(vaultId:string,op:string,body:unknown,deviceId:string,userId:string):VaultSyncSignature{
    const bytes=body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body));
    const hash=crypto.createHash('sha256').update(bytes).digest('hex');
    const proof=signDeviceMessage('vault-sync-v3',[userId,deviceId,vaultId,op,hash]);
    return {deviceId,timestamp:proof.ts,signature:proof.signature};
  }

  private async promptEnrollment(request:EnrollmentRequest):Promise<boolean>{
    const window=BrowserWindow.getFocusedWindow()??BrowserWindow.getAllWindows()[0];
    const options={type:'question' as const,buttons:['Allow','Not now'],defaultId:1,cancelId:1,noLink:true,title:'Sulla Desktop',message:'Allow this computer to use your Sulla vault?',detail:`Requester: ${request.requesterId}\n\nA signed-in ${request.requesterType.replace('_',' ')} is asking to use your existing Sulla vault.`};
    const result=window?await dialog.showMessageBox(window,options):await dialog.showMessageBox(options); return result.response===0;
  }

}

export const VaultDeviceApproval = new VaultDeviceApprovalService();
