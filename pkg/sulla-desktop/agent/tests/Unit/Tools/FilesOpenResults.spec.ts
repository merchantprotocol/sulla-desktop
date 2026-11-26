// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  containerRequest: vi.fn(),
  activeWindow: undefined as any,
  replyListener: undefined as any,
}));

vi.mock('../../../files/containerClient', () => ({ filesContainerRequest: harness.containerRequest }));
vi.mock('electron', () => ({
  ipcMain: {
    once: vi.fn((_channel: string, listener: typeof harness.replyListener) => { harness.replyListener = listener; }),
    removeAllListeners: vi.fn(),
  },
}));
vi.mock('@pkg/window/agentWindows', () => ({ getActiveAgentWindow: () => harness.activeWindow }));
vi.mock('@pkg/window/agentWindowTrust', () => ({ agentWindowFromSender: () => null }));

import { FilesOpenWorker } from '../../../tools/files/open';
import { filesToolManifests } from '../../../tools/files/manifests';
import { toolDecisionPort, UnavailableToolDecisionPort } from '../../../tools/toolDecisionPort';
import { RecentFileOpenRegistry } from '../../../tools/files/RecentFileOpenRegistry';
import type { ToolResponse } from '../../../tools/base';
import type { RecentFileOpenCoordinator } from '../../../tools/files/RecentFileOpenRegistry';

class UncachedRecentFileOpenRegistry implements RecentFileOpenCoordinator {
  openOnce(_key:string, open:() => Promise<ToolResponse>):Promise<ToolResponse> { return open(); }
}

const openManifest = filesToolManifests.find(manifest => manifest.name === 'open')!;
const fileResponse = { file: { id: 'file-1', collection_id: 'collection-1', path: 'Projects/example/file.md' } };
const resolvedFile = { collectionId: 'collection-1', fileId: 'file-1', folderPath: 'Projects/example', kind: 'file' };

function response(body: unknown) {
  return { status: 200, json: async() => body } as Response;
}

function worker(
  metadata: Record<string, unknown> = { threadId: 'thread-1', desktopChatVisible: true },
  recentOpenRegistry:RecentFileOpenCoordinator = new UncachedRecentFileOpenRegistry(),
) {
  const instance = new FilesOpenWorker(undefined, undefined, undefined, recentOpenRegistry);
  instance.schemaDef = openManifest.schemaDef;
  instance.name = openManifest.name;
  instance.metadata.category = 'files';
  instance.metadata.operationTypes = ['read'];
  instance.sendChatMessage = vi.fn(async() => true);
  const state = { metadata } as any;
  return { instance, state, invoke: (input: unknown) => instance.invoke(input, state) };
}

function installFileManagerWindow(opened = true) {
  const webContents:any = {
    isLoading: () => false,
    once: vi.fn(),
    send: vi.fn((_channel: string, payload: any) => {
      queueMicrotask(() => harness.replyListener?.({ sender: webContents }, {
        opened, tabId: 'files-tab-1', path: payload.path, how: 'file-manager-viewer',
      }));
    }),
  };
  harness.activeWindow = { webContents, focus: vi.fn() };
  return harness.activeWindow;
}

