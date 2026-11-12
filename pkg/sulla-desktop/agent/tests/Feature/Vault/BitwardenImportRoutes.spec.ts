// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Bitwarden import on the Desktop vault (M3 S5). Drives the real
// LocalVaultAuthority methods behind POST /v1/human/import/bitwarden[/preview]
// with real item encryption. Only the Postgres item and audit repositories are
// replaced, through their constructor ports. The encrypted fixture is the
// synthetic KAT shipped by @sulla/domain (sulla-core PR #53), copied verbatim.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_AGENT_POLICY, decryptItemText, type VaultItemPlaintext } from '@sulla/vault-crypto';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { LocalVaultAuthority, LocalVaultError } from '../../../../../../services/sulla-vault/src/localAuthority';

const kat = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/bitwarden-encrypted-kat.json'), 'utf8'));

interface StoredRow { id:string; owner_user_id:string; item_type:string; ciphertext:any; encrypted_item_key:any; agent_policy:unknown }
type ImportInput = { content:string; format:'json'|'csv'|'zip'; password?:string };

/** In-memory stand-in for the two PostgresVaultItemRepository queries the import uses. */
class InMemoryImportItems {
  readonly rows:StoredRow[] = [];
  async listOwnedActiveForImport<T>(values:unknown[]):Promise<{ rows:T[]; rowCount:number }> {
    const rows = this.rows.filter(row => row.owner_user_id === values[0]);
    return { rows:rows as unknown as T[], rowCount:rows.length };
  }
  async insertImportedItem(values:unknown[]):Promise<{ rows:never[]; rowCount:number }> {
    const [id, owner_user_id, item_type, ciphertext, encrypted_item_key, agent_policy] = values as [string, string, string, unknown, unknown, unknown];
    this.rows.push({ id, owner_user_id, item_type, ciphertext, encrypted_item_key, agent_policy });
    return { rows:[], rowCount:1 };
  }
}

class InMemoryAudit {
  readonly actions:string[] = [];
  async recordHumanAction(values:unknown[]):Promise<{ rows:never[]; rowCount:number }> {
    this.actions.push(String(values[2]));
    return { rows:[], rowCount:1 };
  }
}

class BitwardenImportFixture {
  readonly userId = 'user-1';
  readonly items = new InMemoryImportItems();
  readonly audit = new InMemoryAudit();
  private readonly userKey = new Uint8Array(randomBytes(32));
  private readonly authority:LocalVaultAuthority;

  constructor() {
    const token = () => randomBytes(32).toString('hex');
    const config = { mode:'desktop', brokerServiceId:'broker', brokerServiceToken:token(), bootstrapServiceToken:token(), controlServiceToken:token(), approvalServiceToken:token(), filesServiceToken:token() };
    const client = { query:async() => ({ rows:[], rowCount:0 }), release:() => undefined };
    const database = { query:async() => ({ rows:[], rowCount:0 }), connect:async() => client };
    this.authority = new LocalVaultAuthority(database as never, config as never, undefined, undefined, this.items as never, this.audit as never);
    Object.assign(this.authority as object, {
      keys:{ userId:this.userId, publicKey:'pk', userKey:this.userKey, privateKey:new Uint8Array(32) },
      humanSessions:new Map([['session', { csrf:'csrf', expiresAt:Date.now() + 60_000, phase:'unlocked' }]]),
    });
  }

  preview(input:ImportInput) { return this.authority.previewBitwardenImport('session', 'csrf', input); }
  import(input:ImportInput) { return this.authority.importBitwarden('session', 'csrf', input); }

  /** Decrypts everything the import wrote, in insertion order. */
  async stored():Promise<VaultItemPlaintext[]> {
    return Promise.all(this.items.rows.map(async row => JSON.parse(await decryptItemText({ version:1, ciphertext:row.ciphertext, encryptedItemKey:row.encrypted_item_key }, this.userKey, { itemId:row.id, ownerId:row.owner_user_id }))));
  }

  /** The error the route would serialize: the app error handler sends LocalVaultError as { error: code } with its status. */
  async failure(input:ImportInput, method:'preview'|'import' = 'import'):Promise<{ code:string; status:unknown; routed:boolean }> {
    try { await this[method](input); } catch (error) {
      return { code:(error as { code:string }).code, status:(error as { status?:number }).status, routed:error instanceof LocalVaultError };
    }
    throw new Error('import was accepted');
  }
}

const plainJson = ():ImportInput => ({ content:JSON.stringify(kat.expectedExport), format:'json' });
const pbkdf2Json = (password = kat.password):ImportInput => ({ content:JSON.stringify(kat.encryptedExport), format:'json', password });
const argon2Json = (password = kat.password):ImportInput => ({ content:JSON.stringify(kat.argon2EncryptedExport), format:'json', password });
const zip = (password = kat.password):ImportInput => ({
  content:Buffer.from(zipSync({ 'export/data.json':strToU8(JSON.stringify(kat.argon2EncryptedExport)), 'attachments/attachment-synthetic/synthetic.txt':strToU8('synthetic') })).toString('base64'),
  format:'zip', password,
});
const csv = (rows:string[]):ImportInput => ({ content:['folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp', ...rows].join('\n'), format:'csv' });

