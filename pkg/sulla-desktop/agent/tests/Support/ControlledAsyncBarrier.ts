// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

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
