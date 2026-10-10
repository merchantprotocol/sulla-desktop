/** @jest-environment node */
import { jest } from '@jest/globals';
import mockModules from '@pkg/utils/testUtils/mockModules';

import type { ChatArtifactRecord, ChatArtifactRevision } from '@pkg/shared/chatArtifacts';

mockModules({ electron: { webContents: { getAllWebContents: () => [] } } });
const { ChatArtifactService } = await import('../ChatArtifactService');

class MemoryStore {
  artifacts = new Map<string, ChatArtifactRecord>();
  revisions = new Map<string, ChatArtifactRevision[]>();
  nextId = 1;

  async list(threadId: string, includeClosed = false) {
    return [...this.artifacts.values()].filter(a => a.threadId === threadId && !a.isDeleted && (includeClosed || a.isOpen));
  }

  async get(threadId: string, idOrName: string, includeDeleted = false) {
    return [...this.artifacts.values()].find(a =>
      a.threadId === threadId &&
      (a.id === idOrName || a.name.toLowerCase() === idOrName.toLowerCase()) &&
      (includeDeleted || !a.isDeleted)) ?? null;
  }

  async create(input: any) {
    const now = new Date().toISOString();
    const artifact: ChatArtifactRecord = {
      id: `a${ this.nextId++ }`, threadId: input.threadId, name: input.name,
      kind: input.kind, content: input.content, status: input.status,
      isOpen: true, isDeleted: false, version: 1,
      language: input.language ?? null, path: input.path ?? null,
      createdAt: now, updatedAt: now,
    };
    this.artifacts.set(artifact.id, artifact);
    this.revisions.set(artifact.id, [{ artifactId: artifact.id, version: 1, content: artifact.content, author: input.author, createdAt: now }]);
    return artifact;
  }

  async mutate(input: any) {
    const current = await this.get(input.threadId, input.idOrName, true);
    if (!current) throw new Error('not found');
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new Error(`Artifact version conflict: expected ${ input.expectedVersion }, current version is ${ current.version }.`);
    }
    const patch = input.mutate({ ...current });
    const updated = { ...current, ...patch, version: current.version + 1, updatedAt: new Date().toISOString() };
    this.artifacts.set(updated.id, updated);
    this.revisions.get(updated.id)!.push({
      artifactId: updated.id, version: updated.version, content: updated.content,
      author: input.author, createdAt: updated.updatedAt,
    });
    return updated;
  }

  async history(threadId: string, idOrName: string) {
    const artifact = await this.get(threadId, idOrName, true);
    return artifact ? [...(this.revisions.get(artifact.id) ?? [])].reverse() : [];
  }

  async revision(threadId: string, idOrName: string, version: number) {
    const artifact = await this.get(threadId, idOrName, true);
    return artifact ? this.revisions.get(artifact.id)?.find(r => r.version === version) ?? null : null;
  }
}

describe('ChatArtifactService', () => {
  let store: MemoryStore;
  let service: InstanceType<typeof ChatArtifactService>;

  beforeEach(() => {
    store = new MemoryStore();
    service = new ChatArtifactService(store as any);
  });

  test('creates once and deduplicates subsequent creates by case-insensitive name', async() => {
    const first = await service.create('thread-1', { name: 'Plan', content: '- [ ] first' });
    const second = await service.create('thread-1', { name: 'plan', content: '- [x] first' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.artifact.id).toBe(first.artifact.id);
    expect(second.artifact.content).toBe('- [x] first');
    expect(await service.list('thread-1')).toHaveLength(1);
  });

  test('rejects an exact edit unless every find matches once and saves nothing', async() => {
    const { artifact } = await service.create('thread-1', { name: 'Plan', content: 'same same' });

    await expect(service.edit('thread-1', artifact.id, [{ find: 'same', replace: 'done' }], 1))
      .rejects.toThrow('matched 2 time(s)');
    expect((await service.get('thread-1', artifact.id)).content).toBe('same same');
    expect(await service.history('thread-1', artifact.id)).toHaveLength(1);
  });

  test('rejects stale expectedVersion writes', async() => {
    const { artifact } = await service.create('thread-1', { name: 'Plan', content: 'v1' });
    await service.update('thread-1', artifact.id, { content: 'v2', expectedVersion: 1 });

    await expect(service.update('thread-1', artifact.id, { content: 'stale', expectedVersion: 1 }))
      .rejects.toThrow('version conflict');
  });

  test('writes a revision for every content and visibility change', async() => {
    const { artifact } = await service.create('thread-1', { name: 'Plan', content: 'v1' });
    await service.append('thread-1', artifact.id, '\nv2', 1);
    await service.close('thread-1', artifact.id, 2);
    await service.reopen('thread-1', artifact.id, 3);

    const history = await service.history('thread-1', artifact.id);
    expect(history.map(item => item.version)).toEqual([4, 3, 2, 1]);
    expect(history.every(item => item.author === 'agent')).toBe(true);
  });

  test('close hides an artifact and reopen restores it', async() => {
    const { artifact } = await service.create('thread-1', { name: 'Plan', content: 'body' });
    await service.close('thread-1', artifact.id);
    expect(await service.list('thread-1')).toEqual([]);
    expect(await service.list('thread-1', true)).toHaveLength(1);

    const reopened = await service.reopen('thread-1', artifact.id);
    expect(reopened.isOpen).toBe(true);
  });

  test('revert restores old content as a new revision', async() => {
    const { artifact } = await service.create('thread-1', { name: 'Plan', content: 'original' });
    const changed = await service.update('thread-1', artifact.id, { content: 'changed', expectedVersion: 1 });
    const reverted = await service.revert('thread-1', artifact.id, 1, changed.version);

    expect(reverted.content).toBe('original');
    expect(reverted.version).toBe(3);
    expect((await service.history('thread-1', artifact.id))[0]).toMatchObject({ version: 3, content: 'original' });
  });
});
