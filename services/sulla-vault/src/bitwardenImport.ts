// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createDecipheriv, createHmac, hkdfSync, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { argon2id } from 'hash-wasm';

import { DEFAULT_AGENT_POLICY, type UriMatch, type VaultItemPlaintext } from '@sulla/vault-crypto';

export class BitwardenImportError extends Error {
  constructor(public readonly code: 'invalid_export'|'password_required'|'wrong_password'|'account_restricted', message: string) { super(message); }
}

type Json = Record<string, any>;
export interface BitwardenImportPreview { counts: Record<string, number>; total: number; unmapped: Array<{ sourceId?: string; reason: string }>; warnings: string[] }
export interface BitwardenImportResult extends BitwardenImportPreview { items: VaultItemPlaintext[] }

const b64 = (value: string) => Buffer.from(value, 'base64');

async function deriveMasterKey(password: string, input: Json): Promise<Buffer> {
  const salt = b64(String(input.salt || ''));
  if (salt.length < 8) throw new BitwardenImportError('invalid_export', 'The encrypted export has an invalid salt.');
  if (Number(input.kdfType) === 0) {
    const iterations = Number(input.kdfIterations);
    if (!Number.isSafeInteger(iterations) || iterations < 5_000 || iterations > 10_000_000) throw new BitwardenImportError('invalid_export', 'The encrypted export has invalid PBKDF2 settings.');
    return pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  }
  if (Number(input.kdfType) === 1) {
    const iterations = Number(input.kdfIterations), memorySize = Number(input.kdfMemory), parallelism = Number(input.kdfParallelism);
    if (![iterations, memorySize, parallelism].every(Number.isSafeInteger) || iterations < 1 || iterations > 20 || memorySize < 8 || memorySize > 1024 || parallelism < 1 || parallelism > 16) {
      throw new BitwardenImportError('invalid_export', 'The encrypted export has invalid Argon2id settings.');
    }
    const binary = await argon2id({ password, salt, iterations, memorySize, parallelism, hashLength: 32, outputType: 'binary' });
    return Buffer.from(binary);
  }
  throw new BitwardenImportError('invalid_export', 'The encrypted export uses an unsupported key derivation method.');
}

function decryptEncString(value: unknown, masterKey: Buffer): string {
  if (typeof value !== 'string') throw new BitwardenImportError('invalid_export', 'The encrypted export is missing its data.');
  const match = /^2\.([^|]+)\|([^|]+)\|([^|]+)$/.exec(value);
  if (!match) throw new BitwardenImportError('invalid_export', 'The encrypted export has an unsupported cipher format.');
  const encKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'enc', 32));
  const macKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'mac', 32));
  const iv = b64(match[1]), ciphertext = b64(match[2]), expected = b64(match[3]);
  const actual = createHmac('sha256', macKey).update(iv).update(ciphertext).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new BitwardenImportError('wrong_password', 'The export password is incorrect.');
  try { const decipher = createDecipheriv('aes-256-cbc', encKey, iv); return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'); }
  catch { throw new BitwardenImportError('wrong_password', 'The export password is incorrect.'); }
}

export async function readBitwardenJson(raw: string, password?: string): Promise<Json> {
  let parsed: Json;
  try { parsed = JSON.parse(raw); } catch { throw new BitwardenImportError('invalid_export', 'Choose a valid Bitwarden JSON export.'); }
  if (!parsed?.encrypted) return parsed;
  if (parsed.passwordProtected !== true) throw new BitwardenImportError('account_restricted', 'Account-restricted Bitwarden exports can only be decrypted by the original Bitwarden account. Export again as password-protected JSON or unencrypted JSON.');
  if (!password) throw new BitwardenImportError('password_required', 'Enter the password used to protect this Bitwarden export.');
  const key = await deriveMasterKey(password, parsed);
  if (parsed.encKeyValidation_DO_NOT_EDIT) decryptEncString(parsed.encKeyValidation_DO_NOT_EDIT, key);
  try { return JSON.parse(decryptEncString(parsed.data, key)); } catch (error) {
    if (error instanceof BitwardenImportError) throw error;
    throw new BitwardenImportError('invalid_export', 'The decrypted export is not valid Bitwarden JSON.');
  }
}

const matchType = (value: unknown): UriMatch | undefined => ({ 0:'domain', 1:'host', 2:'startsWith', 3:'exact', 4:'never', 5:'domain' } as Record<number, UriMatch>)[Number(value)];
const strings = (value: unknown) => Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];
const cleanRecord = (value: unknown) => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value as Json : {}).filter(([,v]) => v !== undefined && v !== null).map(([k,v]) => [k, String(v)]));

