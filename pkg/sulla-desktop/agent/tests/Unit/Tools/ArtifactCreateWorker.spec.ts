// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { ArtifactCreateWorker } from '../../../tools/chat/artifact_create';

const create = vi.hoisted(() => vi.fn());
vi.mock('../../../services/ChatArtifactService', () => ({ getChatArtifactService: () => ({ create }) }));

describe('ArtifactCreateWorker', () => {
  it('preserves the Files reference text and exposes created versus updated metadata', async() => {
    // risk: data correctness — callers must not report an update as a newly created artifact.
    const worker = new ArtifactCreateWorker() as any;
    worker.state = { metadata: { threadId: 'thread-1' } };
    const artifact = { id: 'artifact-1', name: 'Plan', kind: 'document', status: 'open', version: 2, content: 'body', filesRegistrationStatus: 'synced', filesFileId: 'file-1', filesVersionId: 'version-1', filesPath: 'Plan.md' };
    create.mockResolvedValueOnce({ artifact, created: true }).mockResolvedValueOnce({ artifact, created: false });

    const newlyCreated = await worker.call({ name: 'Plan', kind: 'document', content: 'body' });
    const updated = await worker.call({ name: 'Plan', kind: 'document', content: 'body' });

    expect(newlyCreated.result).toContain('inlineReference: sulla-file://file-1?version=version-1');
    expect(newlyCreated.result).toContain('Created artifact: Plan');
    expect(newlyCreated.artifact).toMatchObject({ record: artifact, created: true, updated: false });
    expect(updated.result).toContain('inlineReference: sulla-file://file-1?version=version-1');
    expect(updated.artifact).toMatchObject({ record: artifact, created: false, updated: true });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
