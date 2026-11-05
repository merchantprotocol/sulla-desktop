// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Deterministic two-phase barrier for transaction/race tests; never relies on sleeps. */
export class ControlledAsyncBarrier {
  private releaseBarrier!:()=>void;
  private enterBarrier!:()=>void;
  readonly entered=new Promise<void>(resolve=>{this.enterBarrier=resolve;});
  private readonly released=new Promise<void>(resolve=>{this.releaseBarrier=resolve;});
  async enterAndWait():Promise<void>{this.enterBarrier();await this.released;}
  release():void{this.releaseBarrier();}
}
