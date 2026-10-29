// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { mayInjectSecretIntoAgentCode, resolveLlmAccess, AGENT_PROTECTED_PROPERTIES } from '../vaultAccessPolicy';
import { createCipheriv, createHmac, pbkdf2Sync } from 'node:crypto';

import { decryptBitwardenExport, mapBitwardenExport, parseCSV } from '../vaultImportParsers';

describe('parseCSV', () => {
  it('keeps multi-line quoted notes in one record (old line splitter shifted passwords)', () => {
    const csv = [
      'name,login_uri,login_username,login_password,notes',
      '"Bank","https://bank.example","me","p,a""ss","line one',
      'line two, with comma"',
      'Mail,https://mail.example,me2,pw2,',
    ].join('\r\n');

    expect(parseCSV(`${ String.fromCharCode(0xFEFF) }${ csv }\r\n`)).toEqual([
      ['name', 'login_uri', 'login_username', 'login_password', 'notes'],
      ['Bank', 'https://bank.example', 'me', 'p,a"ss', 'line one\r\nline two, with comma'],
      ['Mail', 'https://mail.example', 'me2', 'pw2', ''],
    ]);
  });

  it('handles blank lines, lone CR, and a missing trailing newline', () => {
    expect(parseCSV('a,b\n\n1,2\r3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('parses 10k rows quickly', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => `site${ i },"u${ i }","p""${ i }","n\n${ i }"`);
    const started = Date.now();
    const out = parseCSV(`name,user,pass,notes\n${ rows.join('\n') }`);

    expect(out).toHaveLength(10_001);
    expect(out[5000]).toEqual(['site4999', 'u4999', 'p"4999', 'n\n4999']);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('Bitwarden import',()=>{
  const synthetic={encrypted:false,folders:[{id:'f1',name:'Finance'}],items:[
    {id:'login',type:1,name:'Synthetic login',folderId:'f1',favorite:true,reprompt:1,creationDate:'2026-01-01T00:00:00Z',revisionDate:'2026-02-01T00:00:00Z',organizationId:'org',collectionIds:['collection'],notes:'synthetic',fields:[{name:'hidden',value:'not-real',type:1}],passwordHistory:[{password:'old-not-real',lastUsedDate:'2025-01-01T00:00:00Z'}],login:{username:'person@example.invalid',password:'not-real',totp:'JBSWY3DPEHPK3PXP',uris:[{uri:'https://one.example.invalid',match:3},{uri:'https://two.example.invalid',match:1}],fido2Credentials:[{credentialId:'synthetic',keyType:'public-key'}]}},
    {id:'note',type:2,name:'Synthetic note',notes:'not-real note'},{id:'card',type:3,name:'Synthetic card',card:{number:'4111111111111111',code:'000'}},{id:'identity',type:4,name:'Synthetic identity',identity:{firstName:'Example',email:'person@example.invalid'}},{id:'ssh',type:5,name:'Synthetic SSH',sshKey:{privateKey:'synthetic-private',publicKey:'synthetic-public',keyFingerprint:'synthetic-fingerprint'}},
  ]};
  it('maps every item type and preserves the complete source payload',()=>{const entries=mapBitwardenExport(synthetic);expect(entries.map(entry=>entry.type)).toEqual(['login','note','card','identity','sshKey']);expect(JSON.parse(entries[0].properties.uris)).toHaveLength(2);expect(JSON.parse(entries[0].properties.passkeys)[0].credentialId).toBe('synthetic');expect(JSON.parse(entries[0].properties.bitwarden_source_json).fields).toHaveLength(1);expect(entries[0].folder).toBe('Finance');});
  it('decrypts password-protected PBKDF2 JSON and rejects a wrong password without leaking contents',async()=>{const password='synthetic export password',salt=Buffer.alloc(16,7),key=pbkdf2Sync(password,salt,100_000,32,'sha256'),expand=(info:string)=>createHmac('sha256',key).update(info).update(Buffer.from([1])).digest(),enc=expand('enc'),mac=expand('mac'),seal=(plain:string)=>{const iv=Buffer.alloc(16,9),cipher=createCipheriv('aes-256-cbc',enc,iv),body=Buffer.concat([cipher.update(plain),cipher.final()]),tag=createHmac('sha256',mac).update(iv).update(body).digest();return `2.${iv.toString('base64')}|${body.toString('base64')}|${tag.toString('base64')}`};const exported={encrypted:true,passwordProtected:true,salt:salt.toString('base64'),kdfType:0,kdfIterations:100_000,encKeyValidation_DO_NOT_EDIT:seal('validation'),data:seal(JSON.stringify(synthetic))};expect((await decryptBitwardenExport(exported,password)).items).toHaveLength(5);await expect(decryptBitwardenExport(exported,'wrong')).rejects.toMatchObject({code:'wrong_password'});});
  it('explains account-restricted encrypted JSON',async()=>{await expect(decryptBitwardenExport({encrypted:true,passwordProtected:false})).rejects.toEqual(expect.objectContaining({code:'account_restricted'}));});
});

describe('vault access policy', () => {
  it('agents may not write llm_access', () => {
    expect(AGENT_PROTECTED_PROPERTIES.has('llm_access')).toBe(true);
  });

  it('defaults unknown levels to autofill', () => {
    expect(resolveLlmAccess(undefined)).toBe('autofill');
    expect(resolveLlmAccess('FULL')).toBe('autofill');
    expect(resolveLlmAccess('full')).toBe('full');
  });

  it.each([
    ['website', 'none', false],
    ['website', 'metadata', false],
    ['website', 'autofill', false],
    ['website', 'full', true],
    ['github', 'none', false],
    ['github', 'metadata', false],
    ['github', 'autofill', true],
    ['github', 'full', true],
  ] as const)('%s at %s → inject=%s', (integration, level, allowed) => {
    expect(mayInjectSecretIntoAgentCode(integration, level)).toBe(allowed);
  });
});
