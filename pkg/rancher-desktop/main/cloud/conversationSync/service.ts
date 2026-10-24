import crypto from 'crypto';
import type { JsonWebKey as NodeJsonWebKey } from 'crypto';
import fs from 'fs';
import path from 'path';
import { app, safeStorage } from 'electron';

import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { ConversationMessagesModel } from '@pkg/agent/database/models/ConversationMessagesModel';
import { ConversationHistoryModel } from '@pkg/agent/database/models/ConversationHistoryModel';
import Logging from '@pkg/utils/logging';
import { cloudRequest } from '../cloudFetch';
import { getCloudPreferences } from '../cloudSettings';
import { getDesktopDeviceId } from '../../deviceIdentity';
import { normalizeMobileContent, persistMobileAttachments, transcriptText } from '../../mobileRelayContent';
import { safeDelta, type EncryptedBody, type LinkPrivacyMode } from './privacy';

const console = Logging.background;
type Role = 'user' | 'assistant';
type Link = { id:string; remote_conversation_id:string; privacy_mode:LinkPrivacyMode; upload_cursor:number };
type CloudResult = { id:string; clientRequestId:string; ciphertext:string; nonce:string; keyVersion:number; messageId:string; responseCiphertext:string; responseNonce:string; responseKeyVersion:number; createdAt:string; completedAt:string };
type Dispatch = (body:Record<string, any>, reply:(frame:Record<string, unknown>)=>void, respond:(frame:Record<string, unknown>)=>void)=>Promise<void>;

