import { describe, expect, it } from 'vitest';
import { OrgCollectionCreator } from '../OrgCollectionCreator';

class FakeCloud {
  readonly calls: string[] = [];
  failure?: Error & { status?: number };
  async createCollection(orgId: string) { this.calls.push(`cloud:${orgId}`); if (this.failure) throw this.failure; return { collections: [] }; }
}

class FakeKeyring {
  readonly calls: string[] = [];
  async createOrgKeyIfMissing(orgId: string) { this.calls.push(`org-key:${orgId}`); return new Uint8Array(32).fill(7); }
  async wrapCollectionRoot(_orgId: string, root: Uint8Array, context: unknown) { this.calls.push(`wrap:${(context as { collectionId: string }).collectionId}`); return { rootLength: root.length }; }
}

class FakeFiles {
  readonly calls: string[] = [];
  handedOffRoot?: Uint8Array;
  async enroll(value: { id: string; level: string }) { this.calls.push(`enroll:${value.id}:${value.level}`); }
  async pushRoot(id: string, _version: number, root: Uint8Array) { this.calls.push(`root:${id}`); this.handedOffRoot = root; }
  async enableSync(id: string) { this.calls.push(`sync:${id}`); }
}

describe('OrgCollectionCreator', () => {
  it('creates in Cloud before local manage enrollment and zeros root material after handoff', async () => {
    // risk: key custody and authorization — Cloud creation precedes local exposure; generated root bytes are zeroed.
    const cloud = new FakeCloud(); const keyring = new FakeKeyring(); const files = new FakeFiles();
    const creator = new OrgCollectionCreator(cloud as never, keyring as never, files as never,
      { userId: async () => 'creator-1' }, () => 'collection-1', globalThis.crypto);
    const result = await creator.create({ orgId: 'org-1', orgName: 'Acme', name: 'Shared' });
    expect(result).toEqual({ collectionId: 'collection-1', path: '/mnt/sulla-files/Organizations/Acme/Shared' });
    expect(cloud.calls).toEqual(['cloud:org-1']);
    expect(files.calls).toEqual(['enroll:collection-1:manage', 'root:collection-1', 'sync:collection-1']);
    expect([...files.handedOffRoot!]).toEqual(new Array(32).fill(0));
  });

  it('returns an actionable non-admin message for forbidden Cloud creation', async () => {
    // risk: authorization — only org owners/admins may create shared collections.
    const cloud = new FakeCloud(); cloud.failure = Object.assign(new Error('denied'), { status: 404 });
    const files = new FakeFiles();
    const creator = new OrgCollectionCreator(cloud as never, new FakeKeyring() as never, files as never,
      { userId: async () => 'member-1' }, () => 'collection-2', globalThis.crypto);
    await expect(creator.create({ orgId: 'org-1', orgName: 'Acme', name: 'Shared' }))
      .rejects.toThrow('Only an org owner or admin can create a shared collection');
    expect(files.calls).toEqual([]);
  });
});