/** The two KAT items exactly as Desktop stores them today. */
async function expectKatItemsStored(fixture:BitwardenImportFixture):Promise<void> {
  const [login, ssh] = await fixture.stored();
  expect(login).toMatchObject({ type:'login', name:'Synthetic Login', username:'synthetic-user', password:'synthetic-password', folder:'Synthetic', uris:[{ uri:'https://example.invalid', match:'exact' }] });
  expect(login.sourceMetadata).toMatchObject({ source:'bitwarden', sourceId:'login-synthetic', folderId:'folder-synthetic' });
  expect(ssh).toMatchObject({ type:'sshKey', name:'Synthetic SSH', sshKey:{ privateKey:'SYNTHETIC PRIVATE KEY', publicKey:'ssh-ed25519 SYNTHETIC', fingerprint:'SHA256:SYNTHETIC' } });
  // risk: permissions — imported secrets start private to the owner; no agent may use them until the owner widens access.
  for (const item of [login, ssh]) expect(item.agentPolicy).toEqual(DEFAULT_AGENT_POLICY);
  for (const row of fixture.items.rows) expect(row.agent_policy).toEqual(DEFAULT_AGENT_POLICY);
  // risk: secret duplication — the import must not keep a second raw copy of the secrets in provenance.
  for (const item of [login, ssh]) for (const key of ['login', 'card', 'identity', 'sshKey', 'secureNote', 'fields']) expect(item.sourceMetadata).not.toHaveProperty(key);
  expect(fixture.audit.actions).toContain('human_bitwarden_import');
}

