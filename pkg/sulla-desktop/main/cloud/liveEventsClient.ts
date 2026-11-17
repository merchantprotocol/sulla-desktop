// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CLOUD_RELAY_BASE } from './cloudEndpoints';
import { getCurrentAccessToken, getCurrentUserId, isCloudSignedIn } from '../sullaCloudAuth';

export interface LiveEvent { type:string; topic:string; id?:string; orgId?:string }
interface SocketPort { addEventListener(type:string, listener:(event:any)=>void):void; send(data:string):void; close():void; readyState?:number }
interface Deps {
  token:()=>Promise<string|null>; userId:()=>Promise<string>; signedIn:()=>Promise<boolean>;
  socket:(url:string)=>SocketPort; dispatch:(event:LiveEvent)=>void;
  random?:()=>number; setTimeout?:(fn:()=>void,ms:number)=>ReturnType<typeof setTimeout>; clearTimeout?:(timer:ReturnType<typeof setTimeout>)=>void;
  setInterval?:(fn:()=>void,ms:number)=>ReturnType<typeof setInterval>; clearInterval?:(timer:ReturnType<typeof setInterval>)=>void;
}

/** Owns the authenticated Cloud LiveEvents stream for one signed-in account. */
export class CloudLiveEventsClient {
  private running=false; private socketPort:SocketPort|null=null; private user=''; private attempt=0;
  private reconnectTimer?:ReturnType<typeof setTimeout>; private pingTimer?:ReturnType<typeof setInterval>;
  constructor(private readonly deps:Deps) {}
  start():void { if(this.running)return; this.running=true; void this.connect() }
  stop():void { this.running=false; this.user=''; if(this.reconnectTimer)this.clearTimeout(this.reconnectTimer); if(this.pingTimer)this.clearInterval(this.pingTimer); this.reconnectTimer=undefined;this.pingTimer=undefined;const ws=this.socketPort;this.socketPort=null;ws?.close() }
  private async connect():Promise<void> {
    if(!this.running)return;
    try {
      if(!await this.deps.signedIn())throw new Error('signed out');
      const token=await this.deps.token(); const user=await this.deps.userId(); if(!token||!user)throw new Error('session unavailable');
      if(!this.running)return;
      if(this.user&&this.user!==user){this.stop();return}
      this.user=user;
      const ws=this.deps.socket(`${CLOUD_RELAY_BASE}/live/ws?token=${encodeURIComponent(token)}`);this.socketPort=ws;
      ws.addEventListener('open',()=>{if(!this.running||this.socketPort!==ws)return;this.attempt=0;this.pingTimer=this.setInterval(()=>{try{ws.send(JSON.stringify({type:'ping'}))}catch{this.schedule() }},30_000)});
      ws.addEventListener('message',event=>{if(!this.running||this.socketPort!==ws)return;let payload:unknown;try{payload=JSON.parse(String(event.data))}catch{return}if(!payload||typeof payload!=='object')return;const data=payload as LiveEvent;if(data.type==='connected'||data.type==='pong')return;if(typeof data.topic==='string')this.deps.dispatch(data)});
      ws.addEventListener('close',()=>{if(this.socketPort!==ws)return;this.socketPort=null;if(this.pingTimer)this.clearInterval(this.pingTimer);this.pingTimer=undefined;this.schedule()});
      ws.addEventListener('error',()=>{if(this.socketPort===ws){ws.close()}});
    } catch { this.schedule() }
  }
  private schedule():void { if(!this.running||this.reconnectTimer)return;if(this.pingTimer)this.clearInterval(this.pingTimer);this.pingTimer=undefined;const random=this.deps.random??Math.random;const base=Math.min(60_000,1_000*2**Math.min(this.attempt++,6));this.reconnectTimer=this.setTimeout(()=>{this.reconnectTimer=undefined;void this.connect()},Math.floor(base*(0.75+random()*0.5))) }
  private setTimeout(fn:()=>void,ms:number):ReturnType<typeof setTimeout>{return(this.deps.setTimeout??setTimeout)(fn,ms)}
  private clearTimeout(timer:ReturnType<typeof setTimeout>):void{(this.deps.clearTimeout??clearTimeout)(timer)}
  private setInterval(fn:()=>void,ms:number):ReturnType<typeof setInterval>{return(this.deps.setInterval??setInterval)(fn,ms)}
  private clearInterval(timer:ReturnType<typeof setInterval>):void{(this.deps.clearInterval??clearInterval)(timer)}
}

export const CloudLiveEvents = new CloudLiveEventsClient({
  token:getCurrentAccessToken,userId:getCurrentUserId,signedIn:isCloudSignedIn,socket:url=>new WebSocket(url),
  dispatch:event=>{if(event.topic==='files'&&event.id){void import('./filesSyncV1').then(({FilesSyncV1})=>FilesSyncV1.pullSoon(event.id!)).catch(()=>undefined)}else if(event.topic==='conversations'&&event.orgId){void import('@pkg/agent/services/BackendGraphWebSocketService').then(({getBackendGraphWebSocketService})=>getBackendGraphWebSocketService().onOrgLiveEvent(event.topic,event.orgId)).catch(()=>undefined)}}
});
