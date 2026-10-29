// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';
import { FilesShareInChatWorker } from './share_in_chat';

describe('FilesShareInChatWorker', () => {
  it('uses trusted execution scope and ignores request-body ownership', async () => {
    const worker: any = new FilesShareInChatWorker();
    worker.executionContext = { sub: 'session-user', org_id: 'session-org', agent_id: 'agent' };
    const request = vi.spyOn(worker, 'containerJson').mockImplementation(async (_path: string, input: any) => {
      expect(worker.context(input)).toMatchObject({ sub: 'session-user', org_id: 'session-org' });
      expect(worker.context(input)).not.toMatchObject({ sub: input.owner_id, org_id: input.org_id });
      return { id: 'file_123', path: 'Projects/Roadmap.md', name: 'Roadmap.md', version_id: 'v9' };
    });
    const result = await worker._validatedCall({ file_id: 'file_123', owner_id: 'attacker', org_id: 'other-org' });
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(result.responseString).chatLink).toBe('sulla-file://file_123?version=v9&name=Roadmap.md&path=Projects%2FRoadmap.md');
  });
});
