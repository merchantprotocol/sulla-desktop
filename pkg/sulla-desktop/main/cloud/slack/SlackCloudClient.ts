// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { getDesktopDeviceId } from '../../deviceIdentity';
import { getCurrentUserId } from '../../sullaCloudAuth';
import { cloudRequest } from '../cloudFetch';
import { signDeviceMessage } from '../deviceKey';
export interface SlackInboundFrame { id: string; eventId: string; apiAppId: string; teamId: string; receivedAt: string; event: Record<string, unknown> }
export class SlackCloudClient {
  async register(apiAppId: string, teamSlackId: string): Promise<void> {
    const deviceId=await getDesktopDeviceId(), userId=await getCurrentUserId();
    const proof=signDeviceMessage('slack-workspace-v1',[userId,deviceId,apiAppId,teamSlackId]);
    const response=await cloudRequest('POST','/slack/workspaces',{headers:{'Content-Type':'application/json','X-Sulla-Timestamp':String(proof.ts),'X-Sulla-Device-Signature':proof.signature},body:JSON.stringify({apiAppId,teamSlackId})});
    if(!response.ok) throw new Error(`Slack workspace registration failed (${response.status})`);
  }
  async drain(): Promise<SlackInboundFrame[]> { return this.request<SlackInboundFrame[]>('GET','/slack/inbound'); }
  async ack(ids: string[]): Promise<void> { if(ids.length) await this.request('POST','/slack/inbound/ack',JSON.stringify({ids})); }
  private async request<T>(method: 'GET'|'POST',path:string,body?:string):Promise<T>{
    const deviceId=await getDesktopDeviceId(), userId=await getCurrentUserId();
    const proof=signDeviceMessage('slack-inbound-v1',[userId,deviceId,method,path,body??'']);
    const response=await cloudRequest(method,path,{headers:{'Content-Type':'application/json','X-Sulla-Timestamp':String(proof.ts),'X-Sulla-Device-Signature':proof.signature},...(body?{body}:{})});
    if(!response.ok) throw new Error(`Slack inbound request failed (${response.status})`);
    return await response.json() as T;
  }
}
