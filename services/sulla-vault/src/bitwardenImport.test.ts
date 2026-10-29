// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, createHmac, pbkdf2Sync } from 'node:crypto';
import { mapBitwardenExport, parseBitwardenCsv, readBitwardenJson, BitwardenImportError } from './bitwardenImport.js';

const synthetic = { folders:[{id:'folder-1',name:'Finance'}], items:[
  {id:'1',type:1,name:'Synthetic login',folderId:'folder-1',favorite:true,reprompt:1,creationDate:'2026-01-01T00:00:00Z',revisionDate:'2026-02-01T00:00:00Z',organizationId:'org-1',collectionIds:['collection-1'],notes:'synthetic',fields:[{name:'hidden',value:'not-real',type:1},{name:'flag',value:'true',type:2},{name:'linked',value:'100',type:3}],passwordHistory:[{password:'old-not-real',lastUsedDate:'2025-01-01T00:00:00Z'}],login:{username:'person@example.invalid',password:'not-real',totp:'JBSWY3DPEHPK3PXP',uris:[{uri:'https://example.invalid',match:3}],fido2Credentials:[{credentialId:'synthetic-id',keyType:'public-key',keyAlgorithm:'ECDSA'}]}},
  {id:'2',type:2,name:'Synthetic note',notes:'not real'}, {id:'3',type:3,name:'Synthetic card',card:{cardholderName:'Example Person',brand:'Visa',number:'4111111111111111',expMonth:'01',expYear:'2030',code:'000'}},
  {id:'4',type:4,name:'Synthetic identity',identity:{firstName:'Example',lastName:'Person',email:'person@example.invalid'}}, {id:'5',type:5,name:'Synthetic SSH',sshKey:{privateKey:'synthetic-private',publicKey:'synthetic-public',keyFingerprint:'synthetic-fingerprint'}},
]};

test('maps every Bitwarden item type and lossless metadata', () => { const result=mapBitwardenExport(synthetic); assert.deepEqual(result.counts,{login:1,note:1,card:1,identity:1,sshKey:1}); assert.equal(result.unmapped.length,0); const login=result.items[0]; assert.equal(login.folder,'Finance'); assert.equal(login.passkeys?.[0].credentialId,'synthetic-id'); assert.equal(login.customFields?.[2].type,'linked'); assert.deepEqual(login.sourceMetadata?.collectionIds,['collection-1']); });
test('maps Bitwarden CSV', () => { const result=parseBitwardenCsv('folder,favorite,type,name,notes,fields,login_uri,login_username,login_password,login_totp\n,1,login,Synthetic CSV,,kind:value,https://example.invalid,user,not-real,JBSWY3DPEHPK3PXP'); assert.equal(result.total,1); assert.equal(result.items[0].username,'user'); });

function encryptedExport(password:string) { const salt=Buffer.alloc(16,7), master=pbkdf2Sync(password,salt,100_000,32,'sha256'); const expand=(info:string)=>createHmac('sha256',master).update(info).update(Buffer.from([1])).digest(),encKey=expand('enc'),macKey=expand('mac'); const seal=(plain:string)=>{const iv=Buffer.alloc(16,9),cipher=createCipheriv('aes-256-cbc',encKey,iv),body=Buffer.concat([cipher.update(plain),cipher.final()]),mac=createHmac('sha256',macKey).update(iv).update(body).digest();return `2.${iv.toString('base64')}|${body.toString('base64')}|${mac.toString('base64')}`;}; return JSON.stringify({encrypted:true,passwordProtected:true,salt:salt.toString('base64'),kdfType:0,kdfIterations:100_000,encKeyValidation_DO_NOT_EDIT:seal('validation'),data:seal(JSON.stringify(synthetic))}); }
test('decrypts password-protected PBKDF2 export without exposing contents in errors', async()=>{assert.equal((await readBitwardenJson(encryptedExport('synthetic-password'),'synthetic-password')).items.length,5); await assert.rejects(()=>readBitwardenJson(encryptedExport('synthetic-password'),'wrong'),(e:BitwardenImportError)=>e.code==='wrong_password'&&!e.message.includes('not-real'));});
test('rejects account-restricted encrypted exports with actionable message', async()=>{await assert.rejects(()=>readBitwardenJson(JSON.stringify({encrypted:true,passwordProtected:false,data:'opaque'})),(e:BitwardenImportError)=>e.code==='account_restricted'&&e.message.includes('password-protected'));});
