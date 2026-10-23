import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app, safeStorage } from 'electron';

import { ConversationMessagesModel } from '@pkg/agent/database/models/ConversationMessagesModel';
import { ConversationHistoryModel } from '@pkg/agent/database/models/ConversationHistoryModel';
import Logging from '@pkg/utils/logging';
import { cloudRequest } from '../cloudFetch';
import { getDesktopDeviceId } from '../../deviceIdentity';
import { safeDelta, type EncryptedBody, type LinkPrivacyMode } from './privacy';

const console = Logging.background;
type Link = { id:string; remote_conversation_id:string; privacy_mode:LinkPrivacyMode; upload_cursor:number };
type Dispatch = (body:Record<string, any>, reply:(frame:Record<string, unknown>)=>void, respond:(frame:Record<string, unknown>)=>void)=>Promise<void>;

class ConversationSyncServiceImpl {
  private timer:ReturnType<typeof setInterval>|null = null;
  private keys = new Map<string, Buffer>();
  private dispatcher:Dispatch|null = null;

  start() { if (this.timer) return; this.loadKeys(); this.timer=setInterval(()=>this.syncNow().catch(e=>console.warn('[ConversationSync] sync failed:',e)),30_000); void this.syncNow(); }
  stop() { if(this.timer) clearInterval(this.timer); this.timer=null; }
  setDispatcher(fn:Dispatch) { this.dispatcher=fn; }
  private keyPath() { return path.join(app.getPath('userData'),'cloud-conversation-keys.json'); }
  private loadKeys() {
    if(!safeStorage.isEncryptionAvailable()) return;
    try {
      const rows=JSON.parse(fs.readFileSync(this.keyPath(),'utf8')) as Record<string,string>;
      for(const [id,sealed] of Object.entries(rows)) this.keys.set(id,Buffer.from(safeStorage.decryptString(Buffer.from(sealed,'base64')),'base64'));
    } catch { /* first run or corrupt file: links stay unavailable rather than exposing plaintext */ }
  }
  private saveKeys() {
    if(!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage is unavailable');
    const rows:Record<string,string>={};
    for(const [id,key] of this.keys) rows[id]=safeStorage.encryptString(key.toString('base64')).toString('base64');
    const file=this.keyPath(), tmp=`${file}.tmp`;
    fs.writeFileSync(tmp,JSON.stringify(rows),{mode:0o600}); fs.renameSync(tmp,file);
  }
  private ensureKey(conversationId:string) {
    let key=this.keys.get(conversationId);
    if(!key){key=crypto.randomBytes(32);this.keys.set(conversationId,key);this.saveKeys();}
    return key;
  }
  wrapKey(conversationId:string, publicJwk:JsonWebKey) {
    const publicKey=crypto.createPublicKey({key:publicJwk,format:'jwk'});
    return crypto.publicEncrypt({key:publicKey,oaepHash:'sha256'},this.ensureKey(conversationId)).toString('base64');
  }
  private async encrypt(conversationId:string, body:string):Promise<EncryptedBody> {
    const key=this.ensureKey(conversationId),nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);
    const data=Buffer.concat([cipher.update(body,'utf8'),cipher.final(),cipher.getAuthTag()]);
    return {ciphertext:data.toString('base64url'),nonce:nonce.toString('base64url'),keyVersion:1};
  }
  private decrypt(conversationId:string,body:EncryptedBody) {
    const key=this.keys.get(conversationId); if(!key) throw new Error('conversation key unavailable');
    const nonce=Buffer.from(body.nonce,'base64url'),raw=Buffer.from(body.ciphertext,'base64url'),tag=raw.subarray(raw.length-16),data=raw.subarray(0,-16);
    const dec=crypto.createDecipheriv('aes-256-gcm',key,nonce);dec.setAuthTag(tag);return Buffer.concat([dec.update(data),dec.final()]).toString('utf8');
  }
  async handleServerFrame(frame:any) {
    if(!frame||typeof frame.conversationId!=='string') return;
    if(frame.kind==='linked_chat_cloud_result') {
      const content=this.decrypt(frame.conversationId,frame);
      await ConversationMessagesModel.append({id:frame.messageId,conversation_id:frame.conversationId,role:'assistant',content,source:'cloud-fallback',routed_to:'cloud',created_at:frame.createdAt});
      return;
    }
    if(frame.kind!=='linked_chat_reply'||!this.dispatcher) return;
    const content=this.decrypt(frame.conversationId,frame);
    await ConversationMessagesModel.append({id:frame.replyId,conversation_id:frame.conversationId,role:'user',content,source:'cloud-linked',routed_to:'desktop'});
    const complete=async(result:Record<string,unknown>)=>{
      if(result.type!=='done'||typeof result.content!=='string') return;
      const encrypted=await this.encrypt(frame.conversationId,result.content);
      await cloudRequest('POST',`/cloud-chat-links/${encodeURIComponent(frame.linkId)}/replies/${encodeURIComponent(frame.replyId)}/complete`,{headers:{'Content-Type':'application/json'},body:JSON.stringify({messageId:typeof result.messageId==='string'?result.messageId:crypto.randomUUID(),...encrypted})});
    };
    await this.dispatcher({type:'chat',conversationId:frame.conversationId,userMessageId:frame.replyId,messages:[{role:'user',content}]},f=>{void complete(f)},f=>{void complete(f)});
  }
  async link(conversationId:string,title:string,privacyMode:LinkPrivacyMode){if(privacyMode==='encrypted_bodies')this.ensureKey(conversationId);const deviceId=await getDesktopDeviceId();const r=await cloudRequest('POST','/cloud-chat-links',{headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId,remoteConversationId:conversationId,title,privacyMode})});if(!r.ok)throw new Error(`Link failed (${r.status})`);return r.json()}
  async getLink(conversationId:string) {
    const r=await cloudRequest('GET','/cloud-chat-links');if(!r.ok)return null;
    const payload=await r.json() as any;
    return ((payload.data?.conversations??[]) as Link[]).find(link=>link.remote_conversation_id===conversationId)??null;
  }
  async linkAll() {
    const conversations=await ConversationHistoryModel.getRecent(2000);
    for(const conversation of conversations) {
      const id=conversation.thread_id||conversation.id;
      try { await this.link(id,conversation.title||'New conversation','encrypted_bodies'); } catch(err) { console.warn(`[ConversationSync] could not link ${id}:`,err); }
    }
  }
  async unlink(linkId:string,deleteCloudCopy=false){const r=await cloudRequest('DELETE',`/cloud-chat-links/${encodeURIComponent(linkId)}?deleteCloudCopy=${deleteCloudCopy}`);if(!r.ok)throw new Error(`Unlink failed (${r.status})`)}
  async syncNow(){const r=await cloudRequest('GET','/cloud-chat-links');if(!r.ok)return;const payload=await r.json() as any;for(const link of (payload.data?.conversations??[]) as Link[]){let before:string|number|undefined;const pending:any[]=[];do{const rows=await ConversationMessagesModel.list(link.remote_conversation_id,{limit:250,beforeSeq:before,includeDeleted:true});pending.unshift(...rows.filter(m=>Number(m.seq)>Number(link.upload_cursor)));before=rows.length===250?rows[0].seq:undefined}while(before);for(let i=0;i<pending.length;i+=100){const items=(await Promise.all(pending.slice(i,i+100).map(m=>safeDelta(m,link.privacy_mode,body=>this.encrypt(link.remote_conversation_id,body))))).filter(Boolean);if(!items.length)continue;const pushed=await cloudRequest('POST',`/cloud-chat-links/${encodeURIComponent(link.id)}/deltas`,{headers:{'Content-Type':'application/json'},body:JSON.stringify({items})});if(!pushed.ok){console.warn(`[ConversationSync] delta rejected (${pushed.status})`);break}}}}
}
export const ConversationSyncService=new ConversationSyncServiceImpl();
