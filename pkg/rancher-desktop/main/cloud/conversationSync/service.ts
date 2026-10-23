import { ConversationMessagesModel } from '@pkg/agent/database/models/ConversationMessagesModel';
import Logging from '@pkg/utils/logging';
import { cloudRequest } from '../cloudFetch';
import { getDesktopDeviceId } from '../../deviceIdentity';
import { safeDelta, type EncryptedBody, type LinkPrivacyMode } from './privacy';

const console=Logging.background;
type Link={id:string;remote_conversation_id:string;privacy_mode:LinkPrivacyMode;upload_cursor:number};
class ConversationSyncServiceImpl {
 private timer:ReturnType<typeof setInterval>|null=null; private encryptors=new Map<string,(body:string)=>Promise<EncryptedBody>>();
 start(){if(this.timer)return;this.timer=setInterval(()=>this.syncNow().catch(e=>console.warn('[ConversationSync] sync failed:',e)),30_000);void this.syncNow()}
 stop(){if(this.timer)clearInterval(this.timer);this.timer=null}
 setEncryptor(conversationId:string,fn:(body:string)=>Promise<EncryptedBody>){this.encryptors.set(conversationId,fn)}
 clearEncryptor(conversationId:string){this.encryptors.delete(conversationId)}
 async link(conversationId:string,title:string,privacyMode:LinkPrivacyMode){const deviceId=await getDesktopDeviceId();const r=await cloudRequest('POST','/cloud-chat-links',{headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId,remoteConversationId:conversationId,title,privacyMode})});if(!r.ok)throw new Error(`Link failed (${r.status})`);return r.json()}
 async unlink(linkId:string,deleteCloudCopy=false){const r=await cloudRequest('DELETE',`/cloud-chat-links/${encodeURIComponent(linkId)}?deleteCloudCopy=${deleteCloudCopy}`);if(!r.ok)throw new Error(`Unlink failed (${r.status})`)}
 async syncNow(){const r=await cloudRequest('GET','/cloud-chat-links');if(!r.ok)return;const payload=await r.json() as any;for(const link of (payload.data?.conversations??[]) as Link[]){const rows=await ConversationMessagesModel.list(link.remote_conversation_id,{limit:250});const fresh=rows.filter(m=>Number(m.seq)>Number(link.upload_cursor));const items=(await Promise.all(fresh.map(m=>safeDelta(m,link.privacy_mode,this.encryptors.get(link.remote_conversation_id))))).filter(Boolean);if(!items.length)continue;const pushed=await cloudRequest('POST',`/cloud-chat-links/${encodeURIComponent(link.id)}/deltas`,{headers:{'Content-Type':'application/json'},body:JSON.stringify({items})});if(!pushed.ok)console.warn(`[ConversationSync] delta rejected (${pushed.status})`)}}
}
export const ConversationSyncService=new ConversationSyncServiceImpl();
