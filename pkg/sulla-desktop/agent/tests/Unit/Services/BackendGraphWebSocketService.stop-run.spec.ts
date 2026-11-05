// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../tools/agents/jobRegistry', async() => {
  const actual = await vi.importActual<typeof import('../../../tools/agents/jobRegistry')>('../../../tools/agents/jobRegistry');
  return {
    ...actual,
    getJobsForParentThread: vi.fn(async() => [{ jobId: 'child-job', status: 'running' }]),
    abortJob: vi.fn(),
  };
});

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

describe('BackendGraphWebSocketService stop_run scope', () => {
  it('aborts only the parent thread run and does not stop delegated jobs', async() => {
    // risk: lifecycle — stopping a chat must not cascade into delegated workers.
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const { abortJob } = await import('../../../tools/agents/jobRegistry');
    const parentAbort = new AbortController();
    const service = Object.create(BackendGraphWebSocketService.prototype) as any;
    service.activeAborts = new Map([['desktop|parent-thread', { abort: () => parentAbort.abort() }]]);

    await service.handleChannelMessage('desktop', 'sulla-desktop', { type: 'stop_run', data: { threadId: 'parent-thread' } });

    expect(parentAbort.signal.aborted).toBe(true);
    expect(abortJob).not.toHaveBeenCalled();
  });
});
