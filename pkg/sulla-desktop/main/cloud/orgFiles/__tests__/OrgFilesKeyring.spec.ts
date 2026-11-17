import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OrgFilesKeyCipher, OrgFilesRecipientKeyPayload, type OrgFilesKeyWrap, type OrgFilesRecipientKey } from '@sulla/domain';
import { OrgFilesKeyring } from '../OrgFilesKeyring';
import { OrgFilesRecipientKeyStore, type OrgFilesVaultKeyStore } from '../OrgFilesRecipientKeyStore';

class MemoryVault implements OrgFilesVaultKeyStore {
  readonly items = new Map<string, JsonWebKey>();
  async read(key: string) { return this.items.get(key) ?? null; }
  async write(key: string, value: JsonWebKey) { this.items.set(key, value); }
}

class FakeOrgFilesCloud {
  keys: OrgFilesRecipientKey[] = [];
  wraps: OrgFilesKeyWrap[] = [];
  pending = { userIds: ['member-2'], keyVersion: 1 };
  async publishRecipientKey(_orgId: string, key: OrgFilesRecipientKey) { this.keys = [...this.keys.filter(old => old.userId !== key.userId), key]; }
  async recipientKeys() { return { keys: this.keys }; }
  async myKeyWraps(_orgId: string, version?: number) { return { wraps: this.wraps.filter(wrap => !version || wrap.keyVersion === version) }; }
  async putKeyWraps(_orgId: string, wraps: OrgFilesKeyWrap[]) { this.wraps.push(...wraps); }
  async pendingKeyWraps() { return this.pending; }
}

const randomBytes = (size: number) => webcrypto.getRandomValues(new Uint8Array(size));
const makeCipher = () => new OrgFilesKeyCipher(webcrypto.subtle, randomBytes);

describe('OrgFilesKeyring', () => {
  it('generates each user/org key once and stores private JWK only in Vault', async () => {
    // risk: private-key custody — a regression must not persist recipient private material outside the Vault.
    const vault = new MemoryVault(); const cloud = new FakeOrgFilesCloud(); let generated = 0;
    const subtle = new Proxy(webcrypto.subtle, { get(target, property) { if (property === 'generateKey') return (...args: Parameters<SubtleCrypto['generateKey']>) => { generated++; return target.generateKey(...args); }; const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
    const cryptoPort = { subtle } as Crypto;
    const store = new OrgFilesRecipientKeyStore(vault, cloud, cryptoPort,
      async () => ({ userId: 'member-1', deviceId: 'device-1' }), async () => 'signature');
    const first = await store.ensure('org-1'); const second = await store.ensure('org-1');
    expect(generated).toBe(1);
    expect(vault.items.size).toBe(1);
    expect([...vault.items.values()][0].d).toBeTruthy();
    expect(first.keyId).toBe(second.keyId);
    expect(cloud.keys).toHaveLength(1);
  });

  it('signs the canonical recipient payload before publishing', async () => {
    // risk: key authenticity — Cloud must receive a device signature over the canonical public-key identity.
    const vault = new MemoryVault(); const cloud = new FakeOrgFilesCloud(); let signed = '';
    const store = new OrgFilesRecipientKeyStore(vault, cloud, webcrypto,
      async () => ({ userId: 'member-1', deviceId: 'device-1' }), async payload => { signed = payload; return 'device-proof'; },
      () => '2026-11-17T00:00:00.000Z');
    const key = await store.ensure('org-1');
    expect(signed).toBe(new OrgFilesRecipientKeyPayload(key).canonical());
    expect(key.signature).toBe('device-proof');
  });

  it('unwraps an actual org key to its recipient and wraps pending members', async () => {
    // risk: org-key confidentiality — only the intended Vault-held recipient private key can unwrap K_org.
    const vault = new MemoryVault(); const cloud = new FakeOrgFilesCloud(); const cipher = makeCipher();
    const store = new OrgFilesRecipientKeyStore(vault, cloud, webcrypto,
      async () => ({ userId: 'member-1', deviceId: 'device-1' }), async () => 'proof');
    const own = await store.ensure('org-1');
    const otherStore = new OrgFilesRecipientKeyStore(new MemoryVault(), cloud, webcrypto,
      async () => ({ userId: 'member-2', deviceId: 'device-2' }), async () => 'proof');
    await otherStore.ensure('org-1');
    const keyring = new OrgFilesKeyring(cloud as never, store, cipher, async () => true,
      { userId: async () => 'member-1' });
    const original = await keyring.createOrgKeyIfMissing('org-1');
    const received = await new OrgFilesKeyring(cloud as never, store, cipher, undefined,
      { userId: async () => 'member-1' }).getOrgKey('org-1', 1);
    expect(Buffer.from(received)).toEqual(Buffer.from(original));
    const pendingWraps = await keyring.wrapPendingMembers('org-1');
    expect(pendingWraps.map(wrap => wrap.recipientUserId)).toEqual(['member-2']);
    expect(cloud.wraps.some(wrap => wrap.recipientUserId === 'member-2')).toBe(true);
  });

  it('drops cached org key bytes on lock', async () => {
    // risk: key lifecycle — a locked session must discard every in-memory org key.
    const vault = new MemoryVault(); const cloud = new FakeOrgFilesCloud(); const cipher = makeCipher();
    const store = new OrgFilesRecipientKeyStore(vault, cloud, webcrypto,
      async () => ({ userId: 'member-1', deviceId: 'device-1' }), async () => 'proof');
    await store.ensure('org-1');
    const keyring = new OrgFilesKeyring(cloud as never, store, cipher, undefined,
      { userId: async () => 'member-1' });
    await keyring.createOrgKeyIfMissing('org-1');
    keyring.onLock();
    cloud.wraps = [];
    await expect(keyring.getOrgKey('org-1', 1)).rejects.toThrow('No Org Files key wrap available');
  });
});