describe('Desktop vault Bitwarden import', () => {
  // risk: data accuracy — every supported export format must land the same items.
  it.each([
    ['unencrypted JSON', plainJson],
    ['PBKDF2 password-protected JSON', () => pbkdf2Json()],
    ['Argon2id password-protected JSON', () => argon2Json()],
    ['ZIP with a password-protected JSON', () => zip()],
  ])('imports %s', async(_label, input) => {
    const fixture = new BitwardenImportFixture();
    const preview = await fixture.preview(input());
    expect(preview).toMatchObject({ total:2, importable:2, duplicates:0, counts:{ login:1, sshKey:1 }, unmapped:[] });
    expect(fixture.items.rows).toHaveLength(0);
    expect(await fixture.import(input())).toMatchObject({ imported:2, duplicates:0 });
    await expectKatItemsStored(fixture);
  });

  // risk: data loss — a ZIP export's attachment files are stored inside the imported item, as the
  // pre-domain Desktop importer did: attachment.data = base64 file bytes, attachment.zipPath = entry path.
  it.each([
    ['a password-protected', () => kat.argon2EncryptedExport],
    ['an unencrypted', () => kat.expectedExport],
  ])('inlines attachment bytes from %s ZIP export', async(_label, exported) => {
    const bytes = new Uint8Array(4096).map((_, index) => (index * 31) % 251); // binary and compressible: stored deflated
    const second = { id:'attachment-second', fileName:'second.bin', size:String(bytes.length) };
    const data = structuredClone(exported());
    if (!data.encrypted) data.items[0].attachments.push(second);
    const content = Buffer.from(zipSync({
      'export/data.json':strToU8(JSON.stringify(data)),
      'attachments/login-synthetic/attachment-synthetic/synthetic.txt':strToU8('synthetic'),
      'attachments/login-synthetic/attachment-second/second.bin':bytes,
      'attachments/unrelated/readme.txt':strToU8('not referenced'),
    })).toString('base64');
    const fixture = new BitwardenImportFixture();
    expect(await fixture.import({ content, format:'zip', password:kat.password })).toMatchObject({ imported:2 });
    const [login, ssh] = await fixture.stored();
    const attachments = (login.sourceMetadata as { attachments?:unknown[] }).attachments;
    const expected = [{ id:'attachment-synthetic', fileName:'synthetic.txt', size:'9', data:Buffer.from('synthetic').toString('base64'), zipPath:'attachments/login-synthetic/attachment-synthetic/synthetic.txt' }];
    if (!data.encrypted) expected.push({ ...second, data:Buffer.from(bytes).toString('base64'), zipPath:'attachments/login-synthetic/attachment-second/second.bin' });
    expect(attachments).toEqual(expected);
    expect((ssh.sourceMetadata as { attachments?:unknown }).attachments).toBeUndefined();
  });

  // risk: data accuracy — an attachment listed in the export but missing from the ZIP keeps its metadata only.
  it('keeps metadata for an attachment the ZIP does not carry', async() => {
    const content = Buffer.from(zipSync({ 'data.json':strToU8(JSON.stringify(kat.expectedExport)) })).toString('base64');
    const fixture = new BitwardenImportFixture();
    await fixture.import({ content, format:'zip' });
    const [login] = await fixture.stored();
    expect((login.sourceMetadata as { attachments?:unknown[] }).attachments).toEqual([{ id:'attachment-synthetic', fileName:'synthetic.txt', size:'9' }]);
  });

  // risk: data accuracy — CSV columns and Desktop's `name:value` custom field lines.
  it('imports a Bitwarden CSV', async() => {
    const fixture = new BitwardenImportFixture();
    const result = await fixture.import(csv(['Work,1,login,Example Mail,a note,"pin:1234\nregion:us",0,https://mail.example.com,ada@example.com,csv-password,', ',,note,Example Note,secret note,,0,,,,']));
    expect(result).toMatchObject({ total:2, imported:2, counts:{ login:1, note:1 } });
    const [login, note] = await fixture.stored();
    expect(login).toMatchObject({ type:'login', name:'Example Mail', username:'ada@example.com', password:'csv-password', notes:'a note', uris:[{ uri:'https://mail.example.com' }] });
    expect(login.customFields?.map(field => [field.label, field.value])).toEqual([['pin', '1234'], ['region', 'us']]);
    expect(note).toMatchObject({ type:'note', name:'Example Note', notes:'secret note' });
  });

  // risk: authentication — a wrong export password is refused with wrong_password and imports nothing.
  it.each([
    ['PBKDF2 JSON', () => pbkdf2Json('wrong-password')],
    ['Argon2id JSON', () => argon2Json('wrong-password')],
    ['ZIP', () => zip('wrong-password')],
  ])('refuses a wrong password for %s with wrong_password', async(_label, input) => {
    const fixture = new BitwardenImportFixture();
    expect(await fixture.failure(input(), 'preview')).toEqual({ code:'wrong_password', status:400, routed:true });
    expect(await fixture.failure(input())).toEqual({ code:'wrong_password', status:400, routed:true });
    expect(fixture.items.rows).toHaveLength(0);
    expect(fixture.audit.actions).toHaveLength(0);
  });

  // risk: authentication — missing password and account-restricted exports keep their codes.
  it('keeps the password_required, account_restricted and invalid_export codes', async() => {
    const fixture = new BitwardenImportFixture();
    expect((await fixture.failure(pbkdf2Json(''))).code).toBe('password_required');
    expect((await fixture.failure({ content:JSON.stringify({ ...kat.encryptedExport, passwordProtected:false }), format:'json' })).code).toBe('account_restricted');
    expect(await fixture.failure({ content:'not json', format:'json' })).toEqual({ code:'invalid_export', status:400, routed:true });
    expect(fixture.items.rows).toHaveLength(0);
  });

  // risk: duplicate writes — importing the same export twice adds nothing the second time.
  it.each([
    ['JSON', plainJson],
    ['CSV', () => csv(['Work,0,login,Example Mail,,,0,https://mail.example.com,ada@example.com,csv-password,'])],
  ])('skips every item of a repeated %s import', async(_label, input) => {
    const fixture = new BitwardenImportFixture();
    const first = await fixture.import(input());
    const second = await fixture.import(input());
    expect(second).toMatchObject({ total:first.total, duplicates:first.total, importable:0, imported:0 });
    expect(fixture.items.rows).toHaveLength(first.imported);
  });

  // risk: data loss — CSV rows carry no Bitwarden id, so different CSV files must never dedupe against each other by row position.
  it('imports every row of a second, different CSV', async() => {
    const fixture = new BitwardenImportFixture();
    await fixture.import(csv(['Work,0,login,First,,,0,https://one.example.com,one@example.com,pw-one,']));
    const second = await fixture.import(csv(['Work,0,login,Second,,,0,https://two.example.com,two@example.com,pw-two,', 'Work,0,login,Third,,,0,https://three.example.com,three@example.com,pw-three,']));
    expect(second).toMatchObject({ total:2, duplicates:0, imported:2 });
    expect((await fixture.stored()).map(item => item.name)).toEqual(['First', 'Second', 'Third']);
  });

  // risk: duplicate writes — identical rows inside one CSV are imported once.
  it('imports identical rows inside one CSV once', async() => {
    const fixture = new BitwardenImportFixture();
    const row = 'Work,0,login,Same,,,0,https://same.example.com,same@example.com,pw-same,';
    expect(await fixture.import(csv([row, row]))).toMatchObject({ total:2, duplicates:1, imported:1 });
    expect(fixture.items.rows).toHaveLength(1);
  });

  // risk: duplicate writes — an item Desktop already holds (same Bitwarden id) is skipped across formats.
  it('dedupes an encrypted re-export of items already imported unencrypted', async() => {
    const fixture = new BitwardenImportFixture();
    await fixture.import(plainJson());
    expect(await fixture.import(argon2Json())).toMatchObject({ duplicates:2, imported:0 });
    expect(fixture.items.rows).toHaveLength(2);
  });
});
