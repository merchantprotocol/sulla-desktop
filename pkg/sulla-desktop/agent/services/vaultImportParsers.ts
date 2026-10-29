// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createDecipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import { argon2id } from 'hash-wasm';

/**
 * RFC 4180 CSV parser for password-manager exports. Unlike a line splitter it
 * keeps quoted fields intact when they contain commas, doubled quotes, or
 * newlines (multi-line notes are common in Bitwarden/1Password exports and
 * would otherwise shift passwords into the wrong columns).
 *
 * Returns non-empty records; each field is trimmed of surrounding whitespace.
 */
export function parseCSV(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    record.push(field.trim());
    field = '';
  };
  const endRecord = () => {
    endField();
    if (record.length > 1 || record[0] !== '') records.push(record);
    record = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      endRecord();
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else {
      field += ch;
    }
    i++;
  }
  if (field !== '' || record.length > 0) endRecord();

  return records;
}

export class BitwardenImportError extends Error {
  constructor(public readonly code: 'invalid_export'|'password_required'|'wrong_password'|'account_restricted', message: string) { super(message) }
}

export interface BitwardenImportEntry {
  sourceId: string; type: 'login'|'note'|'card'|'identity'|'sshKey'; label: string;
  url: string; username: string; password: string; notes: string; totp: string; folder: string;
  properties: Record<string,string>;
}

type Json = Record<string, any>;
const b64 = (value:string) => Buffer.from(value,'base64');

async function bitwardenMasterKey(password:string,input:Json):Promise<Buffer>{
  const salt=b64(String(input.salt||''));
  if(salt.length<8)throw new BitwardenImportError('invalid_export','The encrypted Bitwarden export has an invalid salt.');
  if(Number(input.kdfType)===0){const iterations=Number(input.kdfIterations);if(!Number.isSafeInteger(iterations)||iterations<5_000||iterations>10_000_000)throw new BitwardenImportError('invalid_export','The encrypted Bitwarden export has invalid PBKDF2 settings.');return pbkdf2Sync(password,salt,iterations,32,'sha256');}
  if(Number(input.kdfType)===1){const iterations=Number(input.kdfIterations),memoryMb=Number(input.kdfMemory),parallelism=Number(input.kdfParallelism);if(![iterations,memoryMb,parallelism].every(Number.isSafeInteger)||iterations<1||iterations>20||memoryMb<8||memoryMb>1024||parallelism<1||parallelism>16)throw new BitwardenImportError('invalid_export','The encrypted Bitwarden export has invalid Argon2id settings.');return Buffer.from(await argon2id({password,salt,iterations,memorySize:memoryMb*1024,parallelism,hashLength:32,outputType:'binary'}));}
  throw new BitwardenImportError('invalid_export','The encrypted Bitwarden export uses an unsupported key derivation method.');
}

