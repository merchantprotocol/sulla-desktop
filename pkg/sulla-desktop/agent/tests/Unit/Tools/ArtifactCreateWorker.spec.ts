// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { ArtifactCreateWorker } from '../../../tools/chat/artifact_create';

const create = vi.hoisted(() => vi.fn());
vi.mock('../../../services/ChatArtifactService', () => ({ getChatArtifactService: () => ({ create }) }));

describe('ArtifactCreateWorker', () => {
  it('distinguishes a new artifact from a same-name update in its structured result', async() => {
    // risk: data correctness — callers must not report an update as a newly created artifact.
    const worker = new ArtifactCreateWorker() as any;
    worker.state = { metadata: { threadId: 'thread-1' } };
    const artifact = { id: 'artifact-1', name: 'Plan', kind: 'document', status: 'open', version: 2, content: 'body', filesRegistrationStatus: 'pending' };
    create.mockResolvedValueOnce({ artifact, created: true }).mockResolvedValueOnce({ artifact, created: false });

    const newlyCreated = await worker._validatedCall({ name: 'Plan', kind: 'document', content: 'body' });
    const updated = await worker._validatedCall({ name: 'Plan', kind: 'document', content: 'body' });

    expect(newlyCreated.result).toMatchObject({ artifact, created: true, updated: false });
    expect(updated.result).toMatchObject({ artifact, created: false, updated: true });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
