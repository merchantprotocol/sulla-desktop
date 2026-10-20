import { randomUUID } from 'node:crypto';

/** Main polls this authenticated local queue; no container-to-host listener is needed. */
export class BackupRuntimeRequests {
  private readonly pending=new Map<string,{destinationId:string;action:'mount'|'unmount';resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  list():{id:string;destinationId:string;action:'mount'|'unmount'}[] { return [...this.pending].map(([id,item])=>({id,destinationId:item.destinationId,action:item.action})) }
  prepare(destinationId:string,action:'mount'|'unmount'='mount'):Promise<void> {
    return new Promise((resolve,reject)=>{
      const id=randomUUID();
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Desktop backup mount preparation timed out'))},3*60_000);
      this.pending.set(id,{destinationId,action,resolve,reject,timer});
    });
  }
  complete(id:string,ok:boolean):boolean {
    const item=this.pending.get(id); if(!item) return false;
    this.pending.delete(id);clearTimeout(item.timer);
    if(ok) item.resolve(); else item.reject(new Error('Desktop could not mount the NAS share; check the share and Vault credentials'));
    return true;
  }
  stop():void { for(const id of this.pending.keys()) this.complete(id,false) }
}
