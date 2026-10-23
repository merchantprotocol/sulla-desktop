import type { ConversationMessageRecord } from '@pkg/agent/database/models/ConversationMessagesModel';

export type LinkPrivacyMode = 'encrypted_bodies' | 'metadata_only';
export interface EncryptedBody { ciphertext:string; nonce:string; keyVersion:number }
export interface SafeDelta { id:string; cursor:number; role:'user'|'assistant'; createdAt:string; ciphertext?:string; nonce?:string; keyVersion?:number }

/** Only user/assistant text is eligible. Tool, reasoning, parts, attachments and metadata never cross this boundary. */
export async function safeDelta(message:ConversationMessageRecord, mode:LinkPrivacyMode, encrypt?:(body:string)=>Promise<EncryptedBody>):Promise<SafeDelta|null>{
 if(message.deleted_at || (message.role!=='user'&&message.role!=='assistant')) return null;
 const base={id:message.id,cursor:Number(message.seq),role:message.role,createdAt:message.created_at};
 if(mode==='metadata_only') return base;
 if(!message.content || !encrypt) return null;
 return {...base,...await encrypt(message.content)};
}
