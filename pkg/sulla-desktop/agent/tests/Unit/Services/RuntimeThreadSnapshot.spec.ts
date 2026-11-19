// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';

import { AbortService } from '../../../services/AbortService';

const snapshots = vi.hoisted(() => ({ save: vi.fn((state: any) => Promise.resolve(structuredClone(state))), durableSave: vi.fn(), available: vi.fn(() => Promise.resolve(false)), load: vi.fn() }));
vi.mock('../../../app/Providers/ThreadStateServiceProvider', () => ({ threadStateProvider: { repository: snapshots, redis: { save: snapshots.durableSave, available: snapshots.available, load: snapshots.load } } }));

describe('runtime snapshots', () => {
  it('persists a recovery checkpoint without cloning process-local abort callbacks or changing live cancellation', async() => {
    const { saveThreadState } = await import('../../../nodes/ThreadStateStore');
    const abort = new AbortService();
    const cancelled = vi.fn();
    abort.onAbort(cancelled);
    const state: any = { messages: [{ role: 'user', content: 'work' }], metadata: { threadId: 'one', runtimeTurn: { phase: 'executing' }, options: { abort } } };
    await saveThreadState(state);
    expect(snapshots.save.mock.calls[0][0]).toMatchObject({ metadata: { runtimeTurn: { phase: 'executing' }, options: { abort: undefined } } });
    expect(state.metadata.options.abort).toBe(abort);
    abort.abort();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
