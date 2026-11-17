import { describe, expect, it } from 'vitest';
import { OrgCollectionSyncDriver } from '../OrgCollectionSyncDriver';

class FakeDirectory {
  constructor(public orgs: Array<{ orgId: string; name: string; memberCount: number }> = []) {}
  async refresh() { return this.orgs; }
}

class FakeCloud {
  constructor(public rows: Array<{ collection: any; effectiveLevel: 'none' | 'view' | 'edit' | 'manage' }> = []) {}
  async collections(_orgId?: string) { return { collections: this.rows }; }
  async getCollectionKeyWrap(_orgId: string, collectionId: string) { return { orgId: 'org-1', collectionId, keyVersion: 1 }; }
}

class FakeKeyring {
  readonly calls: string[] = [];
  root = new Uint8Array(32).fill(9);
  async ensureRecipientKey(orgId: string) { this.calls.push(`recipient:${orgId}`); }
  async wrapPendingMembers(orgId: string) { this.calls.push(`pending:${orgId}`); return []; }
  async unwrapCollectionRoot() { return new Uint8Array(this.root); }
}

class FakeFiles {
  entries: any[] = [];
  calls: string[] = [];
  handedOffRoot?: Uint8Array;
  async list() { return this.entries; }
  async enroll(entry: any) { this.calls.push(`enroll:${entry.id}`); this.entries.push(entry); }
  async updateLevel(id: string, level: string) { this.calls.push(`level:${id}:${level}`); }
  async unenroll(id: string) { this.calls.push(`unenroll:${id}`); }
  async pushRoot(id: string, version: number, root: Uint8Array) { this.calls.push(`root:${id}:${version}`); this.handedOffRoot = root; }
  async enableSync(id: string, version: number) { this.calls.push(`sync:${id}:${version}`); }
}

const collection = (id: string, level: 'none' | 'view' | 'edit' | 'manage' = 'view') => ({
  collection: { collectionId: id, name: 'Shared', creatorUserId: 'creator', keyVersion: 1 }, effectiveLevel: level,
});

describe('OrgCollectionSyncDriver', () => {
  it('enrolls visible collections, hands off their root, enables sync, then zeros root bytes', async () => {
    // risk: key custody — transport handoff must not leave an unwrapped root buffer in Desktop memory.
    const files = new FakeFiles(); const keyring = new FakeKeyring();
    const driver = new OrgCollectionSyncDriver(new FakeDirectory([{ orgId: 'org-1', name: 'Acme', memberCount: 2 }]) as never,
      new FakeCloud([collection('collection-1')]) as never, keyring as never, files as never);
    await driver.tick();
    expect(files.calls).toEqual(['enroll:collection-1', 'root:collection-1:1', 'sync:collection-1:1']);
    expect([...files.handedOffRoot!]).toEqual(new Array(32).fill(0));
  });

  it('updates changed levels and unenrolls collections whose Cloud grants are none or vanished', async () => {
    // risk: authorization — local access must be revoked when Cloud removes visibility or changes a grant to none.
    const files = new FakeFiles(); files.entries = [
      { id: 'changed', orgId: 'org-1', level: 'view' }, { id: 'revoked', orgId: 'org-1', level: 'view' }, { id: 'vanished', orgId: 'org-1', level: 'view' },
    ];
    const driver = new OrgCollectionSyncDriver(new FakeDirectory([{ orgId: 'org-1', name: 'Acme', memberCount: 2 }]) as never,
      new FakeCloud([collection('changed', 'edit'), collection('revoked', 'none')]) as never,
      new FakeKeyring() as never, files as never);
    await driver.tick();
    expect(files.calls).toContain('level:changed:edit');
    expect(files.calls).toContain('unenroll:revoked');
    expect(files.calls).toContain('unenroll:vanished');
  });

  it('isolates an organization failure so later organizations still reconcile', async () => {
    // risk: availability — one org's Cloud outage must not starve another org's file sync.
    const files = new FakeFiles();
    const cloud = new FakeCloud([collection('second')]);
    const driver = new OrgCollectionSyncDriver(new FakeDirectory([
      { orgId: 'org-1', name: 'First', memberCount: 2 }, { orgId: 'org-2', name: 'Second', memberCount: 2 },
    ]) as never, cloud as never, new FakeKeyring() as never, files as never);
    cloud.collections = async (orgId: string) => { if (orgId === 'org-1') throw new Error('offline'); return { collections: [collection('second')] }; };
    await driver.tick();
    expect(files.calls).toContain('enroll:second');
  });

  it('isolates a collection failure so later collections in the same org still reconcile', async () => {
    // risk: availability — a malformed or inaccessible collection must not block the rest of its organization.
    const files = new FakeFiles(); const cloud = new FakeCloud([collection('broken'), collection('healthy')]);
    cloud.getCollectionKeyWrap = async (_orgId: string, id: string) => {
      if (id === 'broken') throw new Error('wrap unavailable');
      return { orgId: 'org-1', collectionId: id, keyVersion: 1 };
    };
    const driver = new OrgCollectionSyncDriver(new FakeDirectory([{ orgId: 'org-1', name: 'Acme', memberCount: 2 }]) as never,
      cloud as never, new FakeKeyring() as never, files as never);
    await driver.tick();
    expect(files.calls).toContain('enroll:healthy');
  });
});
