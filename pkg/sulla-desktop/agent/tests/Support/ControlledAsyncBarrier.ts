// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type {CustodyTransactionKind,CustodyTransactionObservation,CustodyTransactionObserver,CustodyTransactionPhase} from '../../app/Repositories/AgentJobCustodyRepository';

/** Deterministic two-phase barrier for transaction/race tests; never relies on sleeps. */
export class ControlledAsyncBarrier {
  private releaseBarrier!:()=>void;
  private enterBarrier!:()=>void;
  readonly entered=new Promise<void>(resolve=>{this.enterBarrier=resolve;});
  private readonly released=new Promise<void>(resolve=>{this.releaseBarrier=resolve;});
  async enterAndWait(timeoutMs=5_000):Promise<void>{
    this.enterBarrier();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([this.released,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`ControlledAsyncBarrier timed out after ${timeoutMs}ms`)),timeoutMs);})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  release():void{this.releaseBarrier();}
}

/** Awaits and optionally holds real custody transaction phases emitted by the repository. */
export class CustodyTransactionBarrier implements CustodyTransactionObserver {
  private readonly observations:CustodyTransactionObservation[]=[];
  private readonly waiters=new Map<string,Array<()=>void>>();
  private readonly holds=new Map<string,{promise:Promise<void>;release:()=>void}>();

  hold(kind:CustodyTransactionKind,phase:CustodyTransactionPhase):void{
    let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});this.holds.set(this.key(kind,phase),{promise,release});
  }
  release(kind:CustodyTransactionKind,phase:CustodyTransactionPhase):void{const key=this.key(kind,phase);this.holds.get(key)?.release();this.holds.delete(key);}
  waitFor(kind:CustodyTransactionKind,phase:CustodyTransactionPhase):Promise<void>{
    const key=this.key(kind,phase);
    if(this.observations.some(event=>this.key(event.kind,event.phase)===key))return Promise.resolve();
    return new Promise(resolve=>this.waiters.set(key,[...(this.waiters.get(key)??[]),resolve]));
  }
  count(kind:CustodyTransactionKind,phase:CustodyTransactionPhase):number{return this.observations.filter(event=>event.kind===kind&&event.phase===phase).length;}
  async observe(event:CustodyTransactionObservation):Promise<void>{
    this.observations.push(event);
    const key=this.key(event.kind,event.phase);
    for(const resolve of this.waiters.get(key)??[])resolve();
    this.waiters.delete(key);
    const hold=this.holds.get(key);if(hold)await hold.promise;
  }
  private key(kind:CustodyTransactionKind,phase:CustodyTransactionPhase):string{return `${kind}:${phase}`;}
}