function decryptBitwardenString(value:unknown,key:Buffer):string{
  if(typeof value!=='string')throw new BitwardenImportError('invalid_export','The encrypted Bitwarden export is missing its data.');
  const match=/^2\.([^|]+)\|([^|]+)\|([^|]+)$/.exec(value);if(!match)throw new BitwardenImportError('invalid_export','The encrypted Bitwarden export has an unsupported cipher format.');
  const expand=(info:string)=>createHmac('sha256',key).update(info).update(Buffer.from([1])).digest(),enc=expand('enc'),mac=expand('mac'),iv=b64(match[1]),ciphertext=b64(match[2]),expected=b64(match[3]),actual=createHmac('sha256',mac).update(iv).update(ciphertext).digest();
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new BitwardenImportError('wrong_password','The Bitwarden export password is incorrect.');
  try{const decipher=createDecipheriv('aes-256-cbc',enc,iv);return Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');}catch{throw new BitwardenImportError('wrong_password','The Bitwarden export password is incorrect.');}
}

export async function decryptBitwardenExport(input:Json,password?:string):Promise<Json>{
  if(input?.encrypted!==true)return input;
  if(input.passwordProtected!==true)throw new BitwardenImportError('account_restricted','This account-restricted Bitwarden export can only be opened by Bitwarden. Export again as password-protected JSON or plain JSON.');
  if(!password)throw new BitwardenImportError('password_required','Enter the password used to protect this Bitwarden export.');
  const key=await bitwardenMasterKey(password,input);if(input.encKeyValidation_DO_NOT_EDIT)decryptBitwardenString(input.encKeyValidation_DO_NOT_EDIT,key);
  try{return JSON.parse(decryptBitwardenString(input.data,key));}catch(error){if(error instanceof BitwardenImportError)throw error;throw new BitwardenImportError('invalid_export','The decrypted Bitwarden export is invalid.');}
}

/** Bitwarden ZIP export reader. Secret contents stay in memory and are never logged or written. */
export async function readBitwardenZip(zip:Buffer,password?:string):Promise<Json>{
  if(zip.length<22||zip.length>25*1024*1024)throw new BitwardenImportError('invalid_export','Choose a valid Bitwarden ZIP export.');
  const end=zip.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));if(end<0)throw new BitwardenImportError('invalid_export','Choose a valid Bitwarden ZIP export.');
  const entries=zip.readUInt16LE(end+10),central=zip.readUInt32LE(end+16);let offset=central,json:Json|undefined;const files=new Map<string,string>();
  for(let i=0;i<entries;i++){if(zip.readUInt32LE(offset)!==0x02014b50)throw new BitwardenImportError('invalid_export','The Bitwarden ZIP directory is invalid.');const method=zip.readUInt16LE(offset+10),compressedSize=zip.readUInt32LE(offset+20),expandedSize=zip.readUInt32LE(offset+24),nameLength=zip.readUInt16LE(offset+28),extraLength=zip.readUInt16LE(offset+30),commentLength=zip.readUInt16LE(offset+32),local=zip.readUInt32LE(offset+42),name=zip.subarray(offset+46,offset+46+nameLength).toString('utf8');if(expandedSize>20*1024*1024)throw new BitwardenImportError('invalid_export','A Bitwarden ZIP entry is too large.');const localName=zip.readUInt16LE(local+26),localExtra=zip.readUInt16LE(local+28),start=local+30+localName+localExtra,compressed=zip.subarray(start,start+compressedSize),data=method===0?compressed:method===8?inflateRawSync(compressed):null;if(!data)throw new BitwardenImportError('invalid_export','The Bitwarden ZIP uses an unsupported compression method.');if(/(^|\/)data\.json$/i.test(name)||/(^|\/)bitwarden.*\.json$/i.test(name)){let parsed:Json;try{parsed=JSON.parse(data.toString('utf8'))}catch{throw new BitwardenImportError('invalid_export','The Bitwarden ZIP contains invalid JSON.')}json=await decryptBitwardenExport(parsed,password);}else if(!name.endsWith('/'))files.set(name,data.toString('base64'));offset+=46+nameLength+extraLength+commentLength;}
  if(!json)throw new BitwardenImportError('invalid_export','The ZIP does not contain a Bitwarden JSON export.');for(const item of Array.isArray(json.items)?json.items:[]){for(const attachment of Array.isArray(item.attachments)?item.attachments:[]){const id=String(attachment.id??'');const match=[...files].find(([path])=>id&&path.includes(id));if(match){attachment.data=match[1];attachment.zipPath=match[0];}}}return json;
}

export function mapBitwardenExport(input:Json):BitwardenImportEntry[]{
  if(!Array.isArray(input?.items))throw new BitwardenImportError('invalid_export','The Bitwarden export has no items list.');
  const folders=new Map((Array.isArray(input.folders)?input.folders:[]).map((folder:Json)=>[String(folder.id),String(folder.name??'')]));
  return input.items.map((item:Json,index:number)=>{
    const type=({1:'login',2:'note',3:'card',4:'identity',5:'sshKey'} as Record<number,BitwardenImportEntry['type']>)[Number(item.type)];
    if(!type)throw new BitwardenImportError('invalid_export',`Bitwarden item ${index+1} has an unsupported type.`);
    const folder=folders.get(String(item.folderId))??''; const login=item.login??{}; const uris=Array.isArray(login.uris)?login.uris:[];
    const properties:Record<string,string>={
      bitwarden_type:type,bitwarden_source_id:String(item.id??''),bitwarden_source_json:JSON.stringify({...item,folderName:folder}),
      favorite:String(item.favorite===true),folder,uris:JSON.stringify(uris),custom_fields:JSON.stringify(Array.isArray(item.fields)?item.fields:[]),password_history:JSON.stringify(Array.isArray(item.passwordHistory)?item.passwordHistory:[]),
      reprompt:String(item.reprompt??0),created_at:String(item.creationDate??''),revised_at:String(item.revisionDate??''),deleted_at:String(item.deletedDate??''),organization_id:String(item.organizationId??''),collection_ids:JSON.stringify(Array.isArray(item.collectionIds)?item.collectionIds:[]),
    };
    if(type==='login'){properties.passkeys=JSON.stringify(Array.isArray(login.fido2Credentials)?login.fido2Credentials:[]);properties.totp=String(login.totp??'');}
    if(type==='card')properties.card=JSON.stringify(item.card??{});
    if(type==='identity')properties.identity=JSON.stringify(item.identity??{});
    if(type==='sshKey')properties.ssh_key=JSON.stringify(item.sshKey??{});
    return {sourceId:String(item.id??index),type,label:String(item.name??''),url:String(uris[0]?.uri??''),username:String(login.username??''),password:String(login.password??''),notes:String(item.notes??''),totp:String(login.totp??''),folder,properties};
  });
}
