// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  listener: undefined as any,
  message: undefined as any,
  window: undefined as any,
}));

vi.mock('electron', () => ({
  ipcMain: {
    once: vi.fn((_channel: string, listener: typeof state.listener) => { state.listener = listener; }),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}));

vi.mock('@pkg/window', () => ({ getWindow: () => state.window }));
vi.mock('@pkg/window/agentWindows', () => ({ getActiveAgentWindow: () => state.window }));
vi.mock('@pkg/window/agentWindowTrust', () => ({ agentWindowFromSender: () => null }));

import { FilesOpenWorker } from '../../../tools/files/open';
import type { ToolResponse } from '../../../tools/base';
import type { RecentFileOpenCoordinator } from '../../../tools/files/RecentFileOpenRegistry';
import { ChatFileOpenAction } from '@pkg/pages/chat/components/files/ChatFileOpenAction';
import { FilesBrowserOpenDecision } from '@pkg/pages/files/browser/FilesBrowserOpenDecision';
import { FilesBrowserNavigation } from '@pkg/pages/files/browser/FilesBrowserNavigation';
import { FileDetailPreviewRouter } from '@pkg/pages/files/FileDetailPreviewRouter';
import { FilesOpenDestinationRouter } from '@pkg/pages/files/FilesOpenDestinationRouter';
import { documentEditorTypeIdForPath } from '@pkg/pages/files/editor/editorTypes';

class UncachedRecentFileOpenRegistry implements RecentFileOpenCoordinator {
  openOnce(_key:string, open:() => Promise<ToolResponse>):Promise<ToolResponse> { return open(); }
}

class ResolvedFileOpenWorker extends FilesOpenWorker {
  protected override async resolvePath() {
    return { collectionId: 'collection-1', fileId: 'file-1', folderPath: 'Projects/sulla-desktop/qa-two-device/editor-repro', kind: 'file' as const };
  }
  constructor() { super(undefined, undefined, undefined, new UncachedRecentFileOpenRegistry()); }
  execute(input: unknown) { return this._validatedCall(input); }
}

describe('FilesOpenWorker', () => {
  beforeEach(() => {
    state.listener = undefined;
    state.message = undefined;
    const webContents: any = {
      isLoading: () => false,
      once: vi.fn(),
      send: vi.fn((_channel: string, message: typeof state.message) => {
        state.message = message;
        const how = new FilesOpenDestinationRouter().resolve(message?.path ?? '', message?.mode ?? 'edit').destination === 'document-editor'
          ? 'document-editor'
          : 'file-manager-viewer';
        queueMicrotask(() => state.listener?.({ sender: webContents }, { opened: true, tabId: 'tab-1', path: message?.path, how }));
      }),
    };
    state.window = { webContents, focus: vi.fn() };
  });

  it('opens a path-resolved file itself, not the parent folder returned alongside its id', async() => {
    // risk: file access — agent open must dispatch the selected document path so the editor opens the file rather than its parent directory.
    const response = await new ResolvedFileOpenWorker().execute({ path: '/mnt/sulla-files/Projects/sulla-desktop/qa-two-device/editor-repro/agent-repro.md' });

    expect(state.message).toMatchObject({
      command: 'open-files-item',
      fileId: 'file-1',
      collectionId: 'collection-1',
      path: 'Projects/sulla-desktop/qa-two-device/editor-repro/agent-repro.md',
      kind: 'file',
    });
    expect(response.successBoolean).toBe(true);
    expect(JSON.parse(response.responseString)).toMatchObject({ how: 'document-editor', path: 'Projects/sulla-desktop/qa-two-device/editor-repro/agent-repro.md' });
  });

  it('routes HTML and HTM tab opens to the full-page editor while retaining inline cards', async() => {
    // risk: file routing — visible-chat inline opens must retain the HTML card; explicit tab opens must use the editor.
    const destinationRouter = new FilesOpenDestinationRouter();
    const previewRouter = new FileDetailPreviewRouter();
    const browserRouter = new FilesBrowserOpenDecision(previewRouter, documentEditorTypeIdForPath);
    const chatOpen = {
      openHtmlInEditor: vi.fn(),
      openWithDefaultApp: vi.fn(async() => undefined),
    };
    const chatAction = new ChatFileOpenAction(destinationRouter, chatOpen);

    for (const path of ['index.html', 'index.htm']) {
      expect(browserRouter.resolve({ folder: false, path, mime: 'text/html' })).toBe('editor');
      expect(previewRouter.resolve(path, 'text/html')).toEqual({ kind: 'editor' });
      expect(destinationRouter.resolve(path, 'edit')).toEqual({ destination: 'document-editor', mode: 'edit' });
      expect(destinationRouter.resolve(path, 'view')).toEqual({ destination: 'document-editor', mode: 'edit' });

      for (const mode of [undefined, 'edit', 'view'] as const) {
        for (const placement of [undefined, 'inline', 'tab'] as const) {
          const worker = new ResolvedFileOpenWorker();
          worker.setState({ metadata: { threadId: 'thread-1', desktopChatVisible: true } } as any);
          worker.sendChatMessage = vi.fn(async() => true);
          const response = await worker.execute({
            path: `/mnt/sulla-files/Projects/sulla-desktop/qa-two-device/editor-repro/${ path }`,
            ...(mode ? { mode } : {}), ...(placement ? { placement } : {}),
          });

          if (placement === 'tab') {
            expect(state.message).toMatchObject({ command: 'open-files-item', mode: 'edit', path: expect.stringMatching(/\.html?$/) });
            expect(JSON.parse(response.responseString)).toMatchObject({ opened: true, how: 'document-editor' });
            expect(worker.sendChatMessage).not.toHaveBeenCalled();
          }
          else {
            expect(JSON.parse(response.responseString)).toMatchObject({ opened: true, placement: 'inline', path: expect.stringMatching(/\.html?$/) });
            expect(worker.sendChatMessage).toHaveBeenCalledTimes(1);
          }
        }
      }

      await chatAction.open({ fileId: 'html-file', path, collectionId: 'collection-1', versionId: 'version-1' });
    }

    const viewerWorker = new ResolvedFileOpenWorker();
    viewerWorker.setState({ metadata: { threadId: 'thread-1', desktopChatVisible: true } } as any);
    const viewerResponse = await viewerWorker.execute({
      path: '/mnt/sulla-files/Projects/sulla-desktop/qa-two-device/editor-repro/agent-repro.md', mode: 'view', placement: 'tab',
    });
    expect(state.message).toMatchObject({ command: 'open-files-item', mode: 'view' });
    expect(JSON.parse(viewerResponse.responseString)).toMatchObject({ opened: true, how: 'file-manager-viewer' });

    expect(chatOpen.openHtmlInEditor).toHaveBeenCalledTimes(2);
    expect(chatOpen.openWithDefaultApp).not.toHaveBeenCalled();
    await chatAction.open({ fileId: 'text-file', path: 'notes.md', collectionId: 'collection-1', versionId: 'version-2' });
    expect(chatOpen.openWithDefaultApp).toHaveBeenCalledWith({ fileId: 'text-file', versionId: 'version-2' });
    expect(destinationRouter.resolve('notes.md', 'view')).toEqual({ destination: 'file-manager', mode: 'view' });

    const htmlEntry = { id: 'html-file', key: 'html-file', name: 'page.html', path: 'page.html', mime: 'text/html', folder: false, currentVersionId: 'version-1' } as any;
    const source = { openFile: vi.fn() };
    const browserState = {
      busy: { value: false }, loading: { value: false }, selected: { value: htmlEntry }, detailVersion: { value: { id: 'old-version' } },
      navigationError: { value: '' }, snapshot: { value: { collection: { id: 'collection-1' } } },
      props: { dataSource: source }, emit: vi.fn(),
    };
    const browser:any = {
      state: browserState,
      menus: { actionTarget: { value: htmlEntry }, closeActions: vi.fn() },
      openDecision: { resolve: vi.fn(() => 'editor') },
    };
    const browserNavigation = new FilesBrowserNavigation(browser);
    browser.navigation = browserNavigation;
    await browserNavigation.openDetail();
    expect(browserState.emit).toHaveBeenCalledWith('open-editor', htmlEntry, 'collection-1');
    expect(source.openFile).not.toHaveBeenCalled();
  });
});