describe('files/open clear results', () => {
  beforeEach(() => {
    toolDecisionPort.register({ requiresApproval: async() => false, request: async() => { throw new Error('not expected in this test') } });
    harness.containerRequest.mockReset();
    harness.replyListener = undefined;
    harness.activeWindow = undefined;
    harness.containerRequest.mockImplementation(async(path: string) => {
      if (path.startsWith('/v1/files/resolve?')) return response(resolvedFile);
      if (path.startsWith('/v1/agent-files/')) return response(fileResponse);
      throw new Error(`Unexpected Files endpoint: ${ path }`);
    });
  });

  afterEach(() => toolDecisionPort.register(new UnavailableToolDecisionPort()));

  it('uses the real default route to post one inline card for a visible chat, including file_id lookup', async() => {
    // risk: file access — an id lookup must resolve to and disclose only the requested file in the originating visible chat.
    const call = worker();
    const result = await call.invoke({ file_id: 'file-1' });

    expect(result.success).toBe(true);
    expect(JSON.parse(result.result as string)).toMatchObject({ opened: true, placement: 'inline', fileId: 'file-1', path: 'Projects/example/file.md' });
    expect(harness.containerRequest).toHaveBeenCalledWith('/v1/agent-files/file-1', expect.anything(), expect.anything());
    expect(call.instance.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(harness.activeWindow).toBeUndefined();
  });

  it('sends placement tab to the Files tab and returns its acknowledgement', async() => {
    // risk: UI routing — explicit tab placement must open the Files item instead of emitting an inline card.
    const activeWindow = installFileManagerWindow();
    const call = worker();
    const result = await call.invoke({ path: 'Projects/example/file.md', placement: 'tab' });

    expect(result.success).toBe(true);
    expect(JSON.parse(result.result as string)).toMatchObject({ opened: true, tabId: 'files-tab-1', how: 'file-manager-viewer' });
    expect(activeWindow.webContents.send).toHaveBeenCalledWith('agent-command', expect.objectContaining({ command: 'open-files-item', fileId: 'file-1' }));
    expect(call.instance.sendChatMessage).not.toHaveBeenCalled();
  });

  it('accepts an explicit /mnt/sulla-files path and resolves it under the Sulla Files root', async() => {
    const result = await worker().invoke({ path: '/mnt/sulla-files/Projects/example/file.md' });
    expect(result.success).toBe(true);
    expect(harness.containerRequest).toHaveBeenCalledWith(
      `/v1/files/resolve?path=${ encodeURIComponent('/mnt/sulla-files/Projects/example/file.md') }`, expect.anything(), expect.anything(),
    );
  });

  it('uses the documented Files-tab fallback without an inline card for a hidden sub-agent', async() => {
    // risk: privacy — hidden workers must never emit file content cards into an invisible or unrelated chat.
    const activeWindow = installFileManagerWindow();
    const call = worker({ threadId: 'hidden-thread', isSubAgent: true, desktopChatVisible: false });
    const result = await call.invoke({ path: 'Projects/example/file.md' });

    expect(result.success).toBe(true);
    expect(JSON.parse(result.result as string)).toMatchObject({
      opened: true,
      tabId: 'files-tab-1',
      reason: expect.stringMatching(/inline cards only appear in a visible Desktop chat/i),
    });
    expect(call.instance.sendChatMessage).not.toHaveBeenCalled();
    expect(activeWindow.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('returns an explicit no-visible-chat result when a hidden sub-agent has no Desktop window', async() => {
    // risk: reliability — hidden graph calls without a Desktop window must return a reason instead of waiting for UI acknowledgement.
    const call = worker({ threadId: 'hidden-thread', isSubAgent: true, desktopChatVisible: false });
    const result = await call.invoke({ path: 'Projects/example/file.md' });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.result as string)).toMatchObject({
      opened: false,
      reason: expect.stringMatching(/inline cards only show in a visible Desktop chat; this agent is hidden/i),
    });
    expect(call.instance.sendChatMessage).not.toHaveBeenCalled();
  });

  it('returns an explicit no-visible-chat result for a non-agent context without a Desktop window', async() => {
    const result = await worker({ threadId: 'api-thread', desktopChatVisible: false }).invoke({ path: 'Projects/example/file.md' });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.result as string)).toMatchObject({ opened: false, reason: expect.stringMatching(/no Files tab is available for this call/i) });
  });

  it('does not cache a no-window fallback as if the file had opened', async() => {
    const call = worker({ threadId: 'api-thread', desktopChatVisible: false }, new RecentFileOpenRegistry());
    const first = await call.invoke({ path: 'Projects/example/file.md' });
    expect(JSON.parse(first.result as string).opened).toBe(false);
    const activeWindow = installFileManagerWindow();
    const second = await call.invoke({ path: 'Projects/example/file.md' });
    expect(second.success).toBe(true);
    expect(activeWindow.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('rejects explicit inline placement for a hidden caller with a clear reason', async() => {
    // risk: privacy — an explicit inline request from a hidden graph must fail closed rather than route into another visible chat.
    const result = await worker({ threadId: 'hidden-thread', isSubAgent: true, desktopChatVisible: false })
      .invoke({ path: 'Projects/example/file.md', placement: 'inline' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/visible Desktop chat.*sub-agent/i);
    expect(harness.activeWindow).toBeUndefined();
  });

  it.each([
    ['missing path or id', {}, /path or file_id is required/],
    ['dot traversal', { path: '../private.txt' }, /inside Sulla Files/],
    ['absolute traversal', { path: '/etc/passwd' }, /absolute paths outside Sulla Files are not allowed/],
    ['Windows absolute traversal', { path: 'C:\\Users\\private.txt' }, /absolute paths outside Sulla Files are not allowed/],
  ])('returns a specific error for %s before any open dispatch', async(_label, input, error) => {
    installFileManagerWindow();
    const result = await worker().invoke(input);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(error);
    expect(harness.containerRequest).not.toHaveBeenCalled();
    expect(harness.activeWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('returns enum validation errors as tool results instead of leaking a rejected call', async() => {
    const result = await worker().invoke({ path: 'Projects/example/file.md', placement: 'panel' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid value for placement/);
    expect(harness.containerRequest).not.toHaveBeenCalled();
  });

  it.each([undefined, 'tab'] as const)('opens a folder path in the Files tab when placement is %s', async(placement) => {
    // risk: navigation — folder paths must retain their legacy Files-tab behavior rather than erroring as non-files.
    harness.containerRequest.mockImplementationOnce(async() => response({
      collectionId: 'collection-1', folderPath: 'Projects/example', kind: 'folder',
    }));
    const activeWindow = installFileManagerWindow();
    const result = await worker().invoke({ path: 'Projects/example', ...(placement ? { placement } : {}) });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.result as string)).toMatchObject({ opened: true, path: 'Projects/example' });
    if (!placement) expect(JSON.parse(result.result as string).reason).toMatch(/folder was opened in the Files tab/i);
    expect(activeWindow.webContents.send).toHaveBeenCalledWith('agent-command', expect.objectContaining({
      command: 'open-files-item', kind: 'folder', path: 'Projects/example',
    }));
  });

  it('returns a file-specific inline error for a folder path', async() => {
    harness.containerRequest.mockImplementationOnce(async() => response({
      collectionId: 'collection-1', folderPath: 'Projects/example', kind: 'folder',
    }));
    installFileManagerWindow();
    const result = await worker().invoke({ path: 'Projects/example', placement: 'inline' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Inline cards are for files; that path is a folder. Open it with placement "tab" or use files/list.');
    expect(harness.activeWindow.webContents.send).not.toHaveBeenCalled();
  });

  it.each(['/mnt/sulla-files', '/mnt/sulla-files/', ''])('identifies the Sulla Files root path %s as a folder without a request', async(path) => {
    // risk: path traversal — root inputs must stop before Files lookup and never be mistaken for a file.
    const result = await worker().invoke({ path });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/is a folder.*files\/list/i);
    expect(harness.containerRequest).not.toHaveBeenCalled();
  });

  it('identifies the Sulla Files root as a folder even with inline placement', async() => {
    const result = await worker().invoke({ path: '/mnt/sulla-files/', placement: 'inline' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Inline cards are for files; that path is a folder. Open it with placement "tab" or use files/list.');
    expect(harness.containerRequest).not.toHaveBeenCalled();
  });

  it('turns a deleted path into a fast, specific Files-not-found result', async() => {
    // risk: reliability — deleted files should fail before the Desktop tab acknowledgement timer.
    harness.containerRequest.mockRejectedValueOnce(new Error('Files path not found'));
    const result = await worker().invoke({ path: 'Projects/missing.md' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('That Sulla Files path was not found');
    expect(harness.activeWindow).toBeUndefined();
  });

  it('turns an unknown file_id into a specific result without opening a tab', async() => {
    // risk: reliability — a stale id must not become an unhandled property-access error or a 10-second UI wait.
    harness.containerRequest.mockRejectedValueOnce(new Error('file not found'));
    const result = await worker().invoke({ file_id: 'deleted-id' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('That Sulla Files file_id was not found');
    expect(harness.activeWindow).toBeUndefined();
  });

  it.each(['AbortError', 'TimeoutError'])('maps the old Electron %s to a clear Files availability error', async(name) => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name });
    harness.containerRequest.mockRejectedValueOnce(timeout);
    const result = await worker().invoke({ path: 'Projects/example/file.md' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Sulla Files is unreachable right now. Please try again in a moment.');
  });

  it('passes the Files transport recovery message through unchanged', async() => {
    const message = 'Sulla Files transport is unavailable; reconnecting the local service.';
    harness.containerRequest.mockRejectedValueOnce(new Error(message));
    const result = await worker().invoke({ path: 'Projects/example/file.md' });
    expect(result.success).toBe(false);
    expect(result.error).toBe(message);
  });

  it('deduplicates across separately constructed workers for 1.5 seconds, then allows a new card', async() => {
    // risk: UI idempotency — ToolRegistry creates one worker per call, so the shared main-process registry must suppress real retries.
    let now = 0;
    const registry = new RecentFileOpenRegistry(() => now);
    const firstWorker = worker(undefined, registry);
    const secondWorker = worker(undefined, registry);
    const first = await firstWorker.invoke({ path: 'Projects/example/file.md' });
    const second = await secondWorker.invoke({ path: 'Projects/example/file.md' });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(firstWorker.instance.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(secondWorker.instance.sendChatMessage).not.toHaveBeenCalled();

    now = 1_499;
    await worker(undefined, registry).invoke({ path: 'Projects/example/file.md' });
    expect(firstWorker.instance.sendChatMessage).toHaveBeenCalledTimes(1);
    now = 1_500;
    const afterWindow = worker(undefined, registry);
    await afterWindow.invoke({ path: 'Projects/example/file.md' });
    expect(afterWindow.instance.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a repeated tab open in the same thread for the short retry window', async() => {
    // risk: UI idempotency — retrying the same tab request must not create another Files tab.
    const activeWindow = installFileManagerWindow();
    const call = worker(undefined, new RecentFileOpenRegistry());
    await call.invoke({ path: 'Projects/example/file.md', placement: 'tab' });
    const second = await call.invoke({ path: 'Projects/example/file.md', placement: 'tab' });
    expect(second.success).toBe(true);
    expect(activeWindow.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('does not cache failed opens, and bounds and expires entries on access', async() => {
    // risk: UI idempotency — rejected opens must be retryable and stale file keys must not accumulate forever.
    let now = 0;
    const registry = new RecentFileOpenRegistry(() => now, 1_500, 2);
    const open = vi.fn(async() => ({ successBoolean: true, responseString: JSON.stringify({ opened: true }) }));
    await registry.openOnce('a', open);
    await registry.openOnce('b', open);
    await registry.openOnce('c', open);
    await registry.openOnce('a', open);
    expect(open).toHaveBeenCalledTimes(4);

    now = 1_500;
    await registry.openOnce('d', open);
    await registry.openOnce('b', open);
    expect(open).toHaveBeenCalledTimes(6);

    const failedOpen = vi.fn()
      .mockRejectedValueOnce(new Error('open failed'))
      .mockResolvedValue({ successBoolean: true, responseString: '{"opened":true}' });
    await expect(registry.openOnce('failed', failedOpen)).rejects.toThrow('open failed');
    await expect(registry.openOnce('failed', failedOpen)).resolves.toMatchObject({ successBoolean: true });
    expect(failedOpen).toHaveBeenCalledTimes(2);
  });
});