/** Must match the browser (www js/cloud/chat/chat.js). Binds each body to its conversation, role and message id. */
const aad = (conversationId:string, role:Role, messageId:string) => Buffer.from(`sulla-linked-chat-v1|${ conversationId }|${ role }|${ messageId }`, 'utf8');
/** D1 datetime('now') is UTC without a zone. */
const utc = (v:string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${ v.replace(' ', 'T') }Z`);

class ConversationSyncServiceImpl {
  private timer:ReturnType<typeof setInterval>|null = null;
  private keys = new Map<string, Buffer>();
  // Conversations this Desktop has ever linked. "Link all" only auto-links
  // conversations that are not in here, so an explicit unlink sticks.
  private linked = new Set<string>();
  private dispatcher:Dispatch|null = null;
  private syncing:Promise<void>|null = null;

  start() { if (this.timer) return; this.loadKeys(); this.timer=setInterval(()=>this.syncNow().catch(e=>console.warn('[ConversationSync] sync failed:',e)),30_000); void this.syncNow().catch(() => undefined); }
  stop() { if(this.timer) clearInterval(this.timer); this.timer=null; }
  setDispatcher(fn:Dispatch) { this.dispatcher=fn; }

  // ── Keys (OS-sealed, never uploaded) ─────────────────────────
  private keyPath() { return path.join(app.getPath('userData'),'cloud-conversation-keys.json'); }
  private loadKeys() {
    if(!safeStorage.isEncryptionAvailable()) return;
    try {
      const file=JSON.parse(fs.readFileSync(this.keyPath(),'utf8')) as { keys?:Record<string,string>; linked?:string[] } & Record<string,unknown>;
      const rows=(file.keys ?? file) as Record<string,unknown>;
      for(const [id,sealed] of Object.entries(rows)) if(typeof sealed==='string') this.keys.set(id,Buffer.from(safeStorage.decryptString(Buffer.from(sealed,'base64')),'base64'));
      for(const id of file.linked ?? []) this.linked.add(id);
    } catch { /* first run or corrupt file: links stay unavailable rather than exposing plaintext */ }
  }
  private saveKeys() {
    if(!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage is unavailable');
    const keys:Record<string,string>={};
    for(const [id,key] of this.keys) keys[id]=safeStorage.encryptString(key.toString('base64')).toString('base64');
    const file=this.keyPath(), tmp=`${file}.tmp`;
    fs.writeFileSync(tmp,JSON.stringify({ keys, linked:[...this.linked] }),{mode:0o600}); fs.renameSync(tmp,file);
  }
  private ensureKey(conversationId:string) {
    let key=this.keys.get(conversationId);
    if(!key){key=crypto.randomBytes(32);this.keys.set(conversationId,key);this.saveKeys();}
    return key;
  }
  wrapKey(conversationId:string, publicJwk:JsonWebKey) {
    const publicKey=crypto.createPublicKey({key:publicJwk as NodeJsonWebKey,format:'jwk'});
    return crypto.publicEncrypt({key:publicKey,oaepHash:'sha256'},this.ensureKey(conversationId)).toString('base64');
  }
  private encrypt(conversationId:string, role:Role, messageId:string, body:string):EncryptedBody {
    const key=this.ensureKey(conversationId),nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);
    cipher.setAAD(aad(conversationId,role,messageId));
    const data=Buffer.concat([cipher.update(body,'utf8'),cipher.final(),cipher.getAuthTag()]);
    return {ciphertext:data.toString('base64url'),nonce:nonce.toString('base64url'),keyVersion:1};
  }
  private decryptBytes(conversationId:string, role:Role, messageId:string, body:{ciphertext:string;nonce:string}) {
    const key=this.keys.get(conversationId); if(!key) throw new Error('conversation key unavailable');
    const nonce=Buffer.from(body.nonce,'base64url'),raw=Buffer.from(body.ciphertext,'base64url'),tag=raw.subarray(raw.length-16),data=raw.subarray(0,-16);
    const dec=crypto.createDecipheriv('aes-256-gcm',key,nonce);dec.setAAD(aad(conversationId,role,messageId));dec.setAuthTag(tag);
    return Buffer.concat([dec.update(data),dec.final()]);
  }
  private decrypt(conversationId:string, role:Role, messageId:string, body:{ciphertext:string;nonce:string}) { return this.decryptBytes(conversationId,role,messageId,body).toString('utf8'); }

  private async messageExists(id:string) {
    return !!(await postgresClient.queryOne('SELECT 1 FROM conversation_messages WHERE id = $1 LIMIT 1',[id]));
  }

  // ── Frames the relay pushes for this Desktop (ciphertext only) ──
  async handleServerFrame(frame:any) {
    if(!frame||typeof frame.conversationId!=='string'||typeof frame.linkId!=='string') return;
    const prefs=await getCloudPreferences();
    if(frame.kind==='linked_chat_sync') { void this.syncNow().catch(() => undefined); return; }
    // A linked reply runs the local agent, so it needs the same remote-access
    // consent as a paired browser command.
    if(frame.kind!=='linked_chat_reply'||typeof frame.replyId!=='string'||typeof frame.clientRequestId!=='string') return;
    const fail=()=>cloudRequest('POST',`/cloud-chat-links/${encodeURIComponent(frame.linkId)}/replies/${encodeURIComponent(frame.replyId)}/fail`).catch(() => undefined);
    if(!this.dispatcher||!prefs.remoteAccess){ await fail(); return; }
    // The AAD binds the body to clientRequestId; refusing a known id stops replays.
    if(await this.messageExists(frame.clientRequestId)) return;
    let content:string, dispatchContent:unknown, parts:unknown = undefined;
    try {
      const plaintext=this.decrypt(frame.conversationId,'user',frame.clientRequestId,frame);
      let envelope:any=null; try { envelope=JSON.parse(plaintext); } catch { /* legacy text */ }
      if(envelope?.v===1&&Array.isArray(envelope.attachments)) {
        const hydrated:any[]=[];
        for(const ref of envelope.attachments.slice(0,6)) {
          const response=await cloudRequest('GET',`/cloud-chat-links/${encodeURIComponent(frame.linkId)}/attachments/${encodeURIComponent(ref.id)}`);if(!response.ok)throw new Error('attachment unavailable');
          const remote=(await response.json() as any).data?.attachment;if(!remote?.ciphertext)throw new Error('attachment unavailable');
          const data=this.decryptBytes(frame.conversationId,'user',ref.id,remote).toString('base64');
          hydrated.push({type:ref.kind==='image'?'image':'document',source:{type:'base64',media_type:ref.mimeType,data},...(ref.kind==='document'?{title:ref.name}:{})});
        }
        const turn=normalizeMobileContent([...(envelope.text?[{type:'text',text:envelope.text}]:[]),...hydrated]);
        const saved=await persistMobileAttachments(path.join(app.getPath('userData'),'chat-attachments','cloud'),frame.conversationId,frame.clientRequestId,turn.files);
        content=transcriptText(turn); dispatchContent=[...(envelope.text?[{type:'text',text:envelope.text}]:[]),...hydrated];
        parts=envelope.attachments.map((a:any,i:number)=>({id:a.id||`${frame.clientRequestId}-${i}`,name:a.name||turn.files[i]?.name||'attachment',size:a.size||0,kind:a.kind==='image'?'image':'file',source:saved[i]}));
      } else { content=plaintext; dispatchContent=content; }
    }
    catch { console.warn('[ConversationSync] rejected a linked reply that does not decrypt'); await fail(); return; }
    await ConversationMessagesModel.append({id:frame.clientRequestId,conversation_id:frame.conversationId,role:'user',content,parts,source:'cloud-linked',routed_to:'desktop'});
    let settled=false;
    const complete=async(result:Record<string,unknown>)=>{
      if(settled) return;
      if(result.type==='error'||result.type==='stopped'){ settled=true; await fail(); return; }
      if(result.type!=='done'||typeof result.content!=='string'||!result.content) return;
      settled=true;
      const messageId=typeof result.id==='string'&&result.id?result.id:crypto.randomUUID();
      // Upload the real turns first so the browser sees them when the reply completes.
      await this.syncNow().catch(() => undefined);
      await cloudRequest('POST',`/cloud-chat-links/${encodeURIComponent(frame.linkId)}/replies/${encodeURIComponent(frame.replyId)}/complete`,{headers:{'Content-Type':'application/json'},body:JSON.stringify({messageId,...this.encrypt(frame.conversationId,'assistant',messageId,result.content)})});
    };
    const onFrame=(f:Record<string,unknown>)=>{ void complete(f).catch(err=>console.warn('[ConversationSync] completion failed:',err)); };
    await this.dispatcher({type:'chat',conversationId:frame.conversationId,userMessageId:frame.clientRequestId,messages:[{role:'user',content:dispatchContent}],...(frame.selection?.providerId?{providerId:frame.selection.providerId}:{}),...(frame.selection?.modelId?{modelId:frame.selection.modelId}:{}),...(frame.selection?.agentId?{agentId:frame.selection.agentId}:{})},onFrame,onFrame);
  }

  // ── Links ────────────────────────────────────────────────────
  async link(conversationId:string,title:string,privacyMode:LinkPrivacyMode){
    if(privacyMode==='encrypted_bodies')this.ensureKey(conversationId);
    const deviceId=await getDesktopDeviceId();
    const r=await cloudRequest('POST','/cloud-chat-links',{headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId,remoteConversationId:conversationId,title,privacyMode})});
    if(!r.ok)throw new Error(`Link failed (${r.status})`);
    if(!this.linked.has(conversationId)){this.linked.add(conversationId);try{this.saveKeys()}catch{/* OS storage unavailable: encrypted links already failed above */}}
    void this.syncNow().catch(() => undefined);
    return r.json();
  }
  async getLink(conversationId:string) {
    const r=await cloudRequest('GET','/cloud-chat-links');if(!r.ok)return null;
    const payload=await r.json() as any;
    return ((payload.data?.conversations??[]) as Link[]).find(link=>link.remote_conversation_id===conversationId)??null;
  }
  /** Explicit "Link all conversations": links every chat, including previously unlinked ones. */
  async linkAll() { await this.linkConversations(false); }
  private async linkConversations(onlyNew:boolean,limit=onlyNew?50:2000) {
    const conversations=await ConversationHistoryModel.getRecent(limit,'chat');
    for(const conversation of conversations) {
      if(onlyNew&&this.linked.has(conversation.id)) continue;
      try { await this.link(conversation.id,conversation.title||'New conversation','encrypted_bodies'); } catch(err) { console.warn(`[ConversationSync] could not link ${conversation.id}:`,err); }
    }
  }
  async unlink(linkId:string,deleteCloudCopy=false){const r=await cloudRequest('DELETE',`/cloud-chat-links/${encodeURIComponent(linkId)}?deleteCloudCopy=${deleteCloudCopy}`);if(!r.ok)throw new Error(`Unlink failed (${r.status})`)}

  // ── Sync ─────────────────────────────────────────────────────
  private historyLinked=false;
  syncNow():Promise<void> {
    if(!this.syncing) this.syncing=this.runSync().finally(()=>{this.syncing=null});
    return this.syncing;
  }
  private async runSync(){
    { const prefs=await getCloudPreferences(); if(!prefs.enabled||!prefs.conversations)return; }
    // Profile › Conversations links every chat: the first pass after start
    // covers the whole history, later passes only pick up new chats.
    await this.linkConversations(true,this.historyLinked?50:2000);this.historyLinked=true;
    const r=await cloudRequest('GET','/cloud-chat-links');if(!r.ok)return;
    const payload=await r.json() as any;
    for(const link of (payload.data?.conversations??[]) as Link[]){
      const conv=link.remote_conversation_id;
      if(link.privacy_mode==='encrypted_bodies') await this.pullCloudResults(link).catch(err=>console.warn('[ConversationSync] cloud results failed:',err));
      let before:string|number|undefined;const pending:any[]=[];
      do{const rows=await ConversationMessagesModel.list(conv,{limit:250,beforeSeq:before,includeDeleted:true});pending.unshift(...rows.filter(m=>Number(m.seq)>Number(link.upload_cursor)));before=rows.length===250&&Number(rows[0].seq)>Number(link.upload_cursor)?rows[0].seq:undefined}while(before);
      for(let i=0;i<pending.length;i+=100){
        const items=(await Promise.all(pending.slice(i,i+100).map(m=>safeDelta(m,link.privacy_mode,async body=>this.encrypt(conv,m.role,m.id,body))))).filter(Boolean);
        if(!items.length)continue;
        const pushed=await cloudRequest('POST',`/cloud-chat-links/${encodeURIComponent(link.id)}/deltas`,{headers:{'Content-Type':'application/json'},body:JSON.stringify({items})});
        if(!pushed.ok){console.warn(`[ConversationSync] delta rejected (${pushed.status})`);break}
      }
    }
  }
  /** Append confirmed Cloud-fallback turns that ran while this Desktop was offline, then ack them. */
  private async pullCloudResults(link:Link) {
    const conv=link.remote_conversation_id;
    if(!this.keys.has(conv)) return;
    const r=await cloudRequest('GET',`/cloud-chat-links/${encodeURIComponent(link.id)}/cloud-results`);if(!r.ok)return;
    const results=((await r.json() as any).data?.results??[]) as CloudResult[];
    for(const x of results){
      let user:string,assistant:string;
      try {
        user=this.decrypt(conv,'user',x.clientRequestId,x);
        assistant=this.decrypt(conv,'assistant',x.messageId,{ciphertext:x.responseCiphertext,nonce:x.responseNonce});
      } catch { console.warn(`[ConversationSync] skipped a Cloud result that does not decrypt (${x.id})`); continue; }
      await ConversationMessagesModel.appendMany([
        {id:x.clientRequestId,conversation_id:conv,role:'user',content:user,source:'cloud-linked',routed_to:'cloud',created_at:utc(x.createdAt)},
        {id:x.messageId,conversation_id:conv,role:'assistant',content:assistant,source:'cloud-fallback',routed_to:'cloud',created_at:utc(x.completedAt||x.createdAt)},
      ]);
      await cloudRequest('POST',`/cloud-chat-links/${encodeURIComponent(link.id)}/cloud-results/${encodeURIComponent(x.id)}/ack`);
    }
  }
}
export const ConversationSyncService=new ConversationSyncServiceImpl();
