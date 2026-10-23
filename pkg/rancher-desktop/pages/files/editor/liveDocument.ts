// The base64 entry initializes WASM in JS; no renderer wasm-loader/fetch URL is required.
import * as A from '@automerge/automerge';
import type { FilesDataSource } from '../types';
import type { FilesLiveConnection, FilesLiveEvent } from '../liveTypes';

type TextDoc={text:string};
// Preserve disconnected edits when switching editor tabs; reconnect uses the same CRDT history.
const recovery=new Map<string,Uint8Array>();
const encode=(bytes:Uint8Array)=>{let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value);};
const decode=(value:string)=>Uint8Array.from(atob(value),char=>char.charCodeAt(0));
export class LiveDocument {
  private doc:A.Doc<TextDoc>;
  private state=A.initSyncState();
  private connection?:FilesLiveConnection;
  private pending:FilesLiveEvent[]=[];
  private sending=false;
  private closed=false;
  private retry?:ReturnType<typeof setTimeout>;
  private initialized=false;
  private ready?:()=>void;
  constructor(private source:FilesDataSource,private fileId:string,private text:(value:string)=>void,private status:(value:'live'|'syncing'|'offline')=>void,private presence:(peers:{id:string;name:string;kind:string}[])=>void){const saved=recovery.get(fileId);this.doc=saved?A.load<TextDoc>(saved):A.init<TextDoc>();}
  async start(){await this.connect();if(!this.initialized)await new Promise<void>((resolve,reject)=>{this.ready=resolve;setTimeout(()=>{if(!this.initialized)reject(new Error('Live sync timed out'));},5_000);});}
  private async connect(){if(!this.source.openLive)throw new Error('Live editing unavailable');this.state=A.initSyncState();this.status('syncing');this.connection=await this.source.openLive(this.fileId,event=>{if(!this.connection)this.pending.push(event);else this.event(event);});if(this.closed){await this.connection.close();return;}for(const event of this.pending.splice(0))this.event(event);await this.pump();}
  private event(event:FilesLiveEvent){if(this.closed)return;if(event.type==='presence'){this.presence(event.peers);return;}if(event.type==='error'){this.offline();return;}try{[this.doc,this.state]=A.receiveSyncMessage(this.doc,this.state,decode(event.message));if(typeof this.doc.text==='string'){this.initialized=true;this.text(this.doc.text);this.ready?.();this.ready=undefined;}void this.pump();}catch{this.offline();}}
  edit(text:string){if(this.closed||!this.initialized)return;this.doc=A.change(this.doc,draft=>A.updateText(draft,['text'],text));this.status('syncing');void this.pump();}
  private async pump(){if(this.sending||!this.connection||this.closed)return;this.sending=true;try{while(this.connection&&!this.closed){const [state,message]=A.generateSyncMessage(this.doc,this.state);this.state=state;if(!message){if(this.initialized)this.status('live');break;}const reply=await this.connection.sync(encode(message));if(reply.message)this.event({type:'sync',message:reply.message});}}catch{this.offline();}finally{this.sending=false;}}
  private offline(){if(this.closed)return;this.status('offline');const old=this.connection;this.connection=undefined;void old?.close();if(!this.retry)this.retry=setTimeout(()=>{this.retry=undefined;if(!this.closed)void this.connect().catch(()=>this.offline());},1_500);}
  async close(){if(this.initialized)recovery.set(this.fileId,A.save(this.doc));clearTimeout(this.retry);if(this.connection){await this.pump();while(this.sending)await new Promise(resolve=>setTimeout(resolve,10));await this.pump();}if(this.connection)recovery.delete(this.fileId);this.closed=true;clearTimeout(this.retry);await this.connection?.close();this.connection=undefined;}
}