function mapItem(raw: Json, folders: Map<string,string>): VaultItemPlaintext {
  const base: Omit<VaultItemPlaintext,'type'> = {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Untitled Bitwarden item', favorite: raw.favorite === true,
    notes: typeof raw.notes === 'string' ? raw.notes : undefined, folder: folders.get(raw.folderId), agentPolicy: { ...DEFAULT_AGENT_POLICY },
    customFields: Array.isArray(raw.fields) ? raw.fields.map((field: Json) => ({ id: randomUUID(), label: String(field.name || 'Custom field'), type: Number(field.type) === 1 ? 'password' : Number(field.type) === 2 ? 'boolean' : Number(field.type) === 3 ? 'linked' : 'text', value: String(field.value ?? ''), hidden: Number(field.type) === 1 })) : undefined,
    passwordHistory: Array.isArray(raw.passwordHistory) ? raw.passwordHistory.map((entry: Json) => ({ password: String(entry.password ?? ''), changedAt: String(entry.lastUsedDate ?? entry.changedAt ?? '') })) : undefined,
    sourceMetadata: { source: 'bitwarden', sourceId: raw.id, folderId: raw.folderId, organizationId: raw.organizationId, collectionIds: strings(raw.collectionIds), reprompt: raw.reprompt, createdAt: raw.creationDate, revisedAt: raw.revisionDate, deletedAt: raw.deletedDate, attachments: Array.isArray(raw.attachments) ? raw.attachments : undefined },
  };
  switch (Number(raw.type)) {
  case 1: return { ...base, type:'login', username: raw.login?.username, password: raw.login?.password, totp: raw.login?.totp, uris: Array.isArray(raw.login?.uris) ? raw.login.uris.map((u: Json) => ({ uri:String(u.uri ?? ''), ...(matchType(u.match) ? { match:matchType(u.match) } : {}) })) : undefined, passkeys: Array.isArray(raw.login?.fido2Credentials) ? raw.login.fido2Credentials : undefined };
  case 2: return { ...base, type:'note' };
  case 3: return { ...base, type:'card', card: { holder:raw.card?.cardholderName, brand:raw.card?.brand, number:raw.card?.number, expMonth:raw.card?.expMonth, expYear:raw.card?.expYear, code:raw.card?.code } };
  case 4: return { ...base, type:'identity', identity:cleanRecord(raw.identity) };
  case 5: return { ...base, type:'sshKey', sshKey:{ privateKey:raw.sshKey?.privateKey, publicKey:raw.sshKey?.publicKey, fingerprint:raw.sshKey?.keyFingerprint } };
  default: throw new BitwardenImportError('invalid_export', `Unsupported Bitwarden item type ${String(raw.type)}.`);
  }
}

export function mapBitwardenExport(input: Json): BitwardenImportResult {
  if (!Array.isArray(input?.items)) throw new BitwardenImportError('invalid_export', 'The Bitwarden export does not contain an items list.');
  const folders = new Map((Array.isArray(input.folders) ? input.folders : []).filter((f: Json) => typeof f?.id === 'string').map((f: Json) => [f.id, String(f.name ?? '')]));
  const items: VaultItemPlaintext[] = [], unmapped: BitwardenImportPreview['unmapped'] = [];
  for (const source of input.items) { try { items.push(mapItem(source, folders)); } catch (error) { unmapped.push({ sourceId:source?.id, reason:error instanceof Error ? error.message : 'Item could not be mapped' }); } }
  const counts: Record<string,number> = {}; for (const item of items) counts[item.type] = (counts[item.type] ?? 0) + 1;
  const warnings = items.some(item => item.sourceMetadata?.attachments?.length) ? ['Attachment metadata is preserved. Attachment file bytes must be included in a Bitwarden ZIP export to import them.'] : [];
  return { items, counts, total:items.length, unmapped, warnings };
}

export function parseBitwardenCsv(raw: string): BitwardenImportResult {
  const rows: string[][]=[]; let row:string[]=[], field='', quoted=false;
  for(let i=0;i<=raw.length;i++){const c=raw[i]??'\n';if(quoted){if(c==='"'&&raw[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=false;else field+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(field);field='';}else if(c==='\n'){row.push(field.replace(/\r$/,''));field='';if(row.some(Boolean))rows.push(row);row=[];}else field+=c;}
  const headers=(rows.shift()??[]).map(v=>v.trim()); const objects=rows.map(values=>Object.fromEntries(headers.map((h,i)=>[h,values[i]??''])));
  const input={ folders:[], items:objects.map((r:Json)=>({ type:r.type==='login'?1:2,name:r.name,notes:r.notes,login:{username:r.login_username,password:r.login_password,totp:r.login_totp,uris:r.login_uri?[{uri:r.login_uri}]:[]},favorite:String(r.favorite).toLowerCase()==='true',fields:r.fields?String(r.fields).split('\n').map((v:string)=>{const p=v.indexOf(':');return{name:p<0?'Field':v.slice(0,p),value:p<0?v:v.slice(p+1),type:0};}):[]})) };
  return mapBitwardenExport(input);
}
