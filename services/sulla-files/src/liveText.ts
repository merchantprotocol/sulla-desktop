import { randomUUID } from 'node:crypto';
import * as A from '@automerge/automerge';
import { editTextDocument, type TextDocument } from './automergeText.js';

export type LiveEvent = { type:'sync'; message:string } | { type:'presence'; peers:{id:string;name:string;kind:string}[] } | {type:'error';error:string};
type Peer = { id:string; name:string; kind:string; owner:string; editable:boolean; state:A.SyncState; touched:number; send?:(event:LiveEvent)=>void };
type Session = { document:A.Doc<TextDocument>; persisted:string; peers:Map<string,Peer>; timer?:ReturnType<typeof setTimeout>; persist: (doc:A.Doc<TextDocument>)=>Promise<void>; writers?:Map<string,{id:string;name:string;kind:string;expires:number}>; flushing?:Promise<void> };
const heads = (doc:A.Doc<TextDocument>) => A.getHeads(doc).join(',');

/** Owns the single continuous document; persistence callbacks must snapshot, never rebuild it. */
export class LiveTextSessions {
  private sessions = new Map<string,Session>();
  private sweep = setInterval(()=>{for(const [id,s] of this.sessions)for(const p of s.peers.values())if(Date.now()-p.touched>90_000)void this.leave(id,p.id).catch(()=>{});},30_000).unref();
  constructor(private delay=2_000,private onClose?:(id:string)=>void) {}
  has(id:string){return this.sessions.has(id)}
  document(id:string){return this.sessions.get(id)?.document}
  open(id:string,document:A.Doc<TextDocument>,persist:Session['persist']) { if(!this.sessions.has(id))this.sessions.set(id,{document,persisted:heads(document),peers:new Map(),persist}); }
  join(id:string,input:Pick<Peer,'name'|'kind'|'owner'|'editable'>) {
    const s=this.required(id); const peer:Peer={...input,id:randomUUID(),state:A.initSyncState(),touched:Date.now()};s.peers.set(peer.id,peer);this.presence(s);
    return {peerId:peer.id,editable:peer.editable};
  }
  peer(id:string,peerId:string,owner?:string){const p=this.required(id).peers.get(peerId);if(!p||(owner!==undefined&&p.owner!==owner))throw Object.assign(new Error('Live peer not found'),{status:404});p.touched=Date.now();return p;}
  subscribe(id:string,peerId:string,send:(event:LiveEvent)=>void){const s=this.required(id),p=this.peer(id,peerId);p.send=send;this.presence(s);this.send(s,p);return()=>{if(p.send===send)p.send=undefined};}
  receive(id:string,peerId:string,message:Uint8Array,editable=true){const s=this.required(id),p=this.peer(id,peerId);if((!p.editable||!editable)&&A.decodeSyncMessage(message).changes.length)throw Object.assign(new Error('View-only live peer cannot submit changes'),{status:403});
    const before=heads(s.document);[s.document,p.state]=A.receiveSyncMessage(s.document,p.state,message);if(heads(s.document)!==before)this.changed(s);const reply=this.message(s,p);if(reply&&p.send)p.send({type:'sync',message:reply});for(const other of s.peers.values())if(other!==p)this.send(s,other);return p.send?null:reply;
  }
  /** Called only after a content/mount/upload transaction commits. Merge preserves in-flight editor changes. */
  adopt(id:string,document:A.Doc<TextDocument>,writer?:{name:string;kind:string}){const s=this.sessions.get(id);if(!s)return;if(writer){s.writers??=new Map();s.writers.set(writer.name,{...writer,id:`writer:${writer.name}`,expires:Date.now()+5_000});this.presence(s);setTimeout(()=>this.presence(s),5_100).unref();}s.document=A.merge(s.document,A.clone(document));this.changed(s);for(const p of s.peers.values())this.send(s,p);}
  edit(id:string,text:string){const s=this.required(id);s.document=editTextDocument(s.document,text);this.changed(s);for(const p of s.peers.values())this.send(s,p);}
  private changed(s:Session){clearTimeout(s.timer);s.timer=setTimeout(()=>void this.flushSession(s).catch(error=>{for(const p of s.peers.values())p.send?.({type:'error',error:String(error)});this.changed(s);}),this.delay).unref();}
  private message(s:Session,p:Peer){const [state,message]=A.generateSyncMessage(s.document,p.state);p.state=state;return message?Buffer.from(message).toString('base64'):null;}
  private send(s:Session,p:Peer){if(!p.send)return;const message=this.message(s,p);if(message)p.send({type:'sync',message});}
  private presence(s:Session){for(const [id,p] of s.writers??[])if(p.expires<Date.now())s.writers!.delete(id);const event:LiveEvent={type:'presence',peers:[...s.peers.values()].map(({id,name,kind})=>({id,name,kind})).concat([...(s.writers?.values()??[])].map(({id,name,kind})=>({id,name,kind})))};for(const p of s.peers.values())p.send?.(event);}
  private required(id:string){const s=this.sessions.get(id);if(!s)throw Object.assign(new Error('Live session not found'),{status:404});return s;}
  async flush(id:string){await this.flushSession(this.required(id));}
  private async flushSession(s:Session):Promise<void>{if(s.flushing){await s.flushing;return this.flushSession(s)}clearTimeout(s.timer);if(heads(s.document)===s.persisted)return;const snapshot=A.clone(s.document),saved=heads(snapshot);s.flushing=s.persist(snapshot);try{await s.flushing;s.persisted=saved;}finally{s.flushing=undefined}if(heads(s.document)!==saved)this.changed(s);}
  async leave(id:string,peerId:string){const s=this.required(id);s.peers.delete(peerId);this.presence(s);try{await this.flushSession(s)}catch(error){this.changed(s);throw error;}if(!s.peers.size&&heads(s.document)===s.persisted){clearTimeout(s.timer);this.sessions.delete(id);this.onClose?.(id);}}
  async close(){clearInterval(this.sweep);for(const [id,s] of this.sessions){for(const p of s.peers.values())p.send?.({type:'error',error:'Files service is shutting down'});await this.flush(id);this.onClose?.(id);}this.sessions.clear();}
}
