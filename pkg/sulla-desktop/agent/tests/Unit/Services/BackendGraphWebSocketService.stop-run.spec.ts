import { describe, expect, it, vi } from 'vitest';
import { JobAbortScope } from '../../../app/Services/JobAbortScope';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));

describe('BackendGraphWebSocketService stop_run scope', () => {
  it('aborts only the parent thread run and leaves async job task signals running', async() => {
    // risk: lifecycle — stopping a chat must not cascade into delegated workers.
    const { BackendGraphWebSocketService } = await import('../../../services/BackendGraphWebSocketService');
    const parentAbort = new AbortController();
    const taskOne = new JobAbortScope(); const taskTwo = new JobAbortScope();
    const taskOneSignal = taskOne.taskSignal(0); const taskTwoSignal = taskTwo.taskSignal(0);
    const service = Object.create(BackendGraphWebSocketService.prototype) as any;
    service.activeAborts = new Map([['desktop|parent-thread', { abort: () => parentAbort.abort() }]]);
    await service.handleChannelMessage('desktop', 'sulla-desktop', { type: 'stop_run', data: { threadId: 'parent-thread' } });
    expect(parentAbort.signal.aborted).toBe(true);
    expect(taskOneSignal.aborted).toBe(false);
    expect(taskTwoSignal.aborted).toBe(false);
  });
});
