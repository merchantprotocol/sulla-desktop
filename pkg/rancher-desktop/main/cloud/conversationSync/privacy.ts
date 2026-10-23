import type { ConversationMessageRecord } from '@pkg/agent/database/models/ConversationMessagesModel';

export type LinkPrivacyMode = 'encrypted_bodies' | 'metadata_only';
export interface EncryptedBody { ciphertext:string; nonce:string; keyVersion:number }
export interface SafeDelta { id:string; cursor:number; role:'user'|'assistant'; createdAt:string; deleted?:boolean; ciphertext?:string; nonce?:string; keyVersion?:number }

// Hidden reasoning ('thinking'), in-flight 'streaming' text and 'html' artifacts
// are stored with role 'assistant' too, so the role alone is not a boundary.
const SHAREABLE_KINDS=new Set(['user','sulla','proactive']);

/** Only user/assistant text is eligible. Tool, reasoning, parts, attachments and metadata never cross this boundary. */
export async function safeDelta(message:ConversationMessageRecord, mode:LinkPrivacyMode, encrypt?:(body:string)=>Promise<EncryptedBody>):Promise<SafeDelta|null>{
 if(message.role!=='user'&&message.role!=='assistant') return null;
 if(message.kind && !SHAREABLE_KINDS.has(message.kind)) return null;
 const base={id:message.id,cursor:Number(message.seq),role:message.role,createdAt:message.created_at};
 if(message.deleted_at) return {...base,deleted:true};
 if(mode==='metadata_only') return base;
 if(!message.content || !encrypt) return null;
 return {...base,...await encrypt(message.content)};
}
