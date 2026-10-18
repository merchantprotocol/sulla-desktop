import { beforeAll, describe, expect, it, jest } from '@jest/globals';

const electron = { webContents: { getAllWebContents: () => [] } };
jest.unstable_mockModule('electron', () => ({ __esModule: true, default: electron, ...electron }));
jest.unstable_mockModule('../../database/models/ChatArtifactModel', () => ({ ChatArtifactModel: {} }));

import type { ChatArtifactRecord } from '@pkg/shared/chatArtifacts';

let ChatArtifactService: typeof import('../ChatArtifactService').ChatArtifactService;

function artifact(version: number, content: string): ChatArtifactRecord {
  return {
    id: 'artifact-1', threadId: 'thread-1', name: 'notes', kind: 'markdown', content,
    status: 'working', isOpen: true, isDeleted: false, version, language: null, path: null,
    filesFileId: null, filesVersionId: null, filesCollectionId: null, filesPath: null,
    filesArtifactVersion: null, filesRegistrationStatus: 'pending', filesRegistrationError: null,
    filesRegistrationAttempts: 0, filesRegistrationUpdatedAt: null,
    createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z',
  };
}

describe('ChatArtifactService Files registration ordering', () => {
  beforeAll(async() => {
    ({ ChatArtifactService } = await import('../ChatArtifactService'));
  });

  it('never writes a superseded queued artifact snapshot', async() => {
    const first = artifact(1, 'old');
    let current = first;
    const registered: ChatArtifactRecord[] = [];
    const store: any = {
      get: jest.fn(async() => current),
      recordFilesRegistration: jest.fn(async(_id: string, version: number, result: any) => {
        current = {
          ...current,
          filesFileId: result.fileId,
          filesVersionId: result.versionId,
          filesCollectionId: result.collectionId,
          filesPath: result.path,
          filesArtifactVersion: version,
          filesRegistrationStatus: 'synced',
        };
        return current;
      }),
    };
    const registration = {
      register: jest.fn(async(record: ChatArtifactRecord) => {
        registered.push(record);
        return { fileId: 'file-1', versionId: `file-version-${ record.version }`, collectionId: 'collection-1', path: 'artifact.md' };
      }),
    };
    const service = new ChatArtifactService(store, null, registration);
    const sync = (record: ChatArtifactRecord) => (service as any).syncFiles(record) as Promise<ChatArtifactRecord>;
    const staleWrite = sync(first);

    current = artifact(2, 'new');
    const currentWrite = sync(current);
    await Promise.all([staleWrite, currentWrite]);

    expect(registered.map(record => [record.version, record.content])).toEqual([[2, 'new']]);
    expect(current.filesArtifactVersion).toBe(2);
    expect(current.filesVersionId).toBe('file-version-2');
  });
});
