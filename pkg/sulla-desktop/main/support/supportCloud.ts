// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import { app } from 'electron';

import { deviceMessage, getDevicePublicKey, signDeviceMessageExact } from '@pkg/main/cloud/deviceKey';
import { getOrCreateSupportDeviceId, readEnrolledSupportDeviceId } from '@pkg/main/support/supportIdentity';
import { SupportStateStore } from '@pkg/main/supportState';

const ORIGIN = 'https://sulla-workers.merchantprotocol.workers.dev';
let preferredIdentity: string | null = null;
function identities(): string[] { return [...new Set([preferredIdentity, readEnrolledSupportDeviceId(), stateStore().read().supportIdentity?.guestDeviceId, getOrCreateSupportDeviceId()].filter((value):value is string=>!!value))] }

export async function supportCloudRequest(method: string, pathname: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(pathname.startsWith('/support') || pathname.startsWith('/device-tools') ? pathname : `/support${ pathname }`, ORIGIN);
  const encoded = init.body === undefined || init.body === null ? null : new Response(init.body);
  const body = encoded ? new Uint8Array(await encoded.arrayBuffer()) : new Uint8Array();
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const candidates=identities();
  for(let index=0;index<candidates.length;index++){
    const deviceId=candidates[index],ts=Date.now(),nonce=crypto.randomBytes(18).toString('base64url');
    const signature=signDeviceMessageExact('support-request-v1',[deviceId,method.toUpperCase(),url.pathname+url.search,ts,nonce,bodyHash]);
    const headers=new Headers(init.headers);if(encoded?.headers.get('content-type')&&!headers.has('content-type'))headers.set('content-type',encoded.headers.get('content-type')!);headers.set('accept','application/json');headers.set('X-Sulla-Device',deviceId);headers.set('X-Sulla-Ts',String(ts));headers.set('X-Sulla-Nonce',nonce);headers.set('X-Sulla-Signature',signature);
    const response=await fetch(url,{...init,method,headers,body:body.byteLength?body:undefined});
    if(response.status!==401){preferredIdentity=deviceId;return response}
    const payload=await response.clone().json().catch(()=>({})) as any;
    if(!['invalid_support_signature','device_not_enrolled'].includes(payload.error)||index===candidates.length-1)return response;
  }
  throw new Error('No support identity is available.');
}

export async function supportJson(method: string, pathname: string, body?: unknown, headers: Record<string,string> = {}): Promise<any> {
  const response = await supportCloudRequest(method, pathname, { headers:{ ...headers, ...(body === undefined ? {} : {'content-type':'application/json'}) }, body:body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) { const error:any = new Error(payload.message || payload.error || `Support returned ${response.status}`); error.code=payload.error; error.status=response.status; throw error }
  return payload;
}

export async function supportWhoAmI(): Promise<{enrolled:boolean;guest:boolean;email?:string}> { return supportJson('GET','/support/whoami') }

export async function registerGuestSupport(email:string, deviceName:string, appVersion:string): Promise<{deviceId:string;guest:true}> {
  const publicKey=getDevicePublicKey(), normalizedEmail=email.trim().toLowerCase(), ts=Date.now(), nonce=crypto.randomBytes(18).toString('base64url');
  const signature=signDeviceMessageExact('support-guest-v1',[publicKey,normalizedEmail,ts,nonce]);
  const response=await fetch(new URL('/support/guest-device',ORIGIN),{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({publicKey,deviceName,appVersion,email:normalizedEmail,ts,nonce,signature,website:''})});
  const payload=await response.json().catch(()=>({})) as any; if(!response.ok)throw new Error(payload.error||`Support registration failed (${response.status})`);
  stateStore().update(state=>{state.supportIdentity={guestDeviceId:payload.deviceId,email:normalizedEmail}}); preferredIdentity=payload.deviceId; return payload;
}
